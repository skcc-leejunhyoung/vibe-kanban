use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use json_patch::{AddOperation, Patch, PatchOperation, RemoveOperation, ReplaceOperation};
use serde::{Deserialize, Serialize};
use serde_json::{json, to_value};
use ts_rs::TS;
use workspace_utils::{diff::Diff, msg_store::MsgStore};

use crate::{
    executor_discovery::ExecutorDiscoveredOptions,
    executors::SlashCommandDescription,
    logs::{NormalizedEntry, utils::EntryIndexProvider},
};

#[allow(clippy::large_enum_variant)]
#[derive(Serialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE", tag = "type", content = "content")]
pub enum PatchType {
    NormalizedEntry(NormalizedEntry),
    Stdout(String),
    Stderr(String),
    Diff(Diff),
}

pub fn escape_json_pointer_segment(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

// Build operations directly instead of round-tripping through `json!` +
// `from_value`, which serialized and re-parsed every streamed entry.
fn add_op(path: &str, value: PatchType) -> Patch {
    Patch(vec![PatchOperation::Add(AddOperation {
        path: path.parse().expect("valid JSON pointer"),
        value: to_value(value).expect("patch value serializes"),
    })])
}

fn replace_op(path: &str, value: PatchType) -> Patch {
    Patch(vec![PatchOperation::Replace(ReplaceOperation {
        path: path.parse().expect("valid JSON pointer"),
        value: to_value(value).expect("patch value serializes"),
    })])
}

fn remove_op(path: &str) -> Patch {
    Patch(vec![PatchOperation::Remove(RemoveOperation {
        path: path.parse().expect("valid JSON pointer"),
    })])
}

/// Helper functions to create JSON patches for conversation entries
pub struct ConversationPatch;

impl ConversationPatch {
    /// Create an ADD patch for a new conversation entry at the given index
    pub fn add_normalized_entry(entry_index: usize, entry: NormalizedEntry) -> Patch {
        add_op(
            &format!("/entries/{entry_index}"),
            PatchType::NormalizedEntry(entry),
        )
    }

    /// Create an ADD patch for a new string at the given index
    pub fn add_stdout(entry_index: usize, entry: String) -> Patch {
        add_op(&format!("/entries/{entry_index}"), PatchType::Stdout(entry))
    }

    /// Create an ADD patch for a new string at the given index
    pub fn add_stderr(entry_index: usize, entry: String) -> Patch {
        add_op(&format!("/entries/{entry_index}"), PatchType::Stderr(entry))
    }

    /// Create a REMOVE patch for removing a diff.
    pub fn remove_diff(entry_index: String) -> Patch {
        remove_op(&format!("/entries/{entry_index}"))
    }

    /// Add a diff entry under a repo namespace: `/entries/<repo>/<file>`
    pub fn add_repo_diff(repo_key: &str, file_path: &str, diff: Diff) -> Patch {
        add_op(
            &format!(
                "/entries/{}/{}",
                escape_json_pointer_segment(repo_key),
                escape_json_pointer_segment(file_path)
            ),
            PatchType::Diff(diff),
        )
    }

    /// Remove a diff entry under a repo namespace: `/entries/<repo>/<file>`
    pub fn remove_repo_diff(repo_key: &str, file_path: &str) -> Patch {
        remove_op(&format!(
            "/entries/{}/{}",
            escape_json_pointer_segment(repo_key),
            escape_json_pointer_segment(file_path)
        ))
    }

    /// Atomically replace all diffs for a repo. Single op, no intermediate empty state.
    pub fn replace_repo_diffs(repo_key: &str, diffs: HashMap<String, Diff>) -> Patch {
        let entries: HashMap<String, PatchType> = diffs
            .into_iter()
            .map(|(path, diff)| (path, PatchType::Diff(diff)))
            .collect();
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: format!("/entries/{}", escape_json_pointer_segment(repo_key))
                .parse()
                .expect("valid JSON pointer"),
            value: to_value(entries).expect("patch value serializes"),
        })])
    }

    /// Create a REPLACE patch for updating an existing conversation entry at the given index
    pub fn replace(entry_index: usize, entry: NormalizedEntry) -> Patch {
        replace_op(
            &format!("/entries/{entry_index}"),
            PatchType::NormalizedEntry(entry),
        )
    }

    pub fn remove(entry_index: usize) -> Patch {
        remove_op(&format!("/entries/{entry_index}"))
    }
}

/// Extract the entry index and `NormalizedEntry` from a JsonPatch if it contains one
pub fn extract_normalized_entry_from_patch(patch: &Patch) -> Option<(usize, NormalizedEntry)> {
    normalized_entry_values(patch)
        .rev()
        .find_map(|(index, value)| {
            NormalizedEntry::deserialize(value)
                .ok()
                .map(|entry| (index, entry))
        })
}

/// Inspect an existing operation value without serializing or cloning it.
pub fn patch_value(op: &json_patch::PatchOperation) -> Option<&serde_json::Value> {
    match op {
        json_patch::PatchOperation::Add(op) => Some(&op.value),
        json_patch::PatchOperation::Replace(op) => Some(&op.value),
        json_patch::PatchOperation::Test(op) => Some(&op.value),
        _ => None,
    }
}

fn normalized_entry_values(
    patch: &Patch,
) -> impl DoubleEndedIterator<Item = (usize, &serde_json::Value)> {
    patch.0.iter().filter_map(|op| {
        let index = op.path().as_str().strip_prefix("/entries/")?.parse().ok()?;
        let value = patch_value(op)?;
        (value.get("type")?.as_str()? == "NORMALIZED_ENTRY")
            .then(|| value.get("content").map(|content| (index, content)))?
    })
}

/// Where normalizers push conversation patches: the raw [`MsgStore`] or the
/// streaming-throttled wrapper around it.
pub trait PatchSink {
    fn push_patch(&self, patch: Patch);
}

impl PatchSink for MsgStore {
    fn push_patch(&self, patch: Patch) {
        MsgStore::push_patch(self, patch);
    }
}

impl<T: PatchSink + ?Sized> PatchSink for Arc<T> {
    fn push_patch(&self, patch: Patch) {
        (**self).push_patch(patch);
    }
}

pub fn upsert_normalized_entry(
    msg_store: &impl PatchSink,
    index: usize,
    normalized_entry: NormalizedEntry,
    is_new: bool,
) {
    if is_new {
        msg_store.push_patch(ConversationPatch::add_normalized_entry(
            index,
            normalized_entry,
        ));
    } else {
        msg_store.push_patch(ConversationPatch::replace(index, normalized_entry));
    }
}

pub fn add_normalized_entry(
    msg_store: &impl PatchSink,
    index_provider: &EntryIndexProvider,
    normalized_entry: NormalizedEntry,
) -> usize {
    let index = index_provider.next();
    upsert_normalized_entry(msg_store, index, normalized_entry, true);
    index
}

pub fn replace_normalized_entry(
    msg_store: &impl PatchSink,
    index: usize,
    normalized_entry: NormalizedEntry,
) {
    upsert_normalized_entry(msg_store, index, normalized_entry, false);
}

/// Extract the path string from a Patch (assumes single-operation patches).
pub fn patch_entry_path(patch: &Patch) -> Option<String> {
    patch.0.first().map(|op| op.path().to_string())
}

pub fn is_add_or_replace(patch: &Patch) -> bool {
    use json_patch::PatchOperation::*;
    patch.0.iter().all(|op| matches!(op, Add(..) | Replace(..)))
}

// Use the "replace" op for sent paths and "add" for new paths
pub fn fix_patch_ops(mut patch: Patch, sent_paths: &mut HashSet<String>) -> Patch {
    for op in &mut patch.0 {
        let path_sent = sent_paths.contains(op.path().as_str());
        match op {
            json_patch::PatchOperation::Add(add) if path_sent => {
                *op = json_patch::PatchOperation::Replace(json_patch::ReplaceOperation {
                    path: add.path.clone(),
                    value: add.value.clone(),
                });
            }
            json_patch::PatchOperation::Replace(replace) if !path_sent => {
                *op = json_patch::PatchOperation::Add(json_patch::AddOperation {
                    path: replace.path.clone(),
                    value: replace.value.clone(),
                });
            }
            _ => {}
        };
        if !path_sent {
            sent_paths.insert(op.path().to_string());
        }
    }
    patch
}

pub fn executor_discovered_options(options: ExecutorDiscoveredOptions) -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options", "value": options},
    ]))
    .unwrap_or_default()
}

pub fn slash_commands(
    commands: Vec<SlashCommandDescription>,
    discovering: bool,
    error: Option<String>,
) -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/commands", "value": commands},
        {"op": "replace", "path": "/discovering", "value": discovering},
        {"op": "replace", "path": "/error", "value": error},
    ]))
    .unwrap_or_default()
}

pub fn update_models(models: Vec<crate::model_selector::ModelInfo>) -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options/model_selector/models", "value": models},
    ]))
    .unwrap_or_default()
}

pub fn models_loaded() -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options/loading_models", "value": false},
    ]))
    .unwrap_or_default()
}

pub fn update_agents(agents: Vec<crate::model_selector::AgentInfo>) -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options/model_selector/agents", "value": agents},
    ]))
    .unwrap_or_default()
}

pub fn agents_loaded() -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options/loading_agents", "value": false},
    ]))
    .unwrap_or_default()
}

pub fn update_slash_commands(
    slash_commands: Vec<crate::executors::SlashCommandDescription>,
) -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options/slash_commands", "value": slash_commands},
    ]))
    .unwrap_or_default()
}

pub fn slash_commands_loaded() -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options/loading_slash_commands", "value": false},
    ]))
    .unwrap_or_default()
}

pub fn update_providers(providers: Vec<crate::model_selector::ModelProvider>) -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options/model_selector/providers", "value": providers},
    ]))
    .unwrap_or_default()
}

pub fn update_default_model(default_model: Option<String>) -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options/model_selector/default_model", "value": default_model},
    ]))
    .unwrap_or_default()
}

pub fn discovery_error(error: String) -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options/error", "value": error},
        {"op": "replace", "path": "/options/loading_models", "value": false},
        {"op": "replace", "path": "/options/loading_agents", "value": false},
        {"op": "replace", "path": "/options/loading_slash_commands", "value": false},
    ]))
    .unwrap_or_default()
}
