//! Registered, non-sensitive artifact input. Receipts prevent replay; drafts
//! stay in the browser's memory. A restart never re-dispatches a receipt.
use std::{collections::BTreeMap, path::PathBuf, sync::LazyLock};

use anyhow::{Result, bail, ensure};
use chrono::{DateTime, Utc};
use executors::logs::artifacts::ArtifactBundle;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use ts_rs::TS;
use uuid::Uuid;

use super::artifacts;

pub const MAX_RESPONSE_BYTES: usize = 32 * 1024;
pub static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub static BOOT_ID: LazyLock<Uuid> = LazyLock::new(Uuid::new_v4);

/// A bounded JSON Schema subset. Unknown keywords are rejected, not ignored.
/// Objects are closed: only registered properties can be submitted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ArtifactInputSchema {
    Object {
        properties: BTreeMap<String, ArtifactInputSchema>,
        #[serde(default)]
        required: Vec<String>,
    },
    String {
        #[serde(default, rename = "enum")]
        choices: Option<Vec<String>>,
        #[serde(default = "default_length", rename = "maxLength")]
        max_length: usize,
    },
    Number {
        #[serde(default)]
        #[ts(type = "number | null")]
        minimum: Option<serde_json::Number>,
        #[serde(default)]
        #[ts(type = "number | null")]
        maximum: Option<serde_json::Number>,
    },
    Boolean,
    Array {
        items: Box<ArtifactInputSchema>,
        #[serde(default = "default_items", rename = "maxItems")]
        max_items: usize,
    },
}

fn default_length() -> usize {
    4000
}
fn default_items() -> usize {
    100
}

impl ArtifactInputSchema {
    pub fn check(&self, depth: usize) -> Result<()> {
        ensure!(depth <= 8, "Input schema is too deeply nested");
        match self {
            Self::Object {
                properties,
                required,
            } => {
                ensure!(properties.len() <= 64, "Too many input fields");
                ensure!(
                    required.iter().all(|key| properties.contains_key(key)),
                    "Unknown required field"
                );
                for (name, schema) in properties {
                    ensure!(
                        !name.is_empty()
                            && name.len() <= 80
                            && !["__proto__", "constructor", "prototype"].contains(&name.as_str()),
                        "Invalid input field name"
                    );
                    ensure!(
                        ![
                            "password",
                            "passwd",
                            "secret",
                            "credential",
                            "access_token",
                            "api_key"
                        ]
                        .contains(&name.to_ascii_lowercase().as_str()),
                        "Sensitive input is not supported"
                    );
                    schema.check(depth + 1)?;
                }
            }
            Self::String {
                max_length,
                choices,
            } => {
                ensure!(*max_length <= 16_000, "String limit is too large");
                if let Some(choices) = choices {
                    ensure!(
                        !choices.is_empty()
                            && choices.len() <= 100
                            && choices.iter().all(|s| s.chars().count() <= *max_length),
                        "Invalid input choices"
                    );
                }
            }
            Self::Number { minimum, maximum } => {
                ensure!(
                    minimum
                        .as_ref()
                        .is_none_or(|n| n.as_f64().is_some_and(f64::is_finite))
                        && maximum
                            .as_ref()
                            .is_none_or(|n| n.as_f64().is_some_and(f64::is_finite)),
                    "Invalid numeric bound"
                );
                ensure!(
                    !matches!((minimum.as_ref().and_then(|n| n.as_f64()), maximum.as_ref().and_then(|n| n.as_f64())), (Some(a), Some(b)) if a > b),
                    "Invalid numeric range"
                );
            }
            Self::Array { items, max_items } => {
                ensure!(*max_items <= 200, "Array limit is too large");
                items.check(depth + 1)?;
            }
            Self::Boolean => {}
        }
        Ok(())
    }

    pub fn validate(&self, value: &Value, path: &str) -> Result<()> {
        let valid = match self {
            Self::Object {
                properties,
                required,
            } => {
                let Some(object) = value.as_object() else {
                    bail!("{path}: expected an object")
                };
                ensure!(
                    object.keys().all(|key| properties.contains_key(key)),
                    "{path}: unregistered field"
                );
                for name in required {
                    ensure!(object.contains_key(name), "{path}.{name}: required field");
                }
                for (key, value) in object {
                    properties[key].validate(value, &format!("{path}.{key}"))?;
                }
                true
            }
            Self::String {
                choices,
                max_length,
            } => value.as_str().is_some_and(|s| {
                s.chars().count() <= *max_length
                    && choices.as_ref().is_none_or(|c| c.iter().any(|v| v == s))
            }),
            Self::Number { minimum, maximum } => value.as_f64().is_some_and(|n| {
                n.is_finite()
                    && minimum
                        .as_ref()
                        .is_none_or(|min| min.as_f64().is_some_and(|min| n >= min))
                    && maximum
                        .as_ref()
                        .is_none_or(|max| max.as_f64().is_some_and(|max| n <= max))
            }),
            Self::Boolean => value.is_boolean(),
            Self::Array { items, max_items } => {
                let Some(array) = value.as_array() else {
                    bail!("{path}: expected an array")
                };
                ensure!(array.len() <= *max_items, "{path}: too many items");
                for (index, value) in array.iter().enumerate() {
                    items.validate(value, &format!("{path}[{index}]"))?;
                }
                true
            }
        };
        ensure!(
            valid,
            "{path}: value does not match the registered input schema"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactDelivery {
    FollowUp,
    Wait,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactInteractionState {
    InputRequired,
    Accepted,
    Processing,
    Completed,
    Failed,
    Cancelled,
    Expired,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct ArtifactInteractionRef {
    pub session_id: Uuid,
    pub execution_id: Uuid,
    pub request_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ArtifactInteraction {
    pub reference: ArtifactInteractionRef,
    pub workspace_id: Uuid,
    /// Installation identity; remote callers must also be the authenticated host owner.
    pub owner_host: String,
    pub owner_id: String,
    pub artifact_id: String,
    pub artifact_hash: String,
    /// Covers the HTML and every bundled dependency, not just the HTML hash.
    pub version: String,
    pub schema: ArtifactInputSchema,
    pub delivery: ArtifactDelivery,
    pub state: ArtifactInteractionState,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub result_process_id: Option<Uuid>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum ArtifactResponse {
    Submit {
        #[ts(type = "unknown")]
        data: Value,
    },
    Cancel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub interaction: ArtifactInteraction,
    pub boot_id: Uuid,
    pub response: Option<ArtifactResponse>,
}

pub fn bundle_version(bundle: &ArtifactBundle) -> Result<String> {
    let resources: BTreeMap<_, _> = bundle
        .resources
        .iter()
        .map(|r| (&r.path, (&r.mime, &r.content_hash)))
        .collect();
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            &bundle.artifact.content_hash,
            &bundle.base_path,
            resources
        ))?)
    ))
}

impl Receipt {
    pub fn check_scope(
        &self,
        workspace: Uuid,
        session: Uuid,
        execution: Uuid,
        owner_host: &str,
        owner_id: &str,
    ) -> Result<()> {
        let i = &self.interaction;
        ensure!(
            i.workspace_id == workspace
                && i.reference.session_id == session
                && i.reference.execution_id == execution
                && i.owner_host == owner_host
                && i.owner_id == owner_id,
            "Artifact request scope does not match"
        );
        Ok(())
    }

    /// Returns false for an exact replay. Persist a true claim BEFORE dispatch.
    pub fn accept(
        &mut self,
        artifact_id: &str,
        version: &str,
        response: ArtifactResponse,
    ) -> Result<bool> {
        let i = &mut self.interaction;
        ensure!(
            i.artifact_id == artifact_id && i.version == version,
            "Artifact version does not match"
        );
        if let Some(previous) = &self.response {
            ensure!(
                previous == &response,
                "This request already has a different response"
            );
            return Ok(false);
        }
        ensure!(
            i.state == ArtifactInteractionState::InputRequired
                && i.expires_at > Utc::now()
                && self.boot_id == *BOOT_ID,
            "Artifact request has ended or expired"
        );
        if let ArtifactResponse::Submit { data } = &response {
            ensure!(
                serde_json::to_vec(data)?.len() <= MAX_RESPONSE_BYTES,
                "Input is too large"
            );
            i.schema.validate(data, "input")?;
        }
        i.state = if matches!(response, ArtifactResponse::Cancel) {
            ArtifactInteractionState::Cancelled
        } else {
            ArtifactInteractionState::Accepted
        };
        self.response = Some(response);
        Ok(true)
    }
}

fn directory(reference: &ArtifactInteractionRef) -> PathBuf {
    artifacts::directory(reference.session_id, reference.execution_id).join("interactions")
}

pub async fn load(reference: &ArtifactInteractionRef) -> Result<Receipt> {
    let bytes =
        tokio::fs::read(directory(reference).join(format!("{}.json", reference.request_id)))
            .await?;
    let receipt: Receipt = serde_json::from_slice(&bytes)?;
    ensure!(
        receipt.interaction.reference == *reference,
        "Invalid artifact request identity"
    );
    Ok(receipt)
}

/// Call with LOCK held so concurrent submissions cannot both dispatch.
pub async fn save(receipt: &Receipt) -> Result<()> {
    let reference = &receipt.interaction.reference;
    let dir = directory(reference);
    tokio::fs::create_dir_all(&dir).await?;
    artifacts::atomic_write(
        &dir.join(format!("{}.json", reference.request_id)),
        &serde_json::to_vec(receipt)?,
    )
    .await
}

pub async fn list(session_id: Uuid, execution_id: Uuid) -> Result<Vec<Receipt>> {
    let reference = ArtifactInteractionRef {
        session_id,
        execution_id,
        request_id: Uuid::nil(),
    };
    let mut entries = match tokio::fs::read_dir(directory(&reference)).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut receipts = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|s| s.strip_suffix(".json"))
            .and_then(|s| Uuid::parse_str(s).ok())
        else {
            continue;
        };
        receipts.push(
            load(&ArtifactInteractionRef {
                request_id: id,
                ..reference.clone()
            })
            .await?,
        );
    }
    receipts.sort_by_key(|r| std::cmp::Reverse(r.interaction.created_at));
    Ok(receipts)
}

pub async fn mark_started(reference: &ArtifactInteractionRef, execution: Uuid) -> Result<()> {
    let _guard = LOCK.lock().await;
    let mut receipt = load(reference).await?;
    receipt.interaction.result_process_id = Some(execution);
    if receipt.interaction.state != ArtifactInteractionState::Cancelled {
        receipt.interaction.state = ArtifactInteractionState::Processing;
        receipt.interaction.error = None;
    }
    save(&receipt).await
}

pub async fn mark_cancelled(reference: &ArtifactInteractionRef) -> Result<()> {
    let _guard = LOCK.lock().await;
    let mut receipt = load(reference).await?;
    if receipt.interaction.result_process_id.is_none() {
        receipt.interaction.state = ArtifactInteractionState::Cancelled;
        save(&receipt).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn schema() -> ArtifactInputSchema {
        serde_json::from_value(json!({"type":"object","properties": {
            "choice":{"type":"string","enum":["review","run"]},
            "title":{"type":"string","maxLength":20},
            "count":{"type":"number","minimum":1,"maximum":5},
            "rows":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]},"maxItems":2}
        },"required":["choice"]})).unwrap()
    }
    fn receipt() -> Receipt {
        Receipt {
            boot_id: *BOOT_ID,
            response: None,
            interaction: ArtifactInteraction {
                reference: ArtifactInteractionRef {
                    session_id: Uuid::new_v4(),
                    execution_id: Uuid::new_v4(),
                    request_id: Uuid::new_v4(),
                },
                workspace_id: Uuid::new_v4(),
                owner_host: "host-a".into(),
                owner_id: "owner-a".into(),
                artifact_id: "form".into(),
                artifact_hash: "html-hash".into(),
                version: "bundle-hash".into(),
                schema: schema(),
                delivery: ArtifactDelivery::FollowUp,
                state: ArtifactInteractionState::InputRequired,
                created_at: Utc::now(),
                expires_at: Utc::now() + chrono::Duration::hours(1),
                result_process_id: None,
                error: None,
            },
        }
    }

    #[test]
    fn schema_accepts_selection_and_editing_but_rejects_invalid_data() {
        let schema = schema();
        schema.check(0).unwrap();
        schema.validate(&json!({"choice":"run"}), "input").unwrap();
        schema
            .validate(
                &json!({"choice":"review","title":"한글 초안","count":2,"rows":[{"name":"수정"}]}),
                "input",
            )
            .unwrap();
        for invalid in [
            json!({}),
            json!({"choice":"unknown"}),
            json!({"choice":"run","count":0}),
            json!({"choice":"run","count":"2"}),
            json!({"choice":"run","rows":[{}]}),
            json!({"choice":"run","url":"https://example.com"}),
        ] {
            assert!(schema.validate(&invalid, "input").is_err(), "{invalid}");
        }
        assert!(
            serde_json::from_value::<ArtifactInputSchema>(json!({"type":"string","pattern":".*"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<ArtifactInputSchema>(
                json!({"type":"object","properties":{"password":{"type":"string"}}})
            )
            .unwrap()
            .check(0)
            .is_err()
        );
    }

    #[test]
    fn scope_checks_every_owner_host_and_execution_dimension() {
        let receipt = receipt();
        let i = &receipt.interaction;
        receipt
            .check_scope(
                i.workspace_id,
                i.reference.session_id,
                i.reference.execution_id,
                "host-a",
                "owner-a",
            )
            .unwrap();
        for (workspace, session, execution, host, owner) in [
            (
                Uuid::new_v4(),
                i.reference.session_id,
                i.reference.execution_id,
                "host-a",
                "owner-a",
            ),
            (
                i.workspace_id,
                Uuid::new_v4(),
                i.reference.execution_id,
                "host-a",
                "owner-a",
            ),
            (
                i.workspace_id,
                i.reference.session_id,
                Uuid::new_v4(),
                "host-a",
                "owner-a",
            ),
            (
                i.workspace_id,
                i.reference.session_id,
                i.reference.execution_id,
                "host-b",
                "owner-a",
            ),
            (
                i.workspace_id,
                i.reference.session_id,
                i.reference.execution_id,
                "host-a",
                "owner-b",
            ),
        ] {
            assert!(
                receipt
                    .check_scope(workspace, session, execution, host, owner)
                    .is_err()
            );
        }
    }

    #[test]
    fn accepted_receipt_replays_once_even_after_serialization_or_restart() {
        let mut receipt = receipt();
        let response = ArtifactResponse::Submit {
            data: json!({"choice":"run"}),
        };
        assert!(
            receipt
                .accept("form", "bundle-hash", response.clone())
                .unwrap()
        );
        assert_eq!(
            receipt.interaction.state,
            ArtifactInteractionState::Accepted
        );
        assert!(receipt.interaction.result_process_id.is_none());
        let mut saved: Receipt =
            serde_json::from_slice(&serde_json::to_vec(&receipt).unwrap()).unwrap();
        saved.boot_id = Uuid::new_v4();
        assert!(!saved.accept("form", "bundle-hash", response).unwrap());
        assert!(
            saved
                .accept("form", "bundle-hash", ArtifactResponse::Cancel)
                .is_err()
        );
        assert!(
            saved
                .accept(
                    "form",
                    "bundle-hash",
                    ArtifactResponse::Submit {
                        data: json!({"choice":"review"})
                    }
                )
                .is_err()
        );
    }

    #[test]
    fn validation_expiry_and_wrong_version_never_consume_the_request() {
        let original = receipt();
        for (id, version) in [("other", "bundle-hash"), ("form", "stale-hash")] {
            let mut receipt = original.clone();
            assert!(
                receipt
                    .accept(id, version, ArtifactResponse::Cancel)
                    .is_err()
            );
            assert!(receipt.response.is_none());
        }
        let mut invalid = original.clone();
        assert!(
            invalid
                .accept(
                    "form",
                    "bundle-hash",
                    ArtifactResponse::Submit {
                        data: json!({"choice":"bad"})
                    }
                )
                .is_err()
        );
        assert!(invalid.response.is_none());
        invalid.interaction.expires_at = Utc::now() - chrono::Duration::seconds(1);
        assert!(
            invalid
                .accept("form", "bundle-hash", ArtifactResponse::Cancel)
                .is_err()
        );
        let mut restarted = original;
        restarted.boot_id = Uuid::new_v4();
        assert!(
            restarted
                .accept("form", "bundle-hash", ArtifactResponse::Cancel)
                .is_err()
        );
    }

    #[tokio::test]
    async fn concurrent_submissions_claim_only_one_persisted_dispatch() {
        let initial = receipt();
        let reference = initial.interaction.reference.clone();
        {
            let _guard = LOCK.lock().await;
            save(&initial).await.unwrap();
        }
        async fn claim(reference: &ArtifactInteractionRef) -> bool {
            let _guard = LOCK.lock().await;
            let mut receipt = load(reference).await.unwrap();
            let dispatch = receipt
                .accept(
                    "form",
                    "bundle-hash",
                    ArtifactResponse::Submit {
                        data: json!({"choice":"review"}),
                    },
                )
                .unwrap();
            save(&receipt).await.unwrap();
            dispatch
        }
        let (a, b) = tokio::join!(claim(&reference), claim(&reference));
        assert_eq!(usize::from(a) + usize::from(b), 1);
        assert_eq!(
            load(&reference).await.unwrap().interaction.state,
            ArtifactInteractionState::Accepted
        );
        mark_started(&reference, Uuid::new_v4()).await.unwrap();
        assert_eq!(
            load(&reference).await.unwrap().interaction.state,
            ArtifactInteractionState::Processing
        );
        tokio::fs::remove_dir_all(artifacts::directory(
            reference.session_id,
            reference.execution_id,
        ))
        .await
        .unwrap();
    }

    #[test]
    fn cancellation_is_an_idempotent_response_not_task_success() {
        let mut receipt = receipt();
        assert!(
            receipt
                .accept("form", "bundle-hash", ArtifactResponse::Cancel)
                .unwrap()
        );
        assert_eq!(
            receipt.interaction.state,
            ArtifactInteractionState::Cancelled
        );
        assert!(
            !receipt
                .accept("form", "bundle-hash", ArtifactResponse::Cancel)
                .unwrap()
        );
    }
}
