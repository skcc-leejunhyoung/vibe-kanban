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
    Service,
    Automation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
pub struct ArtifactAutomationAction {
    pub label: String,
    pub schema: ArtifactInputSchema,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
pub struct ArtifactAutomationBinding {
    pub channel_id: String,
    pub version: String,
    pub data_schema: ArtifactInputSchema,
    pub actions: BTreeMap<String, ArtifactAutomationAction>,
}

impl ArtifactAutomationBinding {
    pub fn check(&self) -> Result<()> {
        ensure!(
            valid_channel_id(&self.channel_id),
            "Invalid automation channel"
        );
        ensure!(self.version.len() == 64, "Invalid automation version");
        ensure!(self.actions.len() <= 16, "Too many automation actions");
        self.data_schema.check(0)?;
        for (name, action) in &self.actions {
            ensure!(valid_channel_id(name), "Invalid automation action");
            ensure!(
                !action.label.is_empty() && action.label.len() <= 480,
                "Invalid action label"
            );
            ensure!(
                matches!(action.schema, ArtifactInputSchema::Object { .. }),
                "Expected an object schema"
            );
            action.schema.check(0)?;
        }
        Ok(())
    }
}

pub fn valid_channel_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && !["__proto__", "constructor", "prototype"].contains(&value)
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ArtifactAutomationRequest {
    pub request_id: Uuid,
    pub action: String,
    #[ts(type = "unknown")]
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ArtifactAutomationResult {
    pub request_id: Uuid,
    pub action: String,
    pub status: ArtifactInteractionState,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ArtifactAutomationSnapshot {
    #[ts(type = "number")]
    pub revision: u64,
    pub updated_at: Option<DateTime<Utc>>,
    #[ts(type = "unknown")]
    pub data: Value,
    pub request: Option<ArtifactAutomationResult>,
}

/// App-owned allowlist. Artifact data never supplies a URL or target session.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
pub enum ArtifactHandler {
    #[serde(rename = "session.rename")]
    SessionRename,
}

impl ArtifactHandler {
    pub fn schema(self) -> ArtifactInputSchema {
        match self {
            Self::SessionRename => ArtifactInputSchema::Object {
                properties: BTreeMap::from([(
                    "name".into(),
                    ArtifactInputSchema::String {
                        choices: None,
                        max_length: 80,
                    },
                )]),
                required: vec!["name".into()],
            },
        }
    }
}

pub fn check_destination(
    delivery: ArtifactDelivery,
    handler: Option<ArtifactHandler>,
    schema: &ArtifactInputSchema,
) -> Result<()> {
    match (delivery, handler) {
        (ArtifactDelivery::Service, Some(handler)) => {
            ensure!(
                schema == &handler.schema(),
                "Use the registered handler's input schema"
            );
        }
        (ArtifactDelivery::Service, None) => bail!("A registered service handler is required"),
        (_, Some(_)) => bail!("A handler requires service delivery"),
        (_, None) => {}
    }
    Ok(())
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
    #[serde(default)]
    pub handler: Option<ArtifactHandler>,
    #[serde(default)]
    pub automation: Option<ArtifactAutomationBinding>,
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
    /// Persisted before dispatch, including before an execution row is created.
    #[serde(default)]
    pub dispatch_claimed: bool,
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
            i.delivery != ArtifactDelivery::Automation
                || matches!(response, ArtifactResponse::Cancel),
            "Use a registered automation action"
        );
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

/// A restored queue must not dispatch an accepted response a second time.
pub async fn claim_dispatch(reference: &ArtifactInteractionRef) -> Result<bool> {
    let _guard = LOCK.lock().await;
    let mut receipt = load(reference).await?;
    let eligible = match receipt.interaction.state {
        ArtifactInteractionState::Accepted | ArtifactInteractionState::Failed => true,
        ArtifactInteractionState::Cancelled => {
            receipt.response == Some(ArtifactResponse::Cancel)
                && receipt.interaction.delivery == ArtifactDelivery::FollowUp
        }
        _ => false,
    };
    if receipt.dispatch_claimed
        || receipt.interaction.result_process_id.is_some()
        || receipt.response.is_none()
        || !eligible
    {
        return Ok(false);
    }
    receipt.dispatch_claimed = true;
    save(&receipt).await?;
    Ok(true)
}

pub async fn mark_started(reference: &ArtifactInteractionRef, execution: Uuid) -> Result<()> {
    let _guard = LOCK.lock().await;
    let mut receipt = load(reference).await?;
    ensure!(
        receipt.dispatch_claimed,
        "Artifact dispatch was not claimed"
    );
    ensure!(
        receipt.interaction.result_process_id.is_none(),
        "Artifact response has already been dispatched"
    );
    receipt.interaction.result_process_id = Some(execution);
    if receipt.interaction.state != ArtifactInteractionState::Cancelled {
        receipt.interaction.state = ArtifactInteractionState::Processing;
        receipt.interaction.error = None;
    }
    save(&receipt).await
}

pub async fn mark_dispatch_failed(reference: &ArtifactInteractionRef, error: &str) -> Result<()> {
    let _guard = LOCK.lock().await;
    let mut receipt = load(reference).await?;
    if receipt.interaction.state != ArtifactInteractionState::Cancelled {
        receipt.interaction.state = ArtifactInteractionState::Failed;
        receipt.interaction.error = Some(error.to_string());
        save(&receipt).await?;
    }
    Ok(())
}

pub async fn mark_cancelled(reference: &ArtifactInteractionRef) -> Result<()> {
    let _guard = LOCK.lock().await;
    let mut receipt = load(reference).await?;
    if !receipt.dispatch_claimed && receipt.interaction.result_process_id.is_none() {
        receipt.dispatch_claimed = true;
        receipt.interaction.state = ArtifactInteractionState::Cancelled;
        save(&receipt).await?;
    }
    Ok(())
}

/// Called only after the browser response passed owner, scope and schema checks.
pub async fn dispatch_service(
    pool: &sqlx::SqlitePool,
    reference: &ArtifactInteractionRef,
) -> Result<ArtifactInteraction> {
    if !claim_dispatch(reference).await? {
        return Ok(load(reference).await?.interaction);
    }
    let mut receipt = {
        let _guard = LOCK.lock().await;
        let mut receipt = load(reference).await?;
        receipt.interaction.state = ArtifactInteractionState::Processing;
        save(&receipt).await?;
        receipt
    };
    let result: Result<()> = async {
        let i = &receipt.interaction;
        check_destination(i.delivery, i.handler, &i.schema)?;
        let Some(ArtifactResponse::Submit { data }) = &receipt.response else {
            bail!("No service input was submitted");
        };
        i.schema.validate(data, "input")?;
        let session = db::models::session::Session::find_by_id(pool, reference.session_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Session no longer exists"))?;
        ensure!(
            session.workspace_id == i.workspace_id,
            "Wrong handler workspace"
        );
        match i.handler {
            Some(ArtifactHandler::SessionRename) => {
                db::models::session::Session::update(pool, session.id, data["name"].as_str())
                    .await?;
            }
            None => bail!("No service handler registered"),
        }
        Ok(())
    }
    .await;
    let _guard = LOCK.lock().await;
    receipt.interaction.state = if result.is_ok() {
        ArtifactInteractionState::Completed
    } else {
        ArtifactInteractionState::Failed
    };
    receipt.interaction.error = result.err().map(|error| error.to_string());
    save(&receipt).await?;
    Ok(receipt.interaction)
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
            dispatch_claimed: false,
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
                handler: None,
                automation: None,
                state: ArtifactInteractionState::InputRequired,
                created_at: Utc::now(),
                expires_at: Utc::now() + chrono::Duration::hours(1),
                result_process_id: None,
                error: None,
            },
        }
    }

    #[test]
    fn automation_binding_is_bounded_and_cannot_use_one_shot_submit() {
        let mut binding = ArtifactAutomationBinding {
            channel_id: "dashboard".into(),
            version: "a".repeat(64),
            data_schema: schema(),
            actions: BTreeMap::from([(
                "refresh".into(),
                ArtifactAutomationAction {
                    label: "Refresh".into(),
                    schema: schema(),
                },
            )]),
        };
        binding.check().unwrap();
        binding.channel_id = "../state".into();
        assert!(binding.check().is_err());
        binding.channel_id = "dashboard".into();
        binding.actions.get_mut("refresh").unwrap().schema = ArtifactInputSchema::Boolean;
        assert!(binding.check().is_err());
        let mut receipt = receipt();
        receipt.interaction.delivery = ArtifactDelivery::Automation;
        assert!(
            receipt
                .accept(
                    "form",
                    "bundle-hash",
                    ArtifactResponse::Submit {
                        data: json!({"choice":"run"})
                    }
                )
                .is_err()
        );
        assert!(
            receipt
                .accept("form", "bundle-hash", ArtifactResponse::Cancel)
                .unwrap()
        );
        assert_eq!(
            receipt.interaction.state,
            ArtifactInteractionState::Cancelled
        );
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
        let (a, b) = tokio::join!(claim_dispatch(&reference), claim_dispatch(&reference));
        assert_eq!(usize::from(a.unwrap()) + usize::from(b.unwrap()), 1);
        mark_cancelled(&reference).await.unwrap();
        assert_eq!(
            load(&reference).await.unwrap().interaction.state,
            ArtifactInteractionState::Accepted
        );
        let first_execution = Uuid::new_v4();
        mark_started(&reference, first_execution).await.unwrap();
        assert!(mark_started(&reference, Uuid::new_v4()).await.is_err());
        assert_eq!(
            load(&reference)
                .await
                .unwrap()
                .interaction
                .result_process_id,
            Some(first_execution)
        );
        assert!(!claim_dispatch(&reference).await.unwrap());
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

    #[tokio::test]
    async fn restored_queue_cannot_dispatch_consumed_or_uncertain_receipts() {
        for scenario in [
            "legacy_completed",
            "interrupted_before_record",
            "failed",
            "cancelled",
        ] {
            let mut receipt = receipt();
            receipt
                .accept(
                    "form",
                    "bundle-hash",
                    ArtifactResponse::Submit {
                        data: json!({"choice":"run"}),
                    },
                )
                .unwrap();
            let reference = receipt.interaction.reference.clone();
            if scenario == "legacy_completed" {
                receipt.interaction.result_process_id = Some(Uuid::new_v4());
                receipt.interaction.state = ArtifactInteractionState::Completed;
                let mut old = serde_json::to_value(&receipt).unwrap();
                old.as_object_mut().unwrap().remove("dispatch_claimed");
                receipt = serde_json::from_value(old).unwrap();
            } else {
                receipt.dispatch_claimed = true;
                receipt.interaction.state = match scenario {
                    "failed" => ArtifactInteractionState::Failed,
                    "cancelled" => ArtifactInteractionState::Cancelled,
                    _ => ArtifactInteractionState::Accepted,
                };
            }
            receipt.boot_id = Uuid::new_v4();
            {
                let _guard = LOCK.lock().await;
                save(&receipt).await.unwrap();
            }
            assert!(!claim_dispatch(&reference).await.unwrap(), "{scenario}");
            assert!(
                !claim_dispatch(&reference).await.unwrap(),
                "manual retry: {scenario}"
            );
            tokio::fs::remove_dir_all(directory(&reference))
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn queued_cancellation_waits_for_its_receipt_and_holds_on_storage_failure() {
        use db::models::scratch::DraftFollowUpData;
        use executors::{executors::BaseCodingAgent, profile::ExecutorConfig};

        use super::super::queued_message::QueuedMessageService;
        let queue = QueuedMessageService::new();
        let mut receipt = receipt();
        receipt
            .accept(
                "form",
                "bundle-hash",
                ArtifactResponse::Submit {
                    data: json!({"choice":"run"}),
                },
            )
            .unwrap();
        let reference = receipt.interaction.reference.clone();
        let session = reference.session_id;
        let data = DraftFollowUpData {
            message: "response".into(),
            executor_config: ExecutorConfig::new(BaseCodingAgent::ClaudeCode),
        };
        let guard = LOCK.lock().await;
        save(&receipt).await.unwrap();
        let message = queue.enqueue_artifact(session, data.clone(), reference.clone());
        let cloned_queue = queue.clone();
        let mut cancel =
            tokio::spawn(async move { cloned_queue.cancel_message(session, message.id).await });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut cancel)
                .await
                .is_err()
        );
        drop(guard);
        assert!(cancel.await.unwrap().unwrap().is_some());
        let saved = load(&reference).await.unwrap();
        assert_eq!(saved.interaction.state, ArtifactInteractionState::Cancelled);
        assert!(saved.dispatch_claimed);
        assert!(!claim_dispatch(&reference).await.unwrap());
        // A lost/unreadable receipt must not be acknowledged as cancelled.
        tokio::fs::remove_dir_all(directory(&reference))
            .await
            .unwrap();
        let message = queue.enqueue_artifact(session, data, reference);
        assert!(queue.cancel_message(session, message.id).await.is_err());
        assert_eq!(queue.get_queued(session)[0].id, message.id);
        assert!(queue.get_queued(session)[0].start_error.is_some());
        assert!(!queue.can_drain_now(session));
        assert!(queue.clear_queue(session).await.is_err());
        assert_eq!(queue.get_queued(session)[0].id, message.id);
    }

    #[test]
    fn service_registration_uses_only_the_fixed_handler_schema() {
        let handler = ArtifactHandler::SessionRename;
        check_destination(ArtifactDelivery::Service, Some(handler), &handler.schema()).unwrap();
        assert!(check_destination(ArtifactDelivery::Service, Some(handler), &schema()).is_err());
        assert!(check_destination(ArtifactDelivery::Service, None, &handler.schema()).is_err());
        assert!(
            check_destination(ArtifactDelivery::Wait, Some(handler), &handler.schema()).is_err()
        );
        for target in [
            "jump.password",
            "https://example.com",
            "shell",
            "backend.call",
        ] {
            assert!(serde_json::from_value::<ArtifactHandler>(json!(target)).is_err());
        }
    }

    #[tokio::test]
    async fn service_handler_is_bound_to_session_and_runs_once_with_real_completion() {
        use db::models::{
            session::{CreateSession, Session},
            workspace::{CreateWorkspace, Workspace},
        };
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let workspace = Workspace::create(
            &pool,
            &CreateWorkspace {
                branch: "test".into(),
                name: None,
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let session = Session::create(
            &pool,
            &CreateSession {
                executor: None,
                variant: None,
                name: Some("original".into()),
            },
            Uuid::new_v4(),
            workspace.id,
        )
        .await
        .unwrap();
        for scenario in ["success", "wrong_workspace", "database_failure", "cancel"] {
            let mut receipt = receipt();
            receipt.interaction.reference.session_id = session.id;
            receipt.interaction.workspace_id = if scenario == "wrong_workspace" {
                Uuid::new_v4()
            } else {
                workspace.id
            };
            receipt.interaction.delivery = ArtifactDelivery::Service;
            receipt.interaction.handler = Some(ArtifactHandler::SessionRename);
            receipt.interaction.schema = ArtifactHandler::SessionRename.schema();
            receipt
                .accept(
                    "form",
                    "bundle-hash",
                    if scenario == "cancel" {
                        ArtifactResponse::Cancel
                    } else {
                        ArtifactResponse::Submit {
                            data: json!({"name":"검토한 이름"}),
                        }
                    },
                )
                .unwrap();
            let reference = receipt.interaction.reference.clone();
            {
                let _guard = LOCK.lock().await;
                save(&receipt).await.unwrap();
            }
            if scenario == "database_failure" {
                sqlx::query("CREATE TRIGGER fail_rename BEFORE UPDATE ON sessions BEGIN SELECT RAISE(FAIL, 'rename failed'); END")
                    .execute(&pool).await.unwrap();
            }
            let first = dispatch_service(&pool, &reference).await.unwrap();
            assert_eq!(
                first.state,
                match scenario {
                    "success" => ArtifactInteractionState::Completed,
                    "cancel" => ArtifactInteractionState::Cancelled,
                    _ => ArtifactInteractionState::Failed,
                }
            );
            if scenario == "database_failure" {
                assert!(first.error.as_ref().unwrap().contains("rename failed"));
                sqlx::query("DROP TRIGGER fail_rename")
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            if scenario == "success" {
                assert_eq!(
                    Session::find_by_id(&pool, session.id)
                        .await
                        .unwrap()
                        .unwrap()
                        .name
                        .as_deref(),
                    Some("검토한 이름")
                );
            }
            Session::update(&pool, session.id, Some("later edit"))
                .await
                .unwrap();
            let replay = dispatch_service(&pool, &reference).await.unwrap();
            assert_eq!(replay.state, first.state);
            assert_eq!(
                Session::find_by_id(&pool, session.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .name
                    .as_deref(),
                Some("later edit")
            );
            tokio::fs::remove_dir_all(directory(&reference))
                .await
                .unwrap();
        }
    }
}
