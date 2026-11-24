use std::{
    collections::HashSet,
    io::{BufRead, Read},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{Arc, LazyLock},
    time::Duration,
};

use agent_client_protocol::{
    ToolCall, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind,
};
use async_trait::async_trait;
use command_group::AsyncGroupChild;
use derivative::Derivative;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use regex::Regex;
use reqwest::{Method, RequestBuilder, Url};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, BufReader},
    process::Command,
    sync::oneshot,
};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;
use workspace_utils::{
    approvals::ApprovalStatus, command_ext::GroupSpawnNoWindowExt, msg_store::MsgStore,
    path::VIBE_ATTACHMENTS_DIR,
};

use super::{
    AppendPrompt, AvailabilityInfo, BaseCodingAgent, ExecutorError, ExecutorExitResult,
    SpawnedChild, StandardCodingAgentExecutor,
    acp::{self, AcpEvent, ApprovalResponse},
    opencode::sdk::generate_server_password,
    utils,
};
use crate::{
    approvals::ExecutorApprovalService,
    command::CmdOverrides,
    env::ExecutionEnv,
    executor_discovery::ExecutorDiscoveredOptions,
    logs::utils::patch,
    model_selector::{
        AgentInfo, ModelInfo, ModelProvider, ModelSelectorConfig, PermissionPolicy, ReasoningOption,
    },
    profile::ExecutorConfig,
    stdout_dup::create_stdout_pipe_writer,
};

const INSTALL: &str = "Install @opencode/cli@2.4.1 in a separate npm prefix on the execution host, then set the profile base command to its opencode2 executable.";
const LOGIN: &str = "Configure a model provider in opencode2 with /connect, or set its API key in the executor environment.";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONFIG_CONTENT: &str = "OPENCODE_CONFIG_CONTENT";
/// OpenCode refuses the whole prompt when one attachment is larger.
const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
pub const MEMORY_SKILL_IDS: [&str; 2] = ["vibe-repository-memory", "vibe-shared-repository-memory"];

pub fn memory_scope_binding(key: &str) -> String {
    format!(
        "<!-- vibe-repository-scope:{:x} -->\n",
        Sha256::digest(key.as_bytes())
    )
}

pub fn memory_skill_dirs(checkout: &Path, key: &str) -> Vec<PathBuf> {
    let config = checkout.join(".opencode");
    let root = config.join("skills");
    let is_dir = |path: &Path| path.symlink_metadata().is_ok_and(|meta| meta.is_dir());
    if !is_dir(&config) || !is_dir(&root) {
        return Vec::new();
    }
    let binding = memory_scope_binding(key);
    MEMORY_SKILL_IDS
        .iter()
        .map(|id| root.join(id))
        .filter(|directory| {
            let file = directory.join("SKILL.md");
            is_dir(directory)
                && file.symlink_metadata().is_ok_and(|meta| meta.is_file())
                && std::fs::File::open(file).is_ok_and(|file| {
                    std::io::BufReader::new(std::io::Read::take(file, 4096))
                        .lines()
                        .take(8)
                        .map_while(Result::ok)
                        .any(|line| line == binding.trim_end())
                })
        })
        .collect()
}

fn with_memory_skill_dirs(existing: Option<&str>, dirs: &[PathBuf]) -> Option<String> {
    let mut config = match existing {
        Some(existing) if !existing.trim().is_empty() => {
            jsonc_parser::parse_to_serde_value(existing, &Default::default()).ok()??
        }
        _ => json!({}),
    };
    let skills = config
        .as_object_mut()?
        .entry("skills")
        .or_insert_with(|| json!([]));
    let skills = skills.as_array_mut()?;
    for dir in dirs {
        let path = json!(dir.to_str()?);
        if !skills.contains(&path) {
            skills.push(path);
        }
    }
    Some(config.to_string())
}

#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[derivative(Debug, PartialEq)]
pub struct OpencodeV2 {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default)]
    pub auto_approve: bool,
    #[serde(flatten)]
    pub cmd: CmdOverrides,
    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    pub approvals: Option<Arc<dyn ExecutorApprovalService>>,
}

#[derive(Clone)]
struct Api {
    client: reqwest::Client,
    url: Url,
    password: String,
}

impl Api {
    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        let mut url = self.url.clone();
        url.set_path(path);
        self.client
            .request(method, url)
            .basic_auth("opencode", Some(&self.password))
    }

    async fn checked(
        request: RequestBuilder,
        label: &str,
    ) -> Result<reqwest::Response, ExecutorError> {
        Self::accepted(Self::send(request, label).await?, label)
    }

    async fn send(
        request: RequestBuilder,
        label: &str,
    ) -> Result<reqwest::Response, ExecutorError> {
        request.send().await.map_err(|_| utils::agent_error(format!(
            "OpenCode v2 {label} could not reach the local server. Check the opencode2 installation."
        )))
    }

    fn accepted(
        response: reqwest::Response,
        label: &str,
    ) -> Result<reqwest::Response, ExecutorError> {
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(utils::agent_error(format!(
                "OpenCode v2 {label} could not authenticate to its local API. Check the configured opencode2 version and restart the turn."
            )));
        }
        if !status.is_success() {
            return Err(utils::agent_error(format!(
                "OpenCode v2 {label} failed (HTTP {status}). {LOGIN}"
            )));
        }
        Ok(response)
    }

    async fn read<T: DeserializeOwned>(
        request: RequestBuilder,
        label: &str,
    ) -> Result<T, ExecutorError> {
        Self::checked(request.timeout(REQUEST_TIMEOUT), label)
            .await?
            .json()
            .await
            .map_err(|_| {
                utils::agent_error(format!(
                    "Unexpected OpenCode v2 {label} response. {INSTALL}"
                ))
            })
    }

    async fn events(&self, kind: Option<&str>) -> Result<reqwest::Response, ExecutorError> {
        let mut request = self.request(Method::GET, "/api/event");
        if let Some(kind) = kind {
            request = request.query(&[("types", kind)]);
        }
        tokio::time::timeout(
            REQUEST_TIMEOUT,
            Self::checked(request, "event subscription"),
        )
        .await
        .map_err(|_| utils::agent_error("OpenCode v2 event subscription timed out."))?
    }

    async fn post(
        &self,
        path: &str,
        body: Value,
        label: &str,
    ) -> Result<reqwest::Response, ExecutorError> {
        Self::checked(
            self.request(Method::POST, path)
                .timeout(REQUEST_TIMEOUT)
                .json(&body),
            label,
        )
        .await
    }

    /// Send a prompt with its chat images. OpenCode reads and decodes every
    /// attachment before admitting a prompt and refuses all of it (HTTP 400)
    /// for one it cannot use, such as a corrupt image. Nothing was admitted
    /// then, so the prompt goes once more as text, which still names each image.
    async fn prompt(&self, path: &str, mut body: Value) -> Result<(), ExecutorError> {
        let label = "prompt";
        if body.get("files").is_some() {
            let response = Self::send(
                self.request(Method::POST, path)
                    .timeout(REQUEST_TIMEOUT)
                    .json(&body),
                label,
            )
            .await?;
            if response.status() != reqwest::StatusCode::BAD_REQUEST {
                return Self::accepted(response, label).map(drop);
            }
            tracing::warn!("OpenCode v2 refused the chat images; sending the prompt without them");
            if let Some(body) = body.as_object_mut() {
                body.remove("files");
            }
        }
        self.post(path, body, label).await.map(drop)
    }
}

#[derive(Deserialize)]
struct Data<T> {
    data: T,
}

#[derive(Deserialize)]
struct Session {
    id: String,
    model: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    id: String,
    #[serde(rename = "providerID")]
    provider_id: String,
    name: String,
    enabled: bool,
    variants: Vec<Variant>,
}

#[derive(Deserialize)]
struct Variant {
    id: String,
}

#[derive(Deserialize)]
struct Provider {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct Agent {
    id: String,
    name: String,
    description: Option<String>,
    mode: String,
    hidden: bool,
}

#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type")]
    kind: String,
    data: Value,
}

impl OpencodeV2 {
    async fn start_server(
        &self,
        cwd: &Path,
        env: &ExecutionEnv,
    ) -> Result<(AsyncGroupChild, String), ExecutorError> {
        let (program, args) = utils::agent_command("opencode2", &self.cmd)?
            .into_resolved()
            .await
            .map_err(|err| utils::installation_error(err, INSTALL))?;
        let mut command = Command::new(program);
        let password = generate_server_password();
        command
            .args(args)
            .args(["serve", "--hostname", "127.0.0.1", "--port", "0", "--stdio"])
            .current_dir(cwd)
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // The V2 migration touches its data directory. Give V2 its own store.
        command.env(
            "XDG_DATA_HOME",
            workspace_utils::assets::asset_dir().join("opencode-v2-data"),
        );
        let env = env.clone().with_profile(&self.cmd);
        env.apply_to_command(&mut command);
        if !env.opencode_memory_skills.is_empty() {
            let inherited = std::env::var(CONFIG_CONTENT);
            let existing = env
                .get(CONFIG_CONTENT)
                .map(String::as_str)
                .or(inherited.as_deref().ok());
            if let Some(config) = with_memory_skill_dirs(existing, &env.opencode_memory_skills) {
                command.env(CONFIG_CONTENT, config);
            } else {
                tracing::warn!(
                    "OpenCode repository memory skills could not be added to inline config"
                );
            }
        }
        command
            .env("OPENCODE_PASSWORD", &password)
            .env_remove("OPENCODE_SERVER_USERNAME")
            .env_remove("OPENCODE_SERVER_PASSWORD");
        Ok((
            command.group_spawn_no_window().map_err(ExecutorError::Io)?,
            password,
        ))
    }

    async fn api(
        stdout: tokio::process::ChildStdout,
        password: String,
    ) -> Result<Api, ExecutorError> {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let read = tokio::time::timeout(REQUEST_TIMEOUT, reader.read_line(&mut line)).await;
        let info: Value = match read {
            Ok(Ok(bytes)) if bytes > 0 => serde_json::from_str(&line).unwrap_or(Value::Null),
            _ => Value::Null,
        };
        let url = info["url"]
            .as_str()
            .and_then(|url| Url::parse(url).ok())
            .filter(|url| {
                url.scheme() == "http"
                    && url.host_str() == Some("127.0.0.1")
                    && url.port().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
            })
            .ok_or_else(|| {
                utils::agent_error(format!(
                    "OpenCode v2 failed to start its local API. {INSTALL}"
                ))
            })?;
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut reader, &mut tokio::io::sink()).await;
        });

        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| utils::agent_error("Could not initialize the OpenCode v2 HTTP client."))?;
        Ok(Api {
            client,
            url,
            password,
        })
    }

    async fn discover(&self, cwd: PathBuf) -> Result<ModelSelectorConfig, ExecutorError> {
        let env = ExecutionEnv::new(Default::default(), false, String::new());
        let (mut child, password) = self.start_server(&cwd, &env).await?;
        let stdout = child.inner().stdout.take().expect("piped stdout");
        let result = async {
            let api = Self::api(stdout, password).await?;
            let directory = cwd.to_string_lossy();
            let location = [("location[directory]", directory.as_ref())];
            // Location startup publishes one or more model updates as plugins settle.
            let event_stream = api
                .events(Some("model.updated"))
                .await?
                .bytes_stream()
                .eventsource();
            futures::pin_mut!(event_stream);
            Api::read::<Value>(
                api.request(Method::GET, "/api/location").query(&location),
                "location discovery",
            )
            .await?;
            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                while let Ok(Some(Ok(_))) =
                    tokio::time::timeout(Duration::from_millis(700), event_stream.next()).await
                {
                }
            })
            .await;
            let (models, default, providers, agents) = tokio::try_join!(
                Api::read::<Data<Vec<Model>>>(
                    api.request(Method::GET, "/api/model").query(&location),
                    "model discovery"
                ),
                Api::read::<Data<Option<Model>>>(
                    api.request(Method::GET, "/api/model/default")
                        .query(&location),
                    "default model discovery"
                ),
                Api::read::<Data<Vec<Provider>>>(
                    api.request(Method::GET, "/api/provider").query(&location),
                    "provider discovery"
                ),
                Api::read::<Data<Vec<Agent>>>(
                    api.request(Method::GET, "/api/agent").query(&location),
                    "agent discovery"
                ),
            )?;
            let models: Vec<_> = models
                .data
                .into_iter()
                .filter(|model| model.enabled)
                .map(|model| ModelInfo {
                    id: model.id,
                    name: model.name,
                    provider_id: Some(model.provider_id),
                    reasoning_options: ReasoningOption::from_names(
                        model.variants.into_iter().map(|variant| variant.id),
                    ),
                    supports_fast: false,
                })
                .collect();
            if models.is_empty() {
                return Err(ExecutorError::AuthRequired(LOGIN.into()));
            }
            Ok(ModelSelectorConfig {
                models,
                default_model: default
                    .data
                    .filter(|model| model.enabled)
                    .map(|model| format!("{}/{}", model.provider_id, model.id)),
                providers: providers
                    .data
                    .into_iter()
                    .map(|provider| ModelProvider {
                        id: provider.id,
                        name: provider.name,
                    })
                    .collect(),
                agents: agents
                    .data
                    .into_iter()
                    .filter(|agent| !agent.hidden && agent.mode != "subagent")
                    .map(|agent| AgentInfo {
                        id: agent.id,
                        label: agent.name,
                        description: agent.description,
                        is_default: false,
                    })
                    .collect(),
                permissions: vec![PermissionPolicy::Supervised, PermissionPolicy::Auto],
            })
        }
        .await;
        let _ = child.kill().await;
        result
    }

    async fn run(
        &self,
        cwd: &Path,
        prompt: &str,
        id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let (mut child, password) = self.start_server(cwd, env).await?;
        let stdin = child.inner().stdin.take().expect("piped stdin");
        let stdout = child.inner().stdout.take().expect("piped stdout");
        let mut writer = create_stdout_pipe_writer(&mut child)?;
        let (exit_tx, exit_signal) = oneshot::channel();
        let cancel = CancellationToken::new();
        let turn_cancel = cancel.clone();
        let executor = self.clone();
        let cwd = cwd.to_path_buf();
        let id = id.map(str::to_owned);
        let prompt = self.append_prompt.combine_prompt(prompt);
        tokio::spawn(async move {
            let result = async {
                let api = tokio::select! {
                    _ = turn_cancel.cancelled() => return Ok(()),
                    api = Self::api(stdout, password) => api?,
                };
                executor
                    .run_turn(&api, &cwd, prompt, id, &turn_cancel, &mut writer)
                    .await
            }
            .await;
            let status = match result {
                Ok(()) => ExecutorExitResult::Success,
                Err(err) => {
                    let _ = AcpEvent::Error(err.to_string()).write_to(&mut writer).await;
                    ExecutorExitResult::Failure
                }
            };
            // The --stdio server exits when its controlling stdin is closed.
            drop(stdin);
            let _ = exit_tx.send(status);
        });
        Ok(SpawnedChild {
            child,
            exit_signal: Some(exit_signal),
            cancel: Some(cancel),
            subagent_handle: None,
        })
    }

    async fn run_turn(
        &self,
        api: &Api,
        cwd: &Path,
        prompt: String,
        id: Option<String>,
        cancel: &CancellationToken,
        writer: &mut (impl AsyncWrite + Unpin),
    ) -> Result<(), ExecutorError> {
        let explicit_model = self
            .model
            .as_deref()
            .map(|model| model_ref(model, self.variant.as_deref()))
            .transpose()?;
        let permissions = self
            .auto_approve
            .then(|| json!([{"action":"*", "resource":"*", "effect":"allow"}]));
        let session = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            session = async {
                if let Some(id) = id {
                    let path = session_path(&id)?;
                    let session: Data<Session> = Api::read(api.request(Method::GET, &path), "session resume").await?;
                    let model = resolve_turn_model(api, cwd, explicit_model, session.data.model.clone(), self.variant.as_deref()).await?;
                    if let Some(model) = &model {
                        api.post(&format!("{path}/model"), json!({"model":model}), "model selection").await?;
                    }
                    if let Some(agent) = &self.agent {
                        api.post(&format!("{path}/agent"), json!({"agent":agent}), "agent selection").await?;
                    }
                    Api::checked(api.request(Method::PATCH, &path).timeout(REQUEST_TIMEOUT)
                        .json(&json!({"permissions": permissions.as_ref().unwrap_or(&json!([]))})), "session permissions").await?;
                    Ok::<_, ExecutorError>(session.data)
                } else {
                    let model = resolve_turn_model(api, cwd, explicit_model, None, self.variant.as_deref()).await?;
                    let created: Data<Session> = Api::read(api.request(Method::POST, "/api/session")
                        .json(&json!({"location":{"directory":cwd}, "model":model, "agent":self.agent, "permissions":permissions})), "session creation").await?;
                    Ok(created.data)
                }
            } => session?,
        };
        let path = session_path(&session.id)?;
        AcpEvent::SessionStart(session.id.clone())
            .write_to(writer)
            .await?;
        AcpEvent::User(prompt.clone()).write_to(writer).await?;
        let mut body = json!({"text":prompt, "delivery":"queue", "resume":true});
        let images = chat_images(cwd, &prompt);
        if !images.is_empty() {
            body["files"] = Value::Array(images);
        }
        let turn = async {
            let response = api.events(None).await?;
            let events = response.bytes_stream().eventsource();
            futures::pin_mut!(events);
            // The SSE connection is established before sending the prompt.
            api.prompt(&format!("{path}/prompt"), body).await?;
            while let Some(event) = events.next().await {
                let event = event
                    .map_err(|_| utils::agent_error("OpenCode v2 event stream disconnected."))?;
                let event: Event = serde_json::from_str(&event.data)?;
                let event_session = if event.kind == "form.created" {
                    event.data["form"]["sessionID"].as_str()
                } else {
                    event.data["sessionID"].as_str()
                };
                if event_session != Some(session.id.as_str()) {
                    continue;
                }
                match event.kind.as_str() {
                    "session.text.delta" | "session.reasoning.delta" => {
                        if let Some(delta) = event.data["delta"].as_str() {
                            let event = if event.kind == "session.text.delta" {
                                AcpEvent::text(delta)
                            } else {
                                AcpEvent::thought(delta)
                            };
                            event.write_to(writer).await?;
                        }
                    }
                    "session.execution.succeeded" => {
                        return AcpEvent::Done("end_turn".into()).write_to(writer).await;
                    }
                    "session.execution.interrupted" => {
                        return Err(utils::agent_error("OpenCode v2 interrupted the turn."));
                    }
                    "session.execution.failed" => {
                        let error = &event.data["error"];
                        let status = error["status"]
                            .as_i64()
                            .or_else(|| (error["type"] == "provider.auth").then_some(401));
                        return Err(utils::provider_request_error(
                            "OpenCode v2",
                            status,
                            LOGIN,
                            "OpenCode v2 could not complete the turn. Check the selected model and provider configuration.",
                        ));
                    }
                    "session.tool.input.started"
                    | "session.tool.called"
                    | "session.tool.success"
                    | "session.tool.failed" => {
                        if let Some(tool_event) = tool_event(&event) {
                            tool_event.write_to(writer).await?;
                        }
                    }
                    "permission.asked" => {
                        self.reply_permission(api, &path, &event.data, cancel, writer)
                            .await?
                    }
                    "form.created" => {
                        return Err(utils::agent_error(
                            "OpenCode v2 requested an interactive form, which this executor does not support.",
                        ));
                    }
                    _ => {}
                }
            }
            Err(utils::agent_error(
                "OpenCode v2 closed its event stream before completing the turn.",
            ))
        };
        tokio::select! {
            result = turn => result,
            _ = cancel.cancelled() => {
                let _ = tokio::time::timeout(Duration::from_secs(2), api.post(&format!("{path}/interrupt"), Value::Null, "interrupt")).await;
                Ok(())
            }
        }
    }

    async fn reply_permission(
        &self,
        api: &Api,
        path: &str,
        data: &Value,
        cancel: &CancellationToken,
        writer: &mut (impl AsyncWrite + Unpin),
    ) -> Result<(), ExecutorError> {
        let id = data["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| utils::agent_error("OpenCode v2 returned an invalid approval ID."))?;
        let action = data["action"].as_str().unwrap_or("tool");
        let linked_tool = (data["source"]["type"] == "tool")
            .then(|| {
                tool_call_id(
                    data["source"]["messageID"].as_str(),
                    data["source"]["id"].as_str(),
                )
            })
            .flatten();
        let tool_id = linked_tool.as_deref().unwrap_or(id);
        let title = match data["resources"].as_array() {
            Some(resources) => format!(
                "{action} {}",
                resources
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            None => action.to_owned(),
        };
        let status = if self.auto_approve {
            ApprovalStatus::Approved
        } else if let Some(approvals) = &self.approvals {
            AcpEvent::ToolUpdate(ToolCallUpdate::new(
                tool_id.to_owned(),
                ToolCallUpdateFields::new()
                    .title(&title)
                    .status(ToolCallStatus::Pending),
            ))
            .write_to(writer)
            .await?;
            let approval_id = approvals.create_tool_approval(&title).await?;
            AcpEvent::ApprovalRequested {
                tool_call_id: tool_id.into(),
                approval_id: approval_id.clone(),
            }
            .write_to(writer)
            .await?;
            approvals
                .wait_tool_approval(&approval_id, cancel.clone())
                .await?
        } else {
            ApprovalStatus::Denied { reason: None }
        };
        let (decision, message) = match &status {
            ApprovalStatus::Approved => ("once", None),
            ApprovalStatus::Denied { reason } => ("reject", reason.as_deref()),
            _ => ("reject", None),
        };
        api.post(
            &format!("{path}/permission/{id}/reply"),
            json!({"decision":decision, "message":message}),
            "permission reply",
        )
        .await?;
        if !self.auto_approve {
            AcpEvent::ApprovalResponse(ApprovalResponse {
                tool_call_id: tool_id.into(),
                status,
            })
            .write_to(writer)
            .await?;
        }
        Ok(())
    }
}

/// Chat images the prompt references, as OpenCode prompt `files` so an
/// image-capable model receives them with the prompt itself.
///
/// Only Markdown destinations in the turn's `.vibe-attachments/` qualify —
/// where Vibe copies what the user attached in chat — and only regular files
/// that stay inside it and whose bytes are PNG, JPEG, GIF or WebP, the formats
/// OpenCode hands a model as image media. Anything else remains a plain path
/// in the text: OpenCode refuses the whole prompt for an unreadable attachment
/// and leaves other binaries out of the model request.
fn chat_images(cwd: &Path, prompt: &str) -> Vec<Value> {
    static DESTINATION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(
            r"\]\(({}/[^)\s]+)\)",
            regex::escape(VIBE_ATTACHMENTS_DIR)
        ))
        .expect("valid attachment pattern")
    });
    // dunce: a plain path, not a Windows `\\?\` one, so the `file:` URL stays ordinary.
    let Ok(root) = dunce::canonicalize(cwd.join(VIBE_ATTACHMENTS_DIR)) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    DESTINATION
        .captures_iter(prompt)
        .filter_map(|captures| {
            let relative = Path::new(captures.get(1)?.as_str());
            if !relative
                .components()
                .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
            {
                return None;
            }
            let file = dunce::canonicalize(cwd.join(relative))
                .ok()
                .filter(|file| file.starts_with(&root))?;
            let readable = file
                .metadata()
                .is_ok_and(|meta| meta.is_file() && meta.len() <= MAX_ATTACHMENT_BYTES);
            if !readable || !is_model_image(&file) || !seen.insert(file.clone()) {
                return None;
            }
            Some(json!({
                "uri": Url::from_file_path(&file).ok()?.as_str(),
                "name": file.file_name()?.to_str()?,
            }))
        })
        .collect()
}

fn is_model_image(file: &Path) -> bool {
    let mut head = Vec::with_capacity(12);
    if std::fs::File::open(file)
        .and_then(|file| file.take(12).read_to_end(&mut head))
        .is_err()
    {
        return false;
    }
    head.starts_with(b"\x89PNG\r\n\x1a\n")
        || head.starts_with(b"\xff\xd8\xff")
        || head.starts_with(b"GIF87a")
        || head.starts_with(b"GIF89a")
        || (head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP".as_slice()))
}

fn tool_call_id(message: Option<&str>, call: Option<&str>) -> Option<String> {
    Some(format!("{}:{}", message?, call?))
}

fn tool_event(event: &Event) -> Option<AcpEvent> {
    let data = &event.data;
    let id = tool_call_id(data["assistantMessageID"].as_str(), data["id"].as_str())?;
    let mut update = ToolCallUpdateFields::new();
    match event.kind.as_str() {
        "session.tool.input.started" => {
            let name = data["name"].as_str().unwrap_or("tool");
            let mut call = ToolCall::new(id, name).status(ToolCallStatus::Pending);
            if name == "shell" {
                call = call.kind(ToolKind::Execute);
            }
            return Some(AcpEvent::ToolCall(call));
        }
        "session.tool.called" => {
            update = update.status(ToolCallStatus::InProgress);
            if let Some(command) = data["input"]["command"].as_str() {
                update = update
                    .raw_input(json!({"command": command}))
                    .kind(ToolKind::Execute);
            }
        }
        "session.tool.success" => {
            let exit = data["metadata"]["exit"].as_i64();
            if let Some(code) = exit {
                update = update.content(vec![format!("Exit code: {code}").into()]);
            }
            update = update.status(if exit.is_some_and(|code| code != 0) {
                ToolCallStatus::Failed
            } else {
                ToolCallStatus::Completed
            });
        }
        "session.tool.failed" => update = update.status(ToolCallStatus::Failed),
        _ => return None,
    }
    Some(AcpEvent::ToolUpdate(ToolCallUpdate::new(id, update)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_skill_config_preserves_other_settings_and_checks_scope() {
        let repo = tempfile::tempdir().unwrap();
        let dir = repo
            .path()
            .join(".opencode/skills")
            .join(MEMORY_SKILL_IDS[0]);
        std::fs::create_dir_all(&dir).unwrap();
        let key = "example.test/fixtures/one";
        std::fs::write(
            dir.join("SKILL.md"),
            format!(
                "---\nname: Fixture\ndescription: Fixture only\n---\n{}",
                memory_scope_binding(key)
            ),
        )
        .unwrap();
        assert!(memory_skill_dirs(repo.path(), "example.test/fixtures/two").is_empty());
        let dirs = memory_skill_dirs(repo.path(), key);
        assert_eq!(dirs, [dir.clone()]);
        let existing = Some(
            "{/* keep settings */ \"model\": \"fixture/model\", \"skills\": [\"./existing\"],}",
        );
        let merged = with_memory_skill_dirs(existing, &dirs).unwrap();
        assert_eq!(
            with_memory_skill_dirs(Some(&merged), &dirs).unwrap(),
            merged
        );
        assert_eq!(
            serde_json::from_str::<Value>(&merged).unwrap(),
            json!({
                "model": "fixture/model", "skills": ["./existing", dir]
            })
        );
        assert!(with_memory_skill_dirs(Some("{broken"), &dirs).is_none());
    }

    #[tokio::test]
    #[ignore = "requires VK_TEST_OPENCODE_V2_COMMAND pointing to an installed OpenCode v2"]
    async fn installed_opencode_loads_and_edits_the_original_skill_from_a_worktree() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let cwd = workspace.join("repo");
        let checkout = root.join("checkout");
        std::fs::create_dir(&checkout).unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .current_dir(&checkout)
                .args([
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.test",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
        };
        git(&["init", "-q"]);
        git(&["commit", "-q", "--allow-empty", "-m", "fixture"]);
        git(&[
            "worktree",
            "add",
            "-qb",
            "memory-fixture",
            cwd.to_str().unwrap(),
        ]);
        let dir = checkout.join(".opencode/skills").join(MEMORY_SKILL_IDS[0]);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("SKILL.md");
        let key = "example.test/fixture/repo";
        let frontmatter = format!(
            "---\nname: Fixture\ndescription: Fixture memory\n---\n{}",
            memory_scope_binding(key)
        );
        let content = format!("{frontmatter}\n## Tray\nThe original tray is violet.\n");
        std::fs::write(&path, content).unwrap();

        let agent = OpencodeV2 {
            append_prompt: AppendPrompt::default(),
            model: None,
            variant: None,
            agent: None,
            auto_approve: false,
            cmd: CmdOverrides {
                base_command_override: Some(std::env::var("VK_TEST_OPENCODE_V2_COMMAND").unwrap()),
                ..Default::default()
            },
            approvals: None,
        };
        let mut env = ExecutionEnv::new(Default::default(), false, String::new());
        for key in [
            "HOME",
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_CACHE_HOME",
            "XDG_STATE_HOME",
        ] {
            env.insert(key, root.join(key).to_str().unwrap());
        }
        env.insert("OPENCODE_DB", ":memory:");
        env.insert(CONFIG_CONTENT, "{}");
        env.opencode_memory_skills = memory_skill_dirs(&checkout, key);
        let (mut child, password) = agent.start_server(&cwd, &env).await.unwrap();
        let api = OpencodeV2::api(child.inner().stdout.take().unwrap(), password)
            .await
            .unwrap();
        let session: Data<Session> = Api::read(
            api.request(Method::POST, "/api/session")
                .json(&json!({"location":{"directory":cwd}})),
            "test session",
        )
        .await
        .unwrap();
        let id = session.data.id;
        api.post(
            &format!("/api/experimental/session/{id}/skill"),
            json!({
                "id": MEMORY_SKILL_IDS[0], "resume": false
            }),
            "test skill activation",
        )
        .await
        .unwrap();
        let context: Data<Value> = Api::read(
            api.request(Method::GET, &format!("/api/session/{id}/context")),
            "test skill context",
        )
        .await
        .unwrap();
        assert!(
            context
                .data
                .to_string()
                .contains("The original tray is violet.")
        );
        let edited = format!("{frontmatter}\n## Tray\nThe tray is amber.\n");
        Api::checked(
            api.request(Method::POST, "/api/experimental/fs/write")
                .query(&[("path", path.to_str().unwrap())])
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(edited.clone()),
            "test skill edit",
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), edited);
        assert!(!cwd.join(".opencode").exists());
        drop(child.inner().stdin.take());
        assert!(
            tokio::time::timeout(REQUEST_TIMEOUT, child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
    }

    #[test]
    fn completed_shell_event_with_nonzero_exit_marks_tool_failed() {
        let event = Event {
            kind: "session.tool.success".into(),
            data: json!({
                "assistantMessageID": "msg_fixture", "id": "call_fixture",
                "metadata": {"exit": 1}
            }),
        };
        let Some(AcpEvent::ToolUpdate(update)) = tool_event(&event) else {
            panic!("expected a tool update");
        };
        assert_eq!(&*update.tool_call_id.0, "msg_fixture:call_fixture");
        assert_eq!(update.fields.status, Some(ToolCallStatus::Failed));
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn session_path(id: &str) -> Result<String, ExecutorError> {
    if !valid_id(id) {
        return Err(utils::agent_error("Invalid OpenCode v2 session ID."));
    }
    Ok(format!("/api/session/{id}"))
}

fn model_ref(model: &str, variant: Option<&str>) -> Result<Value, ExecutorError> {
    let (provider, id) = model
        .split_once('/')
        .filter(|(provider, id)| !provider.is_empty() && !id.is_empty())
        .ok_or_else(|| {
            utils::agent_error("Select an OpenCode v2 model in provider/model format.")
        })?;
    let mut model = json!({"providerID":provider, "id":id});
    if let Some(variant) = variant {
        model["variant"] = json!(variant);
    }
    Ok(model)
}

async fn resolve_turn_model(
    api: &Api,
    cwd: &Path,
    explicit: Option<Value>,
    session_model: Option<Value>,
    variant: Option<&str>,
) -> Result<Option<Value>, ExecutorError> {
    if explicit.is_some() || variant.is_none() {
        return Ok(explicit);
    }
    let model = match session_model {
        Some(model) => model,
        None => {
            let directory = cwd.to_string_lossy();
            let default: Data<Option<Value>> = Api::read(
                api.request(Method::GET, "/api/model/default")
                    .query(&[("location[directory]", directory.as_ref())]),
                "default model discovery",
            )
            .await?;
            default.data.ok_or_else(|| {
                utils::agent_error(
                    "Select an OpenCode v2 model before setting its reasoning variant.",
                )
            })?
        }
    };
    let provider = model["providerID"].as_str().ok_or_else(|| {
        utils::agent_error("OpenCode v2 did not return a provider for its current model.")
    })?;
    let id = model["id"]
        .as_str()
        .ok_or_else(|| utils::agent_error("OpenCode v2 did not return its current model ID."))?;
    model_ref(&format!("{provider}/{id}"), variant).map(Some)
}

#[cfg(test)]
mod turn_model_tests {
    use super::*;

    #[tokio::test]
    async fn reasoning_uses_discovered_default_for_a_new_session() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let length = stream.read(&mut request).await.unwrap();
            assert!(
                String::from_utf8_lossy(&request[..length])
                    .contains("/api/model/default?location%5Bdirectory%5D=")
            );
            let body = r#"{"data":{"providerID":"fixture","id":"default"}}"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let api = Api {
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            url: Url::parse(&format!("http://{address}")).unwrap(),
            password: String::new(),
        };
        assert_eq!(
            resolve_turn_model(&api, Path::new("/fixture"), None, None, Some("high"))
                .await
                .unwrap(),
            Some(json!({"providerID":"fixture", "id":"default", "variant":"high"}))
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn reasoning_keeps_the_resumed_session_model() {
        let api = Api {
            client: reqwest::Client::new(),
            url: Url::parse("http://127.0.0.1:1").unwrap(),
            password: String::new(),
        };
        let model = resolve_turn_model(
            &api,
            Path::new("."),
            None,
            Some(json!({
                "providerID": "fixture", "id": "model", "variant": "low"
            })),
            Some("high"),
        )
        .await
        .unwrap();
        assert_eq!(
            model,
            Some(json!({"providerID":"fixture", "id":"model", "variant":"high"}))
        );
    }
}

#[cfg(test)]
mod attachment_tests {
    use std::sync::Mutex;

    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
        sync::Notify,
    };

    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    const JPEG: &[u8] = b"\xff\xd8\xff\xe0\0\x10JFIF";
    const GIF: &[u8] = b"GIF89a\x01\0\x01\0";
    const WEBP: &[u8] = b"RIFF\x1a\0\0\0WEBPVP8L";
    /// A complete, decodable 1x1 GIF (the constants above are headers only).
    const ONE_PIXEL_GIF: &[u8] = b"GIF89a\x01\0\x01\0\x80\0\0\xff\0\0\0\0\0!\xf9\x04\0\0\0\0\0,\0\0\0\0\x01\0\x01\0\0\x02\x02D\x01\0;";

    fn workspace(files: &[(&str, &[u8])]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (path, bytes) in files {
            let path = dir.path().join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        dir
    }

    fn file(cwd: &Path, relative: &str) -> Value {
        let path = dunce::canonicalize(cwd.join(relative)).unwrap();
        json!({
            "uri": Url::from_file_path(&path).unwrap().as_str(),
            "name": path.file_name().unwrap().to_str().unwrap(),
        })
    }

    fn agent(model: Option<&str>) -> OpencodeV2 {
        OpencodeV2 {
            append_prompt: AppendPrompt::default(),
            model: model.map(str::to_owned),
            variant: None,
            agent: None,
            auto_approve: false,
            cmd: CmdOverrides::default(),
            approvals: None,
        }
    }

    #[test]
    fn only_model_images_in_the_attachment_directory_are_attached() {
        let dir = workspace(&[
            (".vibe-attachments/a_shot.png", PNG),
            (".vibe-attachments/b_photo.jpg", JPEG),
            (".vibe-attachments/c_anim.gif", GIF),
            (".vibe-attachments/d_still.webp", WEBP),
            (".vibe-attachments/e_한글_화면.png", PNG),
            (".vibe-attachments/f_bitmap.bmp", b"BM\0\0\0\0"),
            (
                ".vibe-attachments/g_renamed.png",
                b"plain text, not an image",
            ),
            (".vibe-attachments/h_report.pdf", b"%PDF-1.7"),
            ("docs/outside.png", PNG),
            ("secret.png", PNG),
        ]);
        let cwd = dir.path();
        std::fs::create_dir(cwd.join(".vibe-attachments/i_folder.png")).unwrap();
        let big = std::fs::File::create(cwd.join(".vibe-attachments/j_big.png")).unwrap();
        std::io::Write::write_all(&mut &big, PNG).unwrap();
        big.set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            cwd.join("secret.png"),
            cwd.join(".vibe-attachments/k_link.png"),
        )
        .unwrap();
        let prompt = [
            "![shot.png](.vibe-attachments/a_shot.png)",
            "[photo.jpg](.vibe-attachments/b_photo.jpg) and ![again](.vibe-attachments/a_shot.png)",
            "![anim](.vibe-attachments/c_anim.gif) ![still](.vibe-attachments/d_still.webp)",
            "![한글 화면](.vibe-attachments/e_한글_화면.png)",
            "![bmp](.vibe-attachments/f_bitmap.bmp) ![renamed](.vibe-attachments/g_renamed.png)",
            "[report](.vibe-attachments/h_report.pdf) ![gone](.vibe-attachments/missing.png)",
            "![folder](.vibe-attachments/i_folder.png) ![big](.vibe-attachments/j_big.png)",
            "![link](.vibe-attachments/k_link.png) ![up](.vibe-attachments/../secret.png)",
            "![docs](docs/outside.png) ![abs](/etc/hosts) bare .vibe-attachments/a_shot.png",
        ]
        .join("\n");
        let images = chat_images(cwd, &prompt);
        assert_eq!(
            images,
            [
                ".vibe-attachments/a_shot.png",
                ".vibe-attachments/b_photo.jpg",
                ".vibe-attachments/c_anim.gif",
                ".vibe-attachments/d_still.webp",
                ".vibe-attachments/e_한글_화면.png",
            ]
            .map(|relative| file(cwd, relative))
        );
        assert!(images[4]["uri"].as_str().unwrap().contains("%ED%95%9C"));
        assert!(chat_images(cwd, "no attachments here").is_empty());
        assert!(chat_images(&cwd.join("docs"), &prompt).is_empty());
    }

    type Requests = Arc<Mutex<Vec<(String, Value)>>>;

    /// A stand-in for the local OpenCode v2 API with just enough session,
    /// event and prompt handling to run one turn. Records every request; with
    /// `refuse_images` it answers a prompt carrying files as OpenCode does for
    /// an image it cannot decode.
    async fn fake_opencode(refuse_images: bool) -> (Api, Requests) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let requests = Requests::default();
        let prompted = Arc::new(Notify::new());
        let seen = requests.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (seen, prompted) = (seen.clone(), prompted.clone());
                tokio::spawn(async move {
                    let (read, mut write) = stream.into_split();
                    let mut reader = BufReader::new(read);
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                            return;
                        }
                        let target = line.split(' ').take(2).collect::<Vec<_>>().join(" ");
                        let mut length = 0;
                        loop {
                            let mut header = String::new();
                            reader.read_line(&mut header).await.unwrap();
                            match header.trim().split_once(':') {
                                Some((name, value))
                                    if name.eq_ignore_ascii_case("content-length") =>
                                {
                                    length = value.trim().parse().unwrap()
                                }
                                Some(_) => {}
                                None => break,
                            }
                        }
                        let mut body = vec![0; length];
                        reader.read_exact(&mut body).await.unwrap();
                        let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        let refused = refuse_images && body.get("files").is_some();
                        seen.lock().unwrap().push((target.clone(), body));
                        if target == "GET /api/event" {
                            write
                                .write_all(
                                    b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n",
                                )
                                .await
                                .unwrap();
                            prompted.notified().await;
                            let done = r#"{"type":"session.execution.succeeded","data":{"sessionID":"ses_fixture"}}"#;
                            write
                                .write_all(format!("data: {done}\n\n").as_bytes())
                                .await
                                .unwrap();
                            return;
                        }
                        let (status, reply) = if refused {
                            (
                                "400 Bad Request",
                                r#"{"_tag":"InvalidRequestError","message":"Image could not be decoded: one.png","field":"files"}"#,
                            )
                        } else {
                            ("200 OK", r#"{"data":{"id":"ses_fixture","model":null}}"#)
                        };
                        if target.ends_with("/prompt") && !refused {
                            prompted.notify_one();
                        }
                        let response = format!(
                            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{reply}",
                            reply.len()
                        );
                        write.write_all(response.as_bytes()).await.unwrap();
                    }
                });
            }
        });
        let api = Api {
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            url,
            password: "fixture".into(),
        };
        (api, requests)
    }

    /// Run one turn against the stand-in; returns every prompt body sent and
    /// every request target, in order.
    async fn run_fake_turn(
        cwd: &Path,
        prompt: &str,
        id: Option<&str>,
        refuse_images: bool,
    ) -> (Vec<Value>, Vec<String>) {
        let (api, requests) = fake_opencode(refuse_images).await;
        let mut log = Vec::new();
        agent(None)
            .run_turn(
                &api,
                cwd,
                prompt.into(),
                id.map(str::to_owned),
                &CancellationToken::new(),
                &mut log,
            )
            .await
            .unwrap();
        let requests = requests.lock().unwrap().clone();
        let prompts = requests
            .iter()
            .filter(|(target, _)| target == "POST /api/session/ses_fixture/prompt")
            .map(|(_, body)| body.clone())
            .collect();
        (
            prompts,
            requests.into_iter().map(|(target, _)| target).collect(),
        )
    }

    async fn prompt_body(cwd: &Path, prompt: &str, id: Option<&str>) -> (Value, Vec<String>) {
        let (mut prompts, targets) = run_fake_turn(cwd, prompt, id, false).await;
        assert_eq!(prompts.len(), 1);
        (prompts.remove(0), targets)
    }

    #[tokio::test]
    async fn refused_images_fall_back_to_the_text_prompt_once() {
        let dir = workspace(&[(".vibe-attachments/one.png", PNG)]);
        let prompt = "Look ![one](.vibe-attachments/one.png)";
        let (prompts, _) = run_fake_turn(dir.path(), prompt, None, true).await;
        assert_eq!(
            prompts,
            [
                json!({"text": prompt, "delivery": "queue", "resume": true,
                       "files": [file(dir.path(), ".vibe-attachments/one.png")]}),
                json!({"text": prompt, "delivery": "queue", "resume": true}),
            ]
        );
    }

    #[tokio::test]
    async fn first_turn_sends_chat_images_with_the_prompt() {
        let dir = workspace(&[
            (".vibe-attachments/one.png", PNG),
            (".vibe-attachments/two.jpg", JPEG),
            (".vibe-attachments/three.bmp", b"BM\0\0"),
        ]);
        let prompt = "Compare\n![one](.vibe-attachments/one.png)\n![two](.vibe-attachments/two.jpg)\n\
                      ![three](.vibe-attachments/three.bmp)\n![four](.vibe-attachments/four.png)";
        let (body, targets) = prompt_body(dir.path(), prompt, None).await;
        assert_eq!(targets[0], "POST /api/session");
        assert_eq!(
            body,
            json!({
                "text": prompt, "delivery": "queue", "resume": true,
                "files": [file(dir.path(), ".vibe-attachments/one.png"), file(dir.path(), ".vibe-attachments/two.jpg")],
            })
        );
    }

    #[tokio::test]
    async fn resumed_turn_sends_chat_images_with_the_prompt() {
        let dir = workspace(&[(".vibe-attachments/next.webp", WEBP)]);
        let prompt = "Also this one ![next](.vibe-attachments/next.webp)";
        let (body, targets) = prompt_body(dir.path(), prompt, Some("ses_fixture")).await;
        assert_eq!(targets[0], "GET /api/session/ses_fixture");
        assert!(!targets.contains(&"POST /api/session".to_string()));
        assert_eq!(
            body["files"],
            json!([file(dir.path(), ".vibe-attachments/next.webp")])
        );
        assert_eq!(body["text"], prompt);
    }

    #[tokio::test]
    async fn prompt_without_images_keeps_the_text_only_body() {
        let dir = workspace(&[(".vibe-attachments/notes.txt", b"plain")]);
        for prompt in ["Just text", "See [notes](.vibe-attachments/notes.txt)"] {
            let (body, _) = prompt_body(dir.path(), prompt, None).await;
            assert_eq!(
                body,
                json!({"text": prompt, "delivery": "queue", "resume": true})
            );
        }
    }

    fn installed(root: &Path) -> (OpencodeV2, ExecutionEnv) {
        let mut agent = agent(
            std::env::var("VK_TEST_OPENCODE_V2_IMAGE_MODEL")
                .ok()
                .as_deref(),
        );
        agent.cmd.base_command_override =
            Some(std::env::var("VK_TEST_OPENCODE_V2_COMMAND").unwrap());
        let mut env = ExecutionEnv::new(Default::default(), false, String::new());
        for key in [
            "HOME",
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_CACHE_HOME",
            "XDG_STATE_HOME",
        ] {
            env.insert(key, root.join(key).to_str().unwrap());
        }
        env.insert("OPENCODE_DB", ":memory:");
        (agent, env)
    }

    /// 64x32 PNG: the left half red, the right half blue.
    fn red_blue_png() -> Vec<u8> {
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAN0lEQVR42u3PsQkAAAzDsPz/dHpDh2wCzwalybTxvgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+HY6S/hqZZnSdgAAAABJRU5ErkJggg==",
        )
        .unwrap()
    }

    #[tokio::test]
    #[ignore = "requires VK_TEST_OPENCODE_V2_COMMAND pointing to an installed OpenCode v2"]
    async fn installed_opencode_accepts_and_reads_chat_images() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let cwd = root.join("work space");
        std::fs::create_dir_all(cwd.join(".vibe-attachments")).unwrap();
        std::fs::write(cwd.join(".vibe-attachments/a_첫째.png"), red_blue_png()).unwrap();
        std::fs::write(cwd.join(".vibe-attachments/b_second.gif"), ONE_PIXEL_GIF).unwrap();
        std::fs::write(cwd.join(".vibe-attachments/e_corrupt.png"), PNG).unwrap();
        std::fs::write(cwd.join(".vibe-attachments/c_bitmap.bmp"), b"BM\0\0").unwrap();
        let (agent, env) = installed(&root);
        let (mut child, password) = agent.start_server(&cwd, &env).await.unwrap();
        let api = OpencodeV2::api(child.inner().stdout.take().unwrap(), password)
            .await
            .unwrap();
        let session: Data<Session> = Api::read(
            api.request(Method::POST, "/api/session")
                .json(&json!({"location":{"directory":cwd}})),
            "test session",
        )
        .await
        .unwrap();
        let path = session_path(&session.data.id).unwrap();
        let prompt = "![a](.vibe-attachments/a_첫째.png) ![b](.vibe-attachments/b_second.gif) \
                      ![c](.vibe-attachments/c_bitmap.bmp) ![d](.vibe-attachments/missing.png)";
        let files = chat_images(&cwd, prompt);
        assert_eq!(files.len(), 2);
        // resume=false queues the message in the session inbox without running a model.
        let queued: Data<Value> = Api::read(
            api.request(Method::POST, &format!("{path}/prompt")).json(
                &json!({"text": prompt, "files": files, "delivery": "queue", "resume": false}),
            ),
            "test prompt",
        )
        .await
        .unwrap();
        let stored = &queued.data["payload"]["files"];
        assert_eq!(stored[0]["mime"], "image/png");
        assert_eq!(
            stored[0]["data"],
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, red_blue_png())
        );
        assert_eq!(stored[1]["mime"], "image/gif");
        assert_eq!(stored[0]["name"], "a_첫째.png");
        // One attachment OpenCode cannot read or decode refuses the whole prompt:
        // why unreadable files are never sent and a refusal resends the text alone.
        for name in ["missing.png", "e_corrupt.png"] {
            let uri = Url::from_file_path(cwd.join(".vibe-attachments").join(name)).unwrap();
            let refused = api
                .request(Method::POST, &format!("{path}/prompt"))
                .json(&json!({"text": "x", "files": [{"uri": uri.as_str()}], "resume": false}))
                .send()
                .await
                .unwrap();
            assert_eq!(refused.status(), reqwest::StatusCode::BAD_REQUEST, "{name}");
        }
        drop(child.inner().stdin.take());
        let _ = tokio::time::timeout(REQUEST_TIMEOUT, child.wait()).await;
    }

    #[tokio::test]
    #[ignore = "calls a real model: set VK_TEST_OPENCODE_V2_COMMAND and VK_TEST_OPENCODE_V2_IMAGE_MODEL"]
    async fn installed_model_sees_chat_images_on_the_first_request() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let cwd = root.join("workspace");
        std::fs::create_dir_all(cwd.join(".vibe-attachments")).unwrap();
        std::fs::write(cwd.join(".vibe-attachments/swatch.png"), red_blue_png()).unwrap();
        let (agent, env) = installed(&root);
        let (mut child, password) = agent.start_server(&cwd, &env).await.unwrap();
        let api = OpencodeV2::api(child.inner().stdout.take().unwrap(), password)
            .await
            .unwrap();
        let mut log = Vec::new();
        let prompt = "![swatch](.vibe-attachments/swatch.png)\nWithout using any tools, look at the attached \
                      image and name the color of its left half and then its right half, as two lowercase \
                      words separated by a space.";
        agent
            .run_turn(
                &api,
                &cwd,
                prompt.into(),
                None,
                &CancellationToken::new(),
                &mut log,
            )
            .await
            .unwrap();
        drop(child.inner().stdin.take());
        let _ = tokio::time::timeout(REQUEST_TIMEOUT, child.wait()).await;
        let events: Vec<AcpEvent> = String::from_utf8(log)
            .unwrap()
            .lines()
            .map(|line| line.parse().unwrap())
            .collect();
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, AcpEvent::ToolCall(_))),
            "{events:?}"
        );
        let answer: String = events
            .iter()
            .filter_map(|event| match event {
                AcpEvent::Message(agent_client_protocol::ContentBlock::Text(text)) => {
                    Some(text.text.as_str())
                }
                _ => None,
            })
            .collect();
        println!("model answer: {answer}");
        assert!(answer.to_lowercase().contains("red blue"), "{answer}");
    }
}

#[async_trait]
impl StandardCodingAgentExecutor for OpencodeV2 {
    fn apply_overrides(&mut self, config: &ExecutorConfig) {
        if let Some(model) = &config.model_id {
            if self.model.as_ref() != Some(model) {
                self.variant = None;
            }
            self.model = Some(model.clone());
        }
        if let Some(variant) = &config.reasoning_id {
            self.variant = Some(variant.clone());
        }
        if let Some(agent) = &config.agent_id {
            self.agent = Some(agent.clone());
        }
        if let Some(policy) = &config.permission_policy {
            self.auto_approve =
                matches!(policy, PermissionPolicy::Auto | PermissionPolicy::DontAsk);
        }
    }

    fn use_approvals(&mut self, approvals: Arc<dyn ExecutorApprovalService>) {
        self.approvals = Some(approvals);
    }

    async fn spawn(
        &self,
        cwd: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        self.run(cwd, prompt, None, env).await
    }

    async fn spawn_follow_up(
        &self,
        cwd: &Path,
        prompt: &str,
        id: &str,
        reset: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        if reset.is_some() {
            return Err(ExecutorError::FollowUpNotSupported("OpenCode v2 supports native resume. Message-level rewind is unavailable in this executor.".into()));
        }
        self.run(cwd, prompt, Some(id), env).await
    }

    fn normalize_logs(&self, store: Arc<MsgStore>, cwd: &Path) -> Vec<tokio::task::JoinHandle<()>> {
        acp::normalize_logs(store, cwd)
    }

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        None
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        utils::agent_availability("opencode2", &self.cmd)
    }

    fn get_preset_options(&self) -> ExecutorConfig {
        let mut config = ExecutorConfig::new(BaseCodingAgent::OpencodeV2);
        config.model_id = self.model.clone();
        config.agent_id = self.agent.clone();
        config.reasoning_id = self.variant.clone();
        config.permission_policy = Some(if self.auto_approve {
            PermissionPolicy::Auto
        } else {
            PermissionPolicy::Supervised
        });
        config
    }

    async fn discover_options(
        &self,
        workdir: Option<&Path>,
        repo_path: Option<&Path>,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        let cwd = utils::discovery_dir(workdir, repo_path);
        let executor = self.clone();
        Ok(Box::pin(futures::stream::once(async move {
            let mut options = ExecutorDiscoveredOptions::default();
            match executor.discover(cwd).await {
                Ok(config) => options.model_selector = config,
                Err(err) => options.error = Some(err.to_string()),
            }
            patch::executor_discovered_options(options)
        })))
    }
}
