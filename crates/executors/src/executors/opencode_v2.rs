use std::{
    collections::{HashMap, HashSet},
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
    approvals::{ApprovalStatus, QuestionAnswer, QuestionStatus},
    command_ext::GroupSpawnNoWindowExt,
    msg_store::MsgStore,
    path::VIBE_ATTACHMENTS_DIR,
};

use super::{
    AppendPrompt, AvailabilityInfo, BaseCodingAgent, ExecutorError, ExecutorExitResult,
    SlashCommandDescription, SpawnedChild, StandardCodingAgentExecutor,
    acp::{self, AcpEvent, ApprovalResponse},
    opencode::sdk::generate_server_password,
    utils::{self, SlashCommandCall, parse_slash_command, reorder_slash_commands},
};
use crate::{
    approvals::ExecutorApprovalService,
    command::CmdOverrides,
    env::{CommitReminder, ExecutionEnv},
    executor_discovery::ExecutorDiscoveredOptions,
    logs::{
        AnsweredQuestion, AskUserQuestionItem, AskUserQuestionOption, TokenUsageInfo, utils::patch,
    },
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
/// Compaction has its own endpoint; OpenCode lists only prompt commands.
const COMPACT: &str = "compact";
/// OpenCode's primary agent when neither the profile nor the session picks one.
const DEFAULT_AGENT: &str = "build";
const NO_ANSWER: &str = "The user cannot answer questions in this run. Continue with your best judgment and state the assumptions you make.";
const UNSUPPORTED_FORM: &str =
    "This form cannot be answered in Vibe Kanban's chat. Ask in plain text instead.";
const INVALID_ANSWER: &str =
    "The user's answer did not fit the requested format. Ask again in plain text.";
const GENERATE_TIMEOUT: Duration = Duration::from_secs(90);
/// OpenCode refuses the whole prompt when one attachment is larger.
const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
/// OpenCode decodes and resizes images before admitting a prompt: about one
/// second per 20 MiB image on 2.4.1. A timeout would fail a turn it may start.
const IMAGE_PROMPT_TIMEOUT: Duration = Duration::from_secs(60);
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
    /// Deny the question tool and decline any form (unattended runs). Tool
    /// approvals still follow `auto_approve`.
    #[serde(default)]
    pub dont_ask: bool,
    #[serde(flatten)]
    pub cmd: CmdOverrides,
    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    pub approvals: Option<Arc<dyn ExecutorApprovalService>>,
    /// A requested policy this executor cannot honour; the turn is refused
    /// rather than run under a different one.
    #[serde(skip)]
    #[ts(skip)]
    #[derivative(PartialEq = "ignore")]
    pub unsupported_policy: Option<PermissionPolicy>,
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

    async fn events(&self, kinds: &[&str]) -> Result<reqwest::Response, ExecutorError> {
        let mut request = self.request(Method::GET, "/api/event");
        for kind in kinds {
            request = request.query(&[("types", kind)]);
        }
        tokio::time::timeout(
            REQUEST_TIMEOUT,
            Self::checked(request, "event subscription"),
        )
        .await
        .map_err(|_| utils::agent_error("OpenCode v2 event subscription timed out."))?
    }

    async fn commands(&self, cwd: &Path) -> Result<Vec<CommandInfo>, ExecutorError> {
        let directory = cwd.to_string_lossy();
        Self::read::<Data<Vec<CommandInfo>>>(
            self.request(Method::GET, "/api/command")
                .query(&[("location[directory]", directory.as_ref())]),
            "command discovery",
        )
        .await
        .map(|commands| commands.data)
    }

    /// Context windows by provider and model. Unknown when the list fails.
    async fn model_limits(&self, cwd: &Path) -> HashMap<ModelKey, u32> {
        let directory = cwd.to_string_lossy();
        let Ok(models) = Self::read::<Data<Vec<Value>>>(
            self.request(Method::GET, "/api/model")
                .query(&[("location[directory]", directory.as_ref())]),
            "model limits",
        )
        .await
        else {
            return HashMap::new();
        };
        models
            .data
            .iter()
            .filter_map(|model| {
                let window = model["limit"]["context"].as_u64()?;
                Some((model_key(model)?, u32::try_from(window).ok()?))
            })
            .collect()
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
                    .timeout(IMAGE_PROMPT_TIMEOUT)
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
    agent: Option<String>,
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
struct CommandInfo {
    name: String,
    description: Option<String>,
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

    async fn discover(
        &self,
        cwd: PathBuf,
    ) -> Result<(ModelSelectorConfig, Vec<SlashCommandDescription>), ExecutorError> {
        let env = ExecutionEnv::new(Default::default(), false, String::new());
        let (mut child, password) = self.start_server(&cwd, &env).await?;
        let stdout = child.inner().stdout.take().expect("piped stdout");
        let result = async {
            let api = Self::api(stdout, password).await?;
            let directory = cwd.to_string_lossy();
            let location = [("location[directory]", directory.as_ref())];
            // Location startup publishes model and command updates as plugins settle.
            let event_stream = api
                .events(&["model.updated", "command.updated"])
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
            let (models, default, providers, agents, commands) = tokio::try_join!(
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
                api.commands(&cwd),
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
            let commands = reorder_slash_commands(
                std::iter::once(SlashCommandDescription {
                    name: COMPACT.into(),
                    description: Some("Compact the session".into()),
                })
                .chain(commands.into_iter().map(|command| {
                    SlashCommandDescription {
                        name: command.name,
                        description: command.description,
                    }
                })),
            );
            let selector = ModelSelectorConfig {
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
                permissions: vec![
                    PermissionPolicy::Supervised,
                    PermissionPolicy::Auto,
                    PermissionPolicy::DontAsk,
                ],
            };
            Ok((selector, commands))
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
        utils::refuse_unsupported(
            "OpenCode v2",
            &self.unsupported_policy,
            "Supervised, Auto or Don't Ask, or select OpenCode's plan agent",
        )?;
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
        let input = match parse_slash_command::<SlashCommandCall<'_>>(prompt) {
            Some(call) => TurnInput::Command {
                text: prompt.to_owned(),
                name: call.name,
                arguments: call.arguments.to_owned(),
            },
            None => TurnInput::Prompt(self.append_prompt.combine_prompt(prompt)),
        };
        let reminder = reminder_for(&input, env);
        tokio::spawn(async move {
            let result = async {
                let api = tokio::select! {
                    _ = turn_cancel.cancelled() => return Ok(()),
                    api = Self::api(stdout, password) => api?,
                };
                executor
                    .run_turn(&api, &cwd, input, id, reminder, &turn_cancel, &mut writer)
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

    /// Session rules for the selected policy, recomputed every turn.
    async fn session_permissions(
        &self,
        api: &Api,
        cwd: &Path,
        agent: Option<&str>,
    ) -> Result<Vec<Value>, ExecutorError> {
        let agent_rules = if self.auto_approve {
            Vec::new()
        } else {
            let agent = self.agent.as_deref().or(agent).unwrap_or(DEFAULT_AGENT);
            if !valid_id(agent) {
                return Err(utils::agent_error("Invalid OpenCode v2 agent ID."));
            }
            let directory = cwd.to_string_lossy();
            let agent: Data<Value> = Api::read(
                api.request(Method::GET, &format!("/api/agent/{agent}"))
                    .query(&[("location[directory]", directory.as_ref())]),
                "agent permissions",
            )
            .await?;
            agent.data["permissions"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        };
        Ok(permission_rules(
            !self.auto_approve,
            self.dont_ask,
            &agent_rules,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_turn(
        &self,
        api: &Api,
        cwd: &Path,
        input: TurnInput,
        id: Option<String>,
        reminder: Option<CommitReminder>,
        cancel: &CancellationToken,
        writer: &mut (impl AsyncWrite + Unpin),
    ) -> Result<(), ExecutorError> {
        if let TurnInput::Command { name, .. } = &input {
            let unavailable = if name == COMPACT {
                id.is_none()
                    .then(|| "_No session available to compact yet._".to_owned())
            } else {
                let commands = tokio::select! {
                    _ = cancel.cancelled() => return Ok(()),
                    commands = api.commands(cwd) => commands?,
                };
                (!commands.iter().any(|command| &command.name == name))
                    .then(|| format!("_Command not found: `/{name}`_"))
            };
            if let Some(message) = unavailable {
                if let Some(id) = &id {
                    AcpEvent::SessionStart(id.clone()).write_to(writer).await?;
                }
                AcpEvent::User(input.text().to_owned())
                    .write_to(writer)
                    .await?;
                AcpEvent::text(&message).write_to(writer).await?;
                return AcpEvent::Done("end_turn".into()).write_to(writer).await;
            }
        }
        let explicit_model = self
            .model
            .as_deref()
            .map(|model| model_ref(model, self.variant.as_deref()))
            .transpose()?;
        let resumed = id.is_some();
        let (session, model) = tokio::select! {
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
                    let permissions = self.session_permissions(api, cwd, session.data.agent.as_deref()).await?;
                    Api::checked(api.request(Method::PATCH, &path).timeout(REQUEST_TIMEOUT)
                        .json(&json!({"permissions": permissions})), "session permissions").await?;
                    let model = model.or(session.data.model.clone());
                    Ok::<_, ExecutorError>((session.data, model))
                } else {
                    let model = resolve_turn_model(api, cwd, explicit_model, None, self.variant.as_deref()).await?;
                    let permissions = self.session_permissions(api, cwd, None).await?;
                    let created: Data<Session> = Api::read(api.request(Method::POST, "/api/session")
                        .json(&json!({"location":{"directory":cwd}, "model":model, "agent":self.agent, "permissions":permissions})), "session creation").await?;
                    let model = model.or(created.data.model.clone());
                    Ok((created.data, model))
                }
            } => session?,
        };
        let path = session_path(&session.id)?;
        AcpEvent::SessionStart(session.id.clone())
            .write_to(writer)
            .await?;
        AcpEvent::User(input.text().to_owned())
            .write_to(writer)
            .await?;
        let mut usage = ContextUsage {
            limits: api.model_limits(cwd).await,
            step_models: HashMap::new(),
        };
        let baseline = match resumed {
            true => {
                let context: Option<Data<Vec<Value>>> = Api::read(
                    api.request(Method::GET, &format!("{path}/context")),
                    "context",
                )
                .await
                .ok();
                usage.baseline(context.map(|c| c.data).as_deref(), model.as_ref())
            }
            false => UNKNOWN_USAGE,
        };
        AcpEvent::TokenUsage(baseline).write_to(writer).await?;
        let mut reminder = reminder;
        let turn = async {
            let response = api.events(&[]).await?;
            let events = response.bytes_stream().eventsource();
            futures::pin_mut!(events);
            // The SSE connection is established before sending the input.
            match &input {
                TurnInput::Prompt(text) => {
                    let mut body = json!({"text":text, "delivery":"queue", "resume":true});
                    let images = chat_images(cwd, text);
                    if !images.is_empty() {
                        body["files"] = Value::Array(images);
                    }
                    api.prompt(&format!("{path}/prompt"), body).await?;
                }
                TurnInput::Command { name, .. } if name == COMPACT => {
                    api.post(
                        &format!("{path}/compact"),
                        json!({"delivery":"queue"}),
                        "compaction",
                    )
                    .await?;
                }
                TurnInput::Command {
                    name, arguments, ..
                } => {
                    let response = api
                        .request(Method::POST, &format!("{path}/command"))
                        .timeout(REQUEST_TIMEOUT)
                        .json(&json!({"name":name, "text":arguments, "delivery":"queue"}))
                        .send()
                        .await
                        .map_err(|_| {
                            utils::agent_error(
                                "OpenCode v2 command could not reach the local server.",
                            )
                        })?;
                    let status = response.status();
                    if !status.is_success() {
                        // A command that rejects its input (for example `/goal pause`
                        // with no goal) answers with its own message, not a login problem.
                        let body: Value = response.json().await.unwrap_or(Value::Null);
                        let Some(message) = (body["_tag"] == "CommandExecutionError")
                            .then(|| body["message"].as_str())
                            .flatten()
                        else {
                            return Err(utils::agent_error(format!(
                                "OpenCode v2 command failed (HTTP {status})."
                            )));
                        };
                        AcpEvent::text(&format!("_/{name}: {message}_"))
                            .write_to(writer)
                            .await?;
                        return AcpEvent::Done("end_turn".into()).write_to(writer).await;
                    }
                }
            }
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
                    "session.step.started" | "session.step.ended" | "session.compaction.ended" => {
                        if let Some(info) = usage.observe(&event) {
                            AcpEvent::TokenUsage(info).write_to(writer).await?;
                        }
                    }
                    "session.execution.succeeded" => {
                        if let Some(text) = match reminder.take() {
                            Some(reminder) => reminder.prompt().await,
                            None => None,
                        } {
                            AcpEvent::System(text.clone()).write_to(writer).await?;
                            api.post(
                                &format!("{path}/prompt"),
                                json!({"text":text, "delivery":"queue", "resume":true}),
                                "commit reminder",
                            )
                            .await?;
                            continue;
                        }
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
                        self.reply_form(api, &path, &event.data["form"], cancel, writer)
                            .await?
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

    /// OpenCode's question tool asks through a form. Under Don't Ask, or for
    /// fields this chat cannot render, the form is declined with a reason the
    /// agent can act on.
    async fn reply_form(
        &self,
        api: &Api,
        path: &str,
        form: &Value,
        cancel: &CancellationToken,
        writer: &mut (impl AsyncWrite + Unpin),
    ) -> Result<(), ExecutorError> {
        let id = form["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| utils::agent_error("OpenCode v2 returned an invalid form ID."))?;
        let decline = |message: &'static str| async move {
            Api::checked(
                api.request(Method::DELETE, &format!("{path}/form/{id}"))
                    .query(&[("message", message)])
                    .timeout(REQUEST_TIMEOUT),
                "form reply",
            )
            .await
            .map(|_| ())
        };
        let approvals = match &self.approvals {
            Some(approvals) if !self.dont_ask => approvals,
            _ => return decline(NO_ANSWER).await,
        };
        let Some(fields) = form_questions(form) else {
            return decline(UNSUPPORTED_FORM).await;
        };
        let tool_id = tool_call_id(
            form["metadata"]["tool"]["messageID"].as_str(),
            form["metadata"]["tool"]["id"].as_str(),
        )
        .unwrap_or_else(|| id.to_owned());
        let title = form["title"].as_str().unwrap_or("Question");
        let questions: Vec<_> = fields.iter().map(|field| field.item.clone()).collect();
        AcpEvent::ToolUpdate(ToolCallUpdate::new(
            tool_id.clone(),
            ToolCallUpdateFields::new()
                .title(title)
                .status(ToolCallStatus::Pending)
                .raw_input(Value::Object(serde_json::Map::from_iter([(
                    acp::QUESTIONS_KEY.to_owned(),
                    json!(questions),
                )]))),
        ))
        .write_to(writer)
        .await?;
        let approval_id = approvals
            .create_question_approval(title, questions.len())
            .await?;
        AcpEvent::ApprovalRequested {
            tool_call_id: tool_id.clone(),
            approval_id: approval_id.clone(),
        }
        .write_to(writer)
        .await?;
        let answers = match approvals
            .wait_question_answer(&approval_id, cancel.clone())
            .await?
        {
            QuestionStatus::Answered { answers } => answers,
            QuestionStatus::TimedOut => return decline(NO_ANSWER).await,
        };
        let Some(answer) = form_answer(&fields, &answers) else {
            return decline(INVALID_ANSWER).await;
        };
        api.post(
            &format!("{path}/form/{id}/reply"),
            json!({ "answer": answer }),
            "form reply",
        )
        .await?;
        AcpEvent::QuestionAnswered {
            tool_call_id: tool_id,
            answers: answers
                .into_iter()
                .map(|answer| AnsweredQuestion {
                    question: answer.question,
                    answer: answer.answer,
                })
                .collect(),
        }
        .write_to(writer)
        .await
    }
}

enum TurnInput {
    Prompt(String),
    Command {
        text: String,
        name: String,
        arguments: String,
    },
}

impl TurnInput {
    fn text(&self) -> &str {
        match self {
            Self::Prompt(text) | Self::Command { text, .. } => text,
        }
    }
}

type ModelKey = (String, String);

fn model_key(model: &Value) -> Option<ModelKey> {
    Some((
        model["providerID"].as_str()?.to_owned(),
        model["id"].as_str()?.to_owned(),
    ))
}

/// Tokens in the context the step's request sent plus its reply, as the
/// OpenCode TUI counts them.
fn context_tokens(tokens: &Value) -> u64 {
    ["input", "output", "reasoning"]
        .iter()
        .map(|key| &tokens[*key])
        .chain([&tokens["cache"]["read"], &tokens["cache"]["write"]])
        .filter_map(Value::as_f64)
        .map(|value| value.max(0.0) as u64)
        .sum()
}

/// Compaction edits nothing, so there is nothing to remind about after it.
fn reminder_for(input: &TurnInput, env: &ExecutionEnv) -> Option<CommitReminder> {
    CommitReminder::from_env(env)
        .filter(|_| !matches!(input, TurnInput::Command { name, .. } if name == COMPACT))
}

/// The context gauge for one turn: the last step's tokens against the window
/// of the model that ran it.
struct ContextUsage {
    limits: HashMap<ModelKey, u32>,
    step_models: HashMap<String, ModelKey>,
}

const UNKNOWN_USAGE: TokenUsageInfo = TokenUsageInfo {
    total_tokens: 0,
    model_context_window: 0,
};

impl ContextUsage {
    fn info(&self, tokens: u64, model: Option<&ModelKey>) -> TokenUsageInfo {
        match model.and_then(|model| self.limits.get(model)) {
            Some(&window) if tokens > 0 && window > 0 => TokenUsageInfo {
                total_tokens: u32::try_from(tokens).unwrap_or(u32::MAX),
                model_context_window: window,
            },
            _ => UNKNOWN_USAGE,
        }
    }

    /// Usage left by earlier turns: the last measured reply after the last
    /// compaction, shown only if the same model runs this turn. A switched
    /// model or a compacted context is unknown until the next reply.
    fn baseline(&self, context: Option<&[Value]>, model: Option<&Value>) -> TokenUsageInfo {
        let Some(last) = context.and_then(|messages| {
            messages
                .iter()
                .rev()
                .take_while(|message| message["type"] != "compaction")
                .find(|message| message["type"] == "assistant" && message["tokens"].is_object())
        }) else {
            return UNKNOWN_USAGE;
        };
        let measured = model_key(&last["model"]);
        if measured.is_none() || measured != model.and_then(model_key) {
            return UNKNOWN_USAGE;
        }
        self.info(context_tokens(&last["tokens"]), measured.as_ref())
    }

    fn observe(&mut self, event: &Event) -> Option<TokenUsageInfo> {
        let data = &event.data;
        match event.kind.as_str() {
            "session.step.started" => {
                let id = data["assistantMessageID"].as_str()?;
                self.step_models
                    .insert(id.to_owned(), model_key(&data["model"])?);
                None
            }
            "session.step.ended" => {
                let model = self.step_models.get(data["assistantMessageID"].as_str()?);
                Some(self.info(context_tokens(&data["tokens"]), model))
            }
            // The summary replaces the context; its size is known after the next reply.
            "session.compaction.ended" => Some(UNKNOWN_USAGE),
            _ => None,
        }
    }
}

/// Supervised asks before these actions unless an explicit rule decides.
const SUPERVISED_ACTIONS: [&str; 6] = [
    "edit",
    "write",
    "shell",
    "webfetch",
    "websearch",
    "external_directory",
];

fn rule(action: &str, effect: &str) -> Value {
    json!({"action": action, "resource": "*", "effect": effect})
}

/// Session rules apply after the agent's own, the last match winning. An
/// allow-all session rule would override the user's deny rules, so Auto and
/// Don't Ask add none and approve each request that still asks instead.
/// Supervised replaces only the agent's catch-all allow: its other rules,
/// which include the user's configured ones, follow the asks again so an
/// explicit allow or deny keeps deciding.
fn permission_rules(supervised: bool, dont_ask: bool, agent_rules: &[Value]) -> Vec<Value> {
    let mut rules = Vec::new();
    if supervised {
        rules.extend(SUPERVISED_ACTIONS.iter().map(|action| rule(action, "ask")));
        rules.extend(
            agent_rules
                .iter()
                .filter(|rule| {
                    !(rule["action"] == "*" && rule["resource"] == "*" && rule["effect"] == "allow")
                })
                .cloned(),
        );
    }
    if dont_ask {
        rules.push(rule("question", "deny"));
    }
    rules
}

#[derive(Clone)]
enum FieldKind {
    Text,
    Choice,
    Multi,
    Boolean,
    Number { integer: bool },
}

#[derive(Clone)]
struct FormField {
    key: String,
    kind: FieldKind,
    /// Option labels with the values OpenCode expects back.
    values: Vec<(String, String)>,
    when: Vec<Value>,
    item: AskUserQuestionItem,
}

/// The form's visible fields as chat questions, or `None` when one of them
/// cannot be answered in the chat (an external link).
fn form_questions(form: &Value) -> Option<Vec<FormField>> {
    let mut fields = Vec::new();
    for field in form["fields"].as_array()? {
        if field["hidden"] == true {
            continue;
        }
        let key = field["key"].as_str()?.to_owned();
        let title = field["title"].as_str();
        let question = field["description"]
            .as_str()
            .or(title)
            .unwrap_or(&key)
            .to_owned();
        let options: Vec<(String, String, String)> = field["options"]
            .as_array()
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| {
                        let value = option["value"].as_str()?;
                        Some((
                            option["label"].as_str().unwrap_or(value).to_owned(),
                            value.to_owned(),
                            option["description"]
                                .as_str()
                                .unwrap_or_default()
                                .to_owned(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let custom = field["custom"] == true;
        let (kind, options, allow_custom) = match field["type"].as_str()? {
            "string" if options.is_empty() => (FieldKind::Text, options, true),
            "string" => (FieldKind::Choice, options, custom),
            "multiselect" => (FieldKind::Multi, options, custom),
            "boolean" => (
                FieldKind::Boolean,
                vec![
                    ("Yes".into(), "true".into(), String::new()),
                    ("No".into(), "false".into(), String::new()),
                ],
                false,
            ),
            kind @ ("number" | "integer") => (
                FieldKind::Number {
                    integer: kind == "integer",
                },
                Vec::new(),
                true,
            ),
            _ => return None,
        };
        fields.push(FormField {
            key,
            kind: kind.clone(),
            values: options
                .iter()
                .map(|(label, value, _)| (label.clone(), value.clone()))
                .collect(),
            when: field["when"].as_array().cloned().unwrap_or_default(),
            item: AskUserQuestionItem {
                question,
                header: title
                    .or(form["title"].as_str())
                    .unwrap_or("Question")
                    .to_owned(),
                options: options
                    .into_iter()
                    .map(|(label, _, description)| AskUserQuestionOption { label, description })
                    .collect(),
                multi_select: matches!(kind, FieldKind::Multi),
                allow_custom_answer: Some(allow_custom),
            },
        });
    }
    (!fields.is_empty()).then_some(fields)
}

/// The form reply for the chat's answers. Fields whose `when` conditions do
/// not hold are left out; `None` when a number answer is not a number.
fn form_answer(fields: &[FormField], answers: &[QuestionAnswer]) -> Option<Value> {
    let mut answer = serde_json::Map::new();
    for field in fields {
        let Some(chosen) = answers
            .iter()
            .find(|answer| answer.question == field.item.question)
        else {
            continue;
        };
        let value = |label: &String| {
            field
                .values
                .iter()
                .find(|(option, _)| option == label)
                .map_or_else(|| label.clone(), |(_, value)| value.clone())
        };
        let first = chosen.answer.first();
        let value = match field.kind {
            FieldKind::Multi => json!(chosen.answer.iter().map(value).collect::<Vec<_>>()),
            FieldKind::Text | FieldKind::Choice => match first {
                Some(label) => json!(value(label)),
                None => continue,
            },
            FieldKind::Boolean => match first.map(value).as_deref() {
                Some("true") => json!(true),
                Some("false") => json!(false),
                _ => return None,
            },
            FieldKind::Number { integer } => {
                let text = first?.trim();
                if integer {
                    json!(text.parse::<i64>().ok()?)
                } else {
                    json!(text.parse::<f64>().ok().filter(|n| n.is_finite())?)
                }
            }
        };
        answer.insert(field.key.clone(), value);
    }
    for field in fields {
        // An unanswered field makes both operators false; against a
        // multiselect answer they test whether the selection includes the value.
        let holds = field.when.iter().all(|condition| {
            let Some(other) = condition["key"].as_str().and_then(|key| answer.get(key)) else {
                return false;
            };
            let equal = match other {
                Value::Array(selected) => selected.contains(&condition["value"]),
                other => other == &condition["value"],
            };
            match condition["op"].as_str() {
                Some("eq") => equal,
                Some("neq") => !equal,
                _ => true,
            }
        });
        if !holds {
            answer.remove(&field.key);
        }
    }
    Some(Value::Object(answer))
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
    // The directory itself must stay in the workspace too: it could be a symlink.
    let (Ok(base), Ok(root)) = (
        dunce::canonicalize(cwd),
        dunce::canonicalize(cwd.join(VIBE_ATTACHMENTS_DIR)),
    ) else {
        return Vec::new();
    };
    if !root.starts_with(&base) {
        return Vec::new();
    }
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
        assert_eq!(dirs, std::slice::from_ref(&dir));
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
            dont_ask: false,
            cmd: CmdOverrides {
                base_command_override: Some(std::env::var("VK_TEST_OPENCODE_V2_COMMAND").unwrap()),
                ..Default::default()
            },
            approvals: None,
            unsupported_policy: None,
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
            dont_ask: false,
            cmd: CmdOverrides::default(),
            approvals: None,
            unsupported_policy: None,
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

    #[cfg(unix)]
    #[test]
    fn a_symlinked_attachment_directory_cannot_reach_outside_the_workspace() {
        let outside = workspace(&[("elsewhere/leak.png", PNG)]);
        let dir = workspace(&[]);
        std::os::unix::fs::symlink(
            outside.path().join("elsewhere"),
            dir.path().join(VIBE_ATTACHMENTS_DIR),
        )
        .unwrap();
        assert!(chat_images(dir.path(), "![leak](.vibe-attachments/leak.png)").is_empty());
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
                TurnInput::Prompt(prompt.into()),
                id.map(str::to_owned),
                None,
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
        assert!(targets.contains(&"POST /api/session".to_string()));
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
                TurnInput::Prompt(prompt.into()),
                None,
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
            self.dont_ask = matches!(policy, PermissionPolicy::DontAsk);
            self.unsupported_policy =
                matches!(policy, PermissionPolicy::Plan).then_some(PermissionPolicy::Plan);
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

    /// `generate` answers from the session's context without changing its
    /// history; its tokens count toward the session.
    async fn generate_commit_message(
        &self,
        cwd: &Path,
        session_id: &str,
        instructions: &str,
        env: &ExecutionEnv,
    ) -> Result<Option<String>, ExecutorError> {
        let path = session_path(session_id)?;
        let (mut child, password) = self.start_server(cwd, env).await?;
        let stdout = child.inner().stdout.take().expect("piped stdout");
        let result = async {
            let api = Self::api(stdout, password).await?;
            let generated: Data<Value> = Api::checked(
                api.request(Method::POST, &format!("{path}/generate"))
                    .timeout(GENERATE_TIMEOUT)
                    .json(&json!({ "prompt": instructions })),
                "commit message generation",
            )
            .await?
            .json()
            .await
            .map_err(|_| utils::agent_error("Unexpected OpenCode v2 generation response."))?;
            Ok(generated.data["text"].as_str().map(str::to_owned))
        }
        .await;
        let _ = child.kill().await;
        result
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
        config.permission_policy = Some(match (self.auto_approve, self.dont_ask) {
            (true, true) => PermissionPolicy::DontAsk,
            (true, false) => PermissionPolicy::Auto,
            (false, _) => PermissionPolicy::Supervised,
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
                Ok((config, commands)) => {
                    options.model_selector = config;
                    options.slash_commands = commands;
                }
                Err(err) => options.error = Some(err.to_string()),
            }
            patch::executor_discovered_options(options)
        })))
    }
}

#[cfg(test)]
mod turn_tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::mpsc,
    };

    use super::*;
    use crate::{approvals::ExecutorApprovalError, env::RepoContext};

    #[derive(Debug, Clone)]
    struct Request {
        method: String,
        path: String,
        body: Value,
    }

    type Handler = dyn Fn(&Request, &mpsc::UnboundedSender<Value>) -> (u16, Value) + Send + Sync;

    /// A local OpenCode v2 API: one request per connection, events on the
    /// open `/api/event` stream.
    struct MockServer {
        api: Api,
        requests: Arc<Mutex<Vec<Request>>>,
    }

    impl MockServer {
        async fn start(handler: Box<Handler>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            // Events go to the newest subscription; a finished turn's stream is gone.
            let (events_tx, mut events_rx) = mpsc::unbounded_channel::<Value>();
            let sink: Arc<Mutex<Option<mpsc::UnboundedSender<Value>>>> = Arc::default();
            let current = sink.clone();
            tokio::spawn(async move {
                while let Some(event) = events_rx.recv().await {
                    if let Some(sink) = current.lock().unwrap().as_ref() {
                        let _ = sink.send(event);
                    }
                }
            });
            let handler: Arc<Handler> = Arc::from(handler);
            let log = requests.clone();
            tokio::spawn(async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let (handler, log, events_tx, sink) = (
                        handler.clone(),
                        log.clone(),
                        events_tx.clone(),
                        sink.clone(),
                    );
                    tokio::spawn(async move {
                        let mut buffer = Vec::new();
                        let mut chunk = [0; 8192];
                        let head_end = loop {
                            let read = stream.read(&mut chunk).await.unwrap();
                            if read == 0 {
                                return;
                            }
                            buffer.extend_from_slice(&chunk[..read]);
                            if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                                break end + 4;
                            }
                        };
                        let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
                        let length = head
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|value| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        while buffer.len() < head_end + length {
                            let read = stream.read(&mut chunk).await.unwrap();
                            buffer.extend_from_slice(&chunk[..read]);
                        }
                        let mut line = head.lines().next().unwrap().split(' ');
                        let request = Request {
                            method: line.next().unwrap().to_owned(),
                            path: line.next().unwrap().to_owned(),
                            body: serde_json::from_slice(&buffer[head_end..head_end + length])
                                .unwrap_or(Value::Null),
                        };
                        log.lock().unwrap().push(request.clone());
                        if request.path.starts_with("/api/event") {
                            stream
                                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\n")
                                .await
                                .unwrap();
                            let (tx, mut events) = mpsc::unbounded_channel();
                            *sink.lock().unwrap() = Some(tx);
                            while let Some(event) = events.recv().await {
                                let frame = format!("data: {event}\n\n");
                                if stream.write_all(frame.as_bytes()).await.is_err() {
                                    return;
                                }
                            }
                            return;
                        }
                        let (status, body) = handler(&request, &events_tx);
                        let body = if body.is_null() {
                            String::new()
                        } else {
                            body.to_string()
                        };
                        let response = format!(
                            "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                    });
                }
            });
            Self {
                api: Api {
                    client: reqwest::Client::builder().no_proxy().build().unwrap(),
                    url: Url::parse(&format!("http://{address}")).unwrap(),
                    password: String::new(),
                },
                requests,
            }
        }

        fn requests(&self, method: &str, prefix: &str) -> Vec<Request> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.method == method && request.path.starts_with(prefix))
                .cloned()
                .collect()
        }
    }

    fn event(kind: &str, data: Value) -> Value {
        json!({"id": "evt_fixture", "type": kind, "data": data})
    }

    fn step(id: &str, model: &str) -> Value {
        event(
            "session.step.started",
            json!({"sessionID": "ses_fixture", "assistantMessageID": id, "agent": "build",
                   "model": {"providerID": "fixture", "id": model}, "started": 1}),
        )
    }

    fn step_end(id: &str, input: u64, read: u64) -> Value {
        event(
            "session.step.ended",
            json!({"sessionID": "ses_fixture", "assistantMessageID": id, "finish": "stop", "cost": 0,
                   "tokens": {"input": input, "output": 20, "reasoning": 5, "cache": {"read": read, "write": 10}}}),
        )
    }

    fn done() -> Value {
        event(
            "session.execution.succeeded",
            json!({"sessionID": "ses_fixture"}),
        )
    }

    fn models() -> Value {
        json!({"data": [
            {"providerID": "fixture", "id": "small", "limit": {"context": 1000, "output": 100}},
            {"providerID": "fixture", "id": "large", "limit": {"context": 4000, "output": 100}}
        ]})
    }

    fn agent() -> Value {
        json!({"data": {"id": "build", "permissions": [
            {"action": "*", "resource": "*", "effect": "allow"},
            {"action": "question", "resource": "*", "effect": "allow"},
            {"action": "shell", "resource": "rm *", "effect": "deny"}
        ]}})
    }

    struct Approvals {
        tool: ApprovalStatus,
        question: Option<QuestionStatus>,
    }

    #[async_trait]
    impl ExecutorApprovalService for Approvals {
        async fn create_tool_approval(&self, _: &str) -> Result<String, ExecutorApprovalError> {
            Ok("approval-tool".into())
        }
        async fn create_question_approval(
            &self,
            _: &str,
            _: usize,
        ) -> Result<String, ExecutorApprovalError> {
            Ok("approval-question".into())
        }
        async fn wait_tool_approval(
            &self,
            _: &str,
            _: CancellationToken,
        ) -> Result<ApprovalStatus, ExecutorApprovalError> {
            Ok(self.tool.clone())
        }
        async fn wait_question_answer(
            &self,
            _: &str,
            _: CancellationToken,
        ) -> Result<QuestionStatus, ExecutorApprovalError> {
            self.question
                .clone()
                .ok_or(ExecutorApprovalError::ServiceUnavailable)
        }
    }

    fn executor(policy: PermissionPolicy, approvals: Option<Approvals>) -> OpencodeV2 {
        let mut executor = OpencodeV2 {
            append_prompt: AppendPrompt::default(),
            model: None,
            variant: None,
            agent: None,
            auto_approve: false,
            dont_ask: false,
            cmd: CmdOverrides::default(),
            approvals: approvals.map(|a| Arc::new(a) as Arc<dyn ExecutorApprovalService>),
            unsupported_policy: None,
        };
        let mut config = ExecutorConfig::new(BaseCodingAgent::OpencodeV2);
        config.permission_policy = Some(policy);
        executor.apply_overrides(&config);
        executor
    }

    fn output(writer: &[u8]) -> Vec<AcpEvent> {
        String::from_utf8_lossy(writer)
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn usages(events: &[AcpEvent]) -> Vec<(u32, u32)> {
        events
            .iter()
            .filter_map(|event| match event {
                AcpEvent::TokenUsage(info) => Some((info.total_tokens, info.model_context_window)),
                _ => None,
            })
            .collect()
    }

    fn dirty_repo() -> (tempfile::TempDir, RepoContext) {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&repo)
                .status()
                .unwrap()
                .success()
        );
        std::fs::write(repo.join("left-over.txt"), "fixture").unwrap();
        let context = RepoContext::new(root.path().to_path_buf(), vec!["repo".into()]);
        (root, context)
    }

    #[tokio::test]
    async fn supervised_resume_reports_usage_asks_and_reminds_once() {
        let server = MockServer::start(Box::new(|request, events| {
            let path = request.path.split('?').next().unwrap();
            match (request.method.as_str(), path) {
                ("GET", "/api/session/ses_fixture") => (
                    200,
                    json!({"data": {"id": "ses_fixture", "agent": "build",
                                    "model": {"providerID": "fixture", "id": "small"}}}),
                ),
                ("GET", "/api/agent/build") => (200, agent()),
                ("GET", "/api/model") => (200, models()),
                ("GET", "/api/session/ses_fixture/context") => (
                    200,
                    json!({"data": [
                        {"type": "user"},
                        {"type": "assistant", "model": {"providerID": "fixture", "id": "small"},
                         "tokens": {"input": 100, "output": 50, "reasoning": 0, "cache": {"read": 200, "write": 0}}},
                        {"type": "idle"}
                    ]}),
                ),
                ("POST", "/api/session/ses_fixture/prompt") => {
                    if request.body["text"] == "Fix the fixture" {
                        events.send(step("msg_a", "small")).unwrap();
                        events
                            .send(event(
                                "permission.asked",
                                json!({"id": "per_fixture", "sessionID": "ses_fixture", "action": "shell",
                                       "resources": ["cargo test"],
                                       "source": {"type": "tool", "messageID": "msg_a", "id": "call_a"}}),
                            ))
                            .unwrap();
                    } else {
                        events.send(step("msg_c", "small")).unwrap();
                        events.send(step_end("msg_c", 10, 600)).unwrap();
                        events.send(done()).unwrap();
                    }
                    (200, json!({"data": {}}))
                }
                ("POST", "/api/session/ses_fixture/permission/per_fixture/reply") => {
                    events.send(step_end("msg_a", 300, 400)).unwrap();
                    events.send(done()).unwrap();
                    (204, Value::Null)
                }
                ("PATCH", "/api/session/ses_fixture") => (200, json!({"data": {}})),
                _ => (404, json!({"error": request.path})),
            }
        }))
        .await;
        let (_root, repo) = dirty_repo();
        let executor = executor(
            PermissionPolicy::Supervised,
            Some(Approvals {
                tool: ApprovalStatus::Approved,
                question: None,
            }),
        );
        let mut writer = Vec::new();
        executor
            .run_turn(
                &server.api,
                Path::new("/fixture"),
                TurnInput::Prompt("Fix the fixture".into()),
                Some("ses_fixture".into()),
                Some(CommitReminder {
                    repo,
                    prompt: "Commit the changes.".into(),
                }),
                &CancellationToken::new(),
                &mut writer,
            )
            .await
            .unwrap();

        let permissions = &server.requests("PATCH", "/api/session/ses_fixture")[0].body;
        assert_eq!(
            permissions["permissions"],
            json!([
                rule("edit", "ask"),
                rule("write", "ask"),
                rule("shell", "ask"),
                rule("webfetch", "ask"),
                rule("websearch", "ask"),
                rule("external_directory", "ask"),
                {"action": "question", "resource": "*", "effect": "allow"},
                {"action": "shell", "resource": "rm *", "effect": "deny"}
            ])
        );
        assert_eq!(
            server.requests(
                "POST",
                "/api/session/ses_fixture/permission/per_fixture/reply"
            )[0]
            .body,
            json!({"decision": "once", "message": null})
        );
        let prompts = server.requests("POST", "/api/session/ses_fixture/prompt");
        assert_eq!(prompts.len(), 2, "the reminder is sent once");
        let reminder = prompts[1].body["text"].as_str().unwrap();
        assert!(
            reminder.starts_with("Commit the changes.\n") && reminder.contains("left-over.txt")
        );

        let events = output(&writer);
        // Resume baseline, the supervised step, then the reminder's step.
        assert_eq!(usages(&events), [(350, 1000), (735, 1000), (645, 1000)]);
        assert!(events.iter().any(|event| matches!(event,
            AcpEvent::ApprovalRequested { tool_call_id, .. } if tool_call_id == "msg_a:call_a")));
        assert!(
            events
                .iter()
                .any(|event| matches!(event, AcpEvent::System(text) if text == reminder))
        );
        assert!(matches!(events.last(), Some(AcpEvent::Done(_))));
    }

    #[tokio::test]
    async fn dont_ask_denies_questions_declines_forms_and_handles_unknown_usage() {
        let server = MockServer::start(Box::new(|request, events| {
            let path = request.path.split('?').next().unwrap();
            match (request.method.as_str(), path) {
                ("POST", "/api/session") => (
                    200,
                    json!({"data": {"id": "ses_fixture", "model": {"providerID": "fixture", "id": "small"}}}),
                ),
                ("GET", "/api/model") => (200, models()),
                ("POST", "/api/session/ses_fixture/prompt") => {
                    events.send(step("msg_a", "unlisted")).unwrap();
                    events
                        .send(event(
                            "form.created",
                            json!({"form": {"id": "frm_fixture", "sessionID": "ses_fixture", "title": "Questions",
                                            "fields": [{"key": "q0", "type": "string", "options": [{"value": "a", "label": "A"}]}]}}),
                        ))
                        .unwrap();
                    (200, json!({"data": {}}))
                }
                ("DELETE", "/api/session/ses_fixture/form/frm_fixture") => {
                    events.send(step_end("msg_a", 50, 0)).unwrap();
                    events.send(step("msg_b", "large")).unwrap();
                    events.send(step_end("msg_b", 70, 0)).unwrap();
                    events
                        .send(event(
                            "session.compaction.ended",
                            json!({"sessionID": "ses_fixture", "reason": "auto", "text": "summary"}),
                        ))
                        .unwrap();
                    events.send(done()).unwrap();
                    (204, Value::Null)
                }
                _ => (404, json!({"error": request.path})),
            }
        }))
        .await;
        let executor = executor(
            PermissionPolicy::DontAsk,
            Some(Approvals {
                tool: ApprovalStatus::Approved,
                question: None,
            }),
        );
        assert_eq!(
            executor.get_preset_options().permission_policy,
            Some(PermissionPolicy::DontAsk)
        );
        let mut writer = Vec::new();
        executor
            .run_turn(
                &server.api,
                Path::new("/fixture"),
                TurnInput::Prompt("Work unattended".into()),
                None,
                None,
                &CancellationToken::new(),
                &mut writer,
            )
            .await
            .unwrap();
        assert_eq!(
            server.requests("POST", "/api/session")[0].body["permissions"],
            json!([rule("question", "deny")])
        );
        let decline = &server.requests("DELETE", "/api/session/ses_fixture/form/frm_fixture")[0];
        assert!(decline.path.contains("message=The+user+cannot+answer"));
        // New session clears the previous gauge; an unlisted model and a
        // compaction are unknown rather than a guessed percentage.
        assert_eq!(
            usages(&output(&writer)),
            [(0, 0), (0, 0), (105, 4000), (0, 0)]
        );
    }

    #[tokio::test]
    async fn auto_and_dont_ask_approve_remaining_asks_without_prompting_the_user() {
        for policy in [PermissionPolicy::Auto, PermissionPolicy::DontAsk] {
            let server = MockServer::start(Box::new(|request, events| {
                let path = request.path.split('?').next().unwrap();
                match (request.method.as_str(), path) {
                    ("POST", "/api/session") => (200, json!({"data": {"id": "ses_fixture"}})),
                    ("GET", "/api/model") => (200, models()),
                    ("POST", "/api/session/ses_fixture/prompt") => {
                        events
                            .send(event(
                                "permission.asked",
                                json!({"id": "per_fixture", "sessionID": "ses_fixture", "action": "read",
                                       "resources": ["/fixture/.env"]}),
                            ))
                            .unwrap();
                        (200, json!({"data": {}}))
                    }
                    ("POST", "/api/session/ses_fixture/permission/per_fixture/reply") => {
                        events.send(done()).unwrap();
                        (204, Value::Null)
                    }
                    _ => (404, json!({"error": request.path})),
                }
            }))
            .await;
            // Approving would be denied if the user were asked.
            let executor = executor(
                policy,
                Some(Approvals {
                    tool: ApprovalStatus::Denied { reason: None },
                    question: None,
                }),
            );
            let mut writer = Vec::new();
            executor
                .run_turn(
                    &server.api,
                    Path::new("/fixture"),
                    TurnInput::Prompt("Read it".into()),
                    None,
                    None,
                    &CancellationToken::new(),
                    &mut writer,
                )
                .await
                .unwrap();
            assert_eq!(
                server.requests(
                    "POST",
                    "/api/session/ses_fixture/permission/per_fixture/reply"
                )[0]
                .body,
                json!({"decision": "once", "message": null})
            );
            assert!(
                !output(&writer)
                    .iter()
                    .any(|event| matches!(event, AcpEvent::ApprovalRequested { .. }))
            );
        }
    }

    #[tokio::test]
    async fn failed_or_interrupted_turns_send_no_commit_reminder() {
        for kind in ["session.execution.failed", "session.execution.interrupted"] {
            let server = MockServer::start(Box::new(move |request, events| {
                let path = request.path.split('?').next().unwrap();
                match (request.method.as_str(), path) {
                    ("POST", "/api/session") => (200, json!({"data": {"id": "ses_fixture"}})),
                    ("GET", "/api/model") => (200, models()),
                    ("POST", "/api/session/ses_fixture/prompt") => {
                        events
                            .send(event(
                                kind,
                                json!({"sessionID": "ses_fixture", "error": {"type": "provider.auth"}}),
                            ))
                            .unwrap();
                        (200, json!({"data": {}}))
                    }
                    _ => (404, json!({"error": request.path})),
                }
            }))
            .await;
            let (_root, repo) = dirty_repo();
            let mut writer = Vec::new();
            let result = executor(PermissionPolicy::Auto, None)
                .run_turn(
                    &server.api,
                    Path::new("/fixture"),
                    TurnInput::Prompt("Work".into()),
                    None,
                    Some(CommitReminder {
                        repo,
                        prompt: "Commit.".into(),
                    }),
                    &CancellationToken::new(),
                    &mut writer,
                )
                .await;
            assert!(result.is_err(), "{kind}");
            assert_eq!(
                server
                    .requests("POST", "/api/session/ses_fixture/prompt")
                    .len(),
                1,
                "{kind}: no reminder after a failed turn"
            );
        }
    }

    #[test]
    fn only_compaction_skips_the_commit_reminder() {
        let (_root, repo) = dirty_repo();
        let env = ExecutionEnv::new(repo, true, "Commit.".into());
        let command = |name: &str| TurnInput::Command {
            text: format!("/{name}"),
            name: name.into(),
            arguments: String::new(),
        };
        assert!(reminder_for(&TurnInput::Prompt("work".into()), &env).is_some());
        assert!(reminder_for(&command("hello"), &env).is_some());
        assert!(reminder_for(&command(COMPACT), &env).is_none());
        let off = ExecutionEnv::new(RepoContext::default(), false, String::new());
        assert!(reminder_for(&TurnInput::Prompt("work".into()), &off).is_none());
    }

    #[tokio::test]
    async fn auto_answers_forms_with_option_values() {
        let server = MockServer::start(Box::new(|request, events| {
            let path = request.path.split('?').next().unwrap();
            match (request.method.as_str(), path) {
                ("POST", "/api/session") => (200, json!({"data": {"id": "ses_fixture"}})),
                ("GET", "/api/model") => (200, models()),
                ("POST", "/api/session/ses_fixture/prompt") => {
                    events
                        .send(event(
                            "form.created",
                            json!({"form": {"id": "frm_fixture", "sessionID": "ses_fixture", "title": "Questions",
                                            "metadata": {"kind": "question", "tool": {"messageID": "msg_a", "id": "call_q"}},
                                            "fields": [{"key": "q0", "title": "Color", "description": "Which color?", "type": "string",
                                                        "options": [{"value": "red", "label": "Red"}, {"value": "blue", "label": "Blue"}],
                                                        "custom": true}]}}),
                        ))
                        .unwrap();
                    (200, json!({"data": {}}))
                }
                ("POST", "/api/session/ses_fixture/form/frm_fixture/reply") => {
                    events.send(done()).unwrap();
                    (204, Value::Null)
                }
                _ => (404, json!({"error": request.path})),
            }
        }))
        .await;
        let executor = executor(
            PermissionPolicy::Auto,
            Some(Approvals {
                tool: ApprovalStatus::Denied { reason: None },
                question: Some(QuestionStatus::Answered {
                    answers: vec![QuestionAnswer {
                        question: "Which color?".into(),
                        answer: vec!["Blue".into()],
                    }],
                }),
            }),
        );
        let mut writer = Vec::new();
        executor
            .run_turn(
                &server.api,
                Path::new("/fixture"),
                TurnInput::Prompt("Ask me".into()),
                None,
                None,
                &CancellationToken::new(),
                &mut writer,
            )
            .await
            .unwrap();
        assert_eq!(
            server.requests("POST", "/api/session")[0].body["permissions"],
            json!([])
        );
        assert_eq!(
            server.requests("POST", "/api/session/ses_fixture/form/frm_fixture/reply")[0].body,
            json!({"answer": {"q0": "blue"}})
        );
        let events = output(&writer);
        assert!(events.iter().any(|event| matches!(event,
            AcpEvent::ToolUpdate(update) if update.tool_call_id.0.as_ref() == "msg_a:call_q"
                && update.fields.raw_input.as_ref().unwrap()[acp::QUESTIONS_KEY][0]["options"][1]["label"] == "Blue")));
        assert!(events.iter().any(|event| matches!(event,
            AcpEvent::QuestionAnswered { answers, .. } if answers[0].answer == ["Blue"])));
    }

    #[tokio::test]
    async fn slash_commands_use_the_command_and_compaction_endpoints() {
        let server = MockServer::start(Box::new(|request, events| {
            let path = request.path.split('?').next().unwrap();
            match (request.method.as_str(), path) {
                ("GET", "/api/command") => (
                    200,
                    json!({"location": {"directory": "/fixture"},
                           "data": [{"name": "review"}, {"name": "goal"}, {"name": "hello", "description": "Fixture"}]}),
                ),
                ("GET", "/api/session/ses_fixture") => (
                    200,
                    json!({"data": {"id": "ses_fixture", "model": {"providerID": "fixture", "id": "small"}}}),
                ),
                ("GET", "/api/model") => (200, models()),
                ("GET", "/api/session/ses_fixture/context") => (200, json!({"data": []})),
                ("PATCH", "/api/session/ses_fixture") => (200, json!({"data": {}})),
                ("POST", "/api/session/ses_fixture/command")
                    if request.body["name"] == "goal" =>
                {
                    (
                        500,
                        json!({"_tag": "CommandExecutionError", "command": "goal",
                               "message": "No active goal to pause."}),
                    )
                }
                ("POST", "/api/session/ses_fixture/command")
                | ("POST", "/api/session/ses_fixture/compact") => {
                    events.send(done()).unwrap();
                    (200, json!({"data": {}}))
                }
                _ => (404, json!({"error": request.path})),
            }
        }))
        .await;
        let executor = executor(PermissionPolicy::Auto, None);
        let run = |text: &str, id: Option<&str>| {
            let call = parse_slash_command::<SlashCommandCall<'_>>(text).unwrap();
            let input = TurnInput::Command {
                text: text.into(),
                name: call.name,
                arguments: call.arguments.into(),
            };
            let (executor, api, id) = (&executor, &server.api, id.map(str::to_owned));
            async move {
                let mut writer = Vec::new();
                executor
                    .run_turn(
                        api,
                        Path::new("/fixture"),
                        input,
                        id,
                        None,
                        &CancellationToken::new(),
                        &mut writer,
                    )
                    .await
                    .unwrap();
                output(&writer)
            }
        };
        run("/hello  big world", Some("ses_fixture")).await;
        assert_eq!(
            server.requests("POST", "/api/session/ses_fixture/command")[0].body,
            json!({"name": "hello", "text": "big world", "delivery": "queue"})
        );
        run("/compact", Some("ses_fixture")).await;
        assert_eq!(
            server
                .requests("POST", "/api/session/ses_fixture/compact")
                .len(),
            1
        );
        let events = run("/goal pause", Some("ses_fixture")).await;
        assert!(events.iter().any(|event| matches!(event,
            AcpEvent::Message(agent_client_protocol::ContentBlock::Text(t))
                if t.text == "_/goal: No active goal to pause._")));
        assert!(matches!(events.last(), Some(AcpEvent::Done(_))));
        for (text, message) in [
            ("/compact", "No session available"),
            ("/missing arg", "Command not found: `/missing`"),
        ] {
            let events = run(text, None).await;
            assert!(events.iter().any(|event| matches!(event,
                AcpEvent::Message(agent_client_protocol::ContentBlock::Text(t)) if t.text.contains(message))));
            assert!(matches!(events.last(), Some(AcpEvent::Done(_))));
        }
        assert!(
            server
                .requests("POST", "/api/session")
                .iter()
                .all(|request| request.path != "/api/session"),
            "an unavailable command creates no session"
        );
    }

    #[test]
    fn plan_is_refused_instead_of_running_under_another_policy() {
        let executor = executor(PermissionPolicy::Plan, None);
        assert_eq!(executor.unsupported_policy, Some(PermissionPolicy::Plan));
        let switched = {
            let mut executor = executor.clone();
            let mut config = ExecutorConfig::new(BaseCodingAgent::OpencodeV2);
            config.permission_policy = Some(PermissionPolicy::Supervised);
            executor.apply_overrides(&config);
            executor
        };
        assert_eq!(switched.unsupported_policy, None);
    }

    #[test]
    fn form_answers_cover_every_field_kind_and_conditions() {
        let form = json!({"title": "Setup", "fields": [
            {"key": "name", "type": "string", "title": "Name"},
            {"key": "tags", "type": "multiselect", "description": "Tags?", "custom": true,
             "options": [{"value": "a", "label": "Alpha"}, {"value": "b", "label": "Beta"}]},
            {"key": "ok", "type": "boolean", "description": "Proceed?"},
            {"key": "count", "type": "integer", "description": "How many?"},
            {"key": "why", "type": "string", "description": "Why not?",
             "when": [{"key": "ok", "op": "eq", "value": false}]},
            {"key": "secret", "type": "string", "hidden": true}
        ]});
        let fields = form_questions(&form).unwrap();
        assert_eq!(fields.len(), 5);
        assert!(fields[1].item.multi_select);
        assert_eq!(fields[2].item.allow_custom_answer, Some(false));
        let answer = |question: &str, answer: &[&str]| QuestionAnswer {
            question: question.into(),
            answer: answer.iter().map(|a| a.to_string()).collect(),
        };
        let answers = vec![
            answer("Name", &["Ada"]),
            answer("Tags?", &["Beta", "custom"]),
            answer("Proceed?", &["Yes"]),
            answer("How many?", &["3"]),
            answer("Why not?", &["skipped"]),
        ];
        assert_eq!(
            form_answer(&fields, &answers).unwrap(),
            json!({"name": "Ada", "tags": ["b", "custom"], "ok": true, "count": 3})
        );
        let mut wrong = answers.clone();
        wrong[3] = answer("How many?", &["three"]);
        assert!(form_answer(&fields, &wrong).is_none());
        // Conditions on a multiselect test inclusion; an unanswered field fails both operators.
        let form = json!({"title": "Setup", "fields": [
            {"key": "tags", "type": "multiselect", "description": "Tags?",
             "options": [{"value": "a", "label": "Alpha"}, {"value": "b", "label": "Beta"}]},
            {"key": "named", "type": "string", "description": "Name?",
             "when": [{"key": "tags", "op": "eq", "value": "a"}]},
            {"key": "other", "type": "string", "description": "Other?",
             "when": [{"key": "tags", "op": "neq", "value": "a"}]},
            {"key": "orphan", "type": "string", "description": "Orphan?",
             "when": [{"key": "missing", "op": "neq", "value": "x"}]}
        ]});
        let fields = form_questions(&form).unwrap();
        let answers = vec![
            answer("Tags?", &["Alpha"]),
            answer("Name?", &["Ada"]),
            answer("Other?", &["no"]),
            answer("Orphan?", &["no"]),
        ];
        assert_eq!(
            form_answer(&fields, &answers).unwrap(),
            json!({"tags": ["a"], "named": "Ada"})
        );
        assert!(
            form_questions(&json!({"fields": [{"key": "x", "type": "external", "url": "https://example.test"}]}))
                .is_none()
        );
    }
}
