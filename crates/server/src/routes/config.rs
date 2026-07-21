use std::collections::HashMap;

use api_types::LoginStatus;
use axum::{
    BoxError, Json, Router,
    body::Body,
    extract::{Path, Query, State, ws::Message},
    http::{self, HeaderMap, StatusCode},
    response::{
        IntoResponse, Json as ResponseJson, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, patch, put},
};
use chrono::NaiveTime;
use deployment::{Deployment, DeploymentError};
use executors::{
    executors::{
        AvailabilityInfo, BaseAgentCapability, BaseCodingAgent, StandardCodingAgentExecutor,
    },
    mcp_config::{McpConfig, read_agent_config, write_agent_config},
    profile::{ExecutorConfigs, ExecutorProfileId, ExecutorRecentModels, ProfileError},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::{
    config::{
        Config, ConfigError, SoundFile,
        editor::{EditorConfig, EditorType},
        save_config_to_file,
    },
    container::ContainerService,
    remote_client::RemoteClientError,
};
use sha2::{Digest, Sha256};
use tokio::fs;
use ts_rs::TS;
use utils::{assets::config_path, log_msg::LogMsg, response::ApiResponse};
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    error::ApiError,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
    runtime::relay_registration,
};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/info", get(get_user_system_info))
        .route("/host-appearance", get(get_host_appearance))
        .route("/config", put(update_config))
        .route("/sounds/{sound}", get(get_sound))
        .route("/mcp-config", get(get_mcp_servers).post(update_mcp_servers))
        .route("/profiles", get(get_profiles).put(update_profiles))
        .route("/profiles/recent-models", patch(update_recent_models))
        .route(
            "/editors/check-availability",
            get(check_editor_availability),
        )
        .route("/agents/check-availability", get(check_agent_availability))
        .route("/agents/preset-options", get(get_agent_preset_options))
        .route(
            "/agents/discovered-options/ws",
            get(stream_executor_discovered_options_ws),
        )
        .route(
            "/agents/discovered-options/sse",
            get(stream_executor_discovered_options_sse),
        )
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct Environment {
    pub os_type: String,
    pub os_version: String,
    pub os_architecture: String,
    pub bitness: String,
}

impl Default for Environment {
    fn default() -> Self {
        Self::new()
    }
}

impl Environment {
    pub fn new() -> Self {
        let info = os_info::get();
        Environment {
            os_type: info.os_type().to_string(),
            os_version: info.version().to_string(),
            os_architecture: info.architecture().unwrap_or("unknown").to_string(),
            bitness: info.bitness().to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct UserSystemInfo {
    pub version: String,
    pub config: Config,
    pub config_revision: String,
    pub profiles_revision: String,
    pub machine_id: String,
    pub login_status: LoginStatus,
    pub remote_auth_degraded: Option<String>,
    #[serde(flatten)]
    pub profiles: ExecutorConfigs,
    pub environment: Environment,
    /// Capabilities supported per executor (e.g., { "CLAUDE_CODE": ["SESSION_FORK"] })
    pub capabilities: HashMap<String, Vec<BaseAgentCapability>>,
    pub shared_api_base: Option<String>,
    pub preview_proxy_port: Option<u16>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct HostAppearance {
    pub primary_color: String,
}

async fn get_host_appearance(
    State(deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<HostAppearance>> {
    let config = deployment.config().read().await;
    ResponseJson(ApiResponse::success(HostAppearance {
        primary_color: config.primary_color.clone(),
    }))
}

fn revision<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("configuration must serialize");
    format!("{:x}", Sha256::digest(bytes))
}

// TODO: update frontend, BE schema has changed, this replaces GET /config and /config/constants
#[axum::debug_handler]
async fn get_user_system_info(
    State(deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<UserSystemInfo>> {
    let config = deployment.config().read().await.clone();
    let login_status = match tokio::time::timeout(
        std::time::Duration::from_secs(2),
        deployment.get_login_status(),
    )
    .await
    {
        Ok(status) => status,
        Err(_) => {
            tracing::warn!("timed out determining login status for /api/info");

            let auth_context = deployment.auth_context();
            let cached_profile = auth_context.cached_profile().await;

            match auth_context.get_credentials().await {
                Some(_) => {
                    if auth_context.remote_auth_degraded_slug().await.is_none() {
                        auth_context
                            .set_remote_auth_degraded_slug(
                                RemoteClientError::generic_degraded_slug(),
                            )
                            .await;
                    }

                    LoginStatus::LoggedIn {
                        profile: cached_profile,
                    }
                }
                None => {
                    auth_context.clear_profile().await;
                    auth_context.clear_remote_auth_degraded_slug().await;
                    LoginStatus::LoggedOut
                }
            }
        }
    };

    let cached_profiles = ExecutorConfigs::get_cached();
    let user_system_info = UserSystemInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        config_revision: revision(&config),
        config,
        machine_id: deployment.user_id().to_string(),
        login_status,
        remote_auth_degraded: deployment.auth_context().remote_auth_degraded_slug().await,
        profiles_revision: cached_profiles.revision(),
        profiles: cached_profiles,
        environment: Environment::new(),
        capabilities: {
            let mut caps: HashMap<String, Vec<BaseAgentCapability>> = HashMap::new();
            let profs = ExecutorConfigs::get_cached();
            for key in profs.executors.keys() {
                if let Some(agent) = profs.get_coding_agent(&ExecutorProfileId::new(*key)) {
                    caps.insert(key.to_string(), agent.capabilities());
                }
            }
            caps
        },
        shared_api_base: deployment.remote_info().get_api_base(),
        preview_proxy_port: deployment.client_info().get_preview_proxy_port(),
    };

    ResponseJson(ApiResponse::success(user_system_info))
}

#[derive(Debug, Deserialize, TS)]
pub struct UpdateConfigRequest {
    pub config: Config,
    pub revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CompatibleUpdateConfigRequest {
    Versioned(UpdateConfigRequest),
    Legacy(Config),
}

#[derive(Debug, Serialize, TS)]
pub struct VersionedConfig {
    pub config: Config,
    pub revision: String,
}

async fn update_config(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Json(request): Json<CompatibleUpdateConfigRequest>,
) -> Response {
    let (new_config, expected_revision) = match request {
        CompatibleUpdateConfigRequest::Versioned(request) => {
            (request.config, Some(request.revision))
        }
        CompatibleUpdateConfigRequest::Legacy(config) => (config, None),
    };
    let config_path = config_path();

    // Validate git branch prefix
    if !git::is_valid_branch_prefix(&new_config.git_branch_prefix) {
        return (StatusCode::BAD_REQUEST, ResponseJson(ApiResponse::<VersionedConfig>::error(
            "Invalid git branch prefix. Must be a valid git branch name component without slashes.",
        ))).into_response();
    }
    if NaiveTime::parse_from_str(&new_config.agent_memory_sync.daily_local_time, "%H:%M").is_err() {
        return (
            StatusCode::BAD_REQUEST,
            ResponseJson(ApiResponse::<VersionedConfig>::error(
                "Invalid agent memory sync time. Expected HH:MM in local time.",
            )),
        )
            .into_response();
    }

    // Get old config state before updating
    let mut config_guard = deployment.config().write().await;
    let old_config = config_guard.clone();
    let current_revision = revision(&old_config);
    if let Some(expected_revision) = &expected_revision
        && expected_revision != &current_revision
    {
        return (
            StatusCode::CONFLICT,
            ResponseJson(ApiResponse::<VersionedConfig>::error(&format!(
                "Configuration changed since it was loaded (current revision {current_revision})"
            ))),
        )
            .into_response();
    }

    match save_config_to_file(&new_config, &config_path).await {
        Ok(_) => {
            *config_guard = new_config.clone();
            drop(config_guard);

            // Run relay side effects for relevant configuration changes.
            handle_config_events(&deployment, &old_config, &new_config).await;

            let new_revision = revision(&new_config);
            tracing::info!(
                source_host = headers.get("x-vibe-source-host").and_then(|v| v.to_str().ok()).unwrap_or("browser"),
                target_host = %deployment.user_id(),
                previous_revision = %current_revision,
                revision = %new_revision,
                changed_fields = ?changed_top_level_fields(&old_config, &new_config),
                "host configuration updated"
            );
            if expected_revision.is_some() {
                ResponseJson(ApiResponse::<VersionedConfig>::success(VersionedConfig {
                    config: new_config,
                    revision: new_revision,
                }))
                .into_response()
            } else {
                // Older clients send a bare Config and expect the same shape
                // back. Keep that contract during rolling multi-host upgrades.
                ResponseJson(ApiResponse::<Config>::success(new_config)).into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ResponseJson(ApiResponse::<VersionedConfig>::error(&format!(
                "Failed to save config: {}",
                e
            ))),
        )
            .into_response(),
    }
}

fn changed_top_level_fields<T: Serialize>(old: &T, new: &T) -> Vec<String> {
    let old = serde_json::to_value(old).unwrap_or_default();
    let new = serde_json::to_value(new).unwrap_or_default();
    let mut keys = old
        .as_object()
        .into_iter()
        .flat_map(|v| v.keys())
        .chain(new.as_object().into_iter().flat_map(|v| v.keys()))
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .filter(|key| old.get(key) != new.get(key))
        .collect()
}

async fn handle_config_events(deployment: &DeploymentImpl, old: &Config, new: &Config) {
    let old_host_nickname = relay_registration::clean_host_nickname(old, deployment.user_id());
    let new_host_nickname = relay_registration::clean_host_nickname(new, deployment.user_id());

    match (old.relay_enabled, new.relay_enabled) {
        (false, true) => relay_registration::spawn_relay(deployment).await,
        (true, false) => relay_registration::stop_relay(deployment).await,
        (true, true) => {
            if old_host_nickname != new_host_nickname {
                relay_registration::spawn_relay(deployment).await;
            }
        }
        (false, false) => (),
    }
}

async fn get_sound(Path(sound): Path<SoundFile>) -> Result<Response, ApiError> {
    let sound = sound.serve().await.map_err(DeploymentError::Other)?;
    let response = Response::builder()
        .status(http::StatusCode::OK)
        .header(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("audio/wav"),
        )
        .body(Body::from(sound.data.into_owned()))
        .unwrap();
    Ok(response)
}

#[derive(TS, Debug, Deserialize)]
pub struct McpServerQuery {
    executor: BaseCodingAgent,
}

#[derive(TS, Debug, Serialize, Deserialize)]
pub struct GetMcpServerResponse {
    // servers: HashMap<String, Value>,
    mcp_config: McpConfig,
    config_path: String,
}

#[derive(TS, Debug, Serialize, Deserialize)]
pub struct UpdateMcpServersBody {
    servers: HashMap<String, Value>,
}

async fn get_mcp_servers(
    State(_deployment): State<DeploymentImpl>,
    Query(query): Query<McpServerQuery>,
) -> Result<ResponseJson<ApiResponse<GetMcpServerResponse>>, ApiError> {
    let coding_agent = ExecutorConfigs::get_cached()
        .get_coding_agent(&ExecutorProfileId::new(query.executor))
        .ok_or(ConfigError::ValidationError(
            "Executor not found".to_string(),
        ))?;

    if !coding_agent.supports_mcp() {
        return Ok(ResponseJson(ApiResponse::error(
            "MCP not supported by this executor",
        )));
    }

    // Resolve supplied config path or agent default
    let config_path = match coding_agent.default_mcp_config_path() {
        Some(path) => path,
        None => {
            return Ok(ResponseJson(ApiResponse::error(
                "Could not determine config file path",
            )));
        }
    };

    let mut mcpc = coding_agent.get_mcp_config();
    let raw_config = read_agent_config(&config_path, &mcpc).await?;
    let servers = get_mcp_servers_from_config_path(&raw_config, &mcpc.servers_path);
    mcpc.set_servers(servers);
    Ok(ResponseJson(ApiResponse::success(GetMcpServerResponse {
        mcp_config: mcpc,
        config_path: config_path.to_string_lossy().to_string(),
    })))
}

async fn update_mcp_servers(
    State(_deployment): State<DeploymentImpl>,
    Query(query): Query<McpServerQuery>,
    Json(payload): Json<UpdateMcpServersBody>,
) -> Result<ResponseJson<ApiResponse<String>>, ApiError> {
    let profiles = ExecutorConfigs::get_cached();
    let agent = profiles
        .get_coding_agent(&ExecutorProfileId::new(query.executor))
        .ok_or(ConfigError::ValidationError(
            "Executor not found".to_string(),
        ))?;

    if !agent.supports_mcp() {
        return Ok(ResponseJson(ApiResponse::error(
            "This executor does not support MCP servers",
        )));
    }

    // Resolve supplied config path or agent default
    let config_path = match agent.default_mcp_config_path() {
        Some(path) => path.to_path_buf(),
        None => {
            return Ok(ResponseJson(ApiResponse::error(
                "Could not determine config file path",
            )));
        }
    };

    let mcpc = agent.get_mcp_config();
    match update_mcp_servers_in_config(&config_path, &mcpc, payload.servers).await {
        Ok(message) => Ok(ResponseJson(ApiResponse::success(message))),
        Err(e) => Ok(ResponseJson(ApiResponse::error(&format!(
            "Failed to update MCP servers: {}",
            e
        )))),
    }
}

async fn update_mcp_servers_in_config(
    config_path: &std::path::Path,
    mcpc: &McpConfig,
    new_servers: HashMap<String, Value>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    // Ensure parent directory exists
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).await?;
    }
    // Read existing config (JSON or TOML depending on agent)
    let mut config = read_agent_config(config_path, mcpc).await?;

    // Get the current server count for comparison
    let old_servers = get_mcp_servers_from_config_path(&config, &mcpc.servers_path).len();

    // Set the MCP servers using the correct attribute path
    set_mcp_servers_in_config_path(&mut config, &mcpc.servers_path, &new_servers)?;

    // Write the updated config back to file (JSON or TOML depending on agent)
    write_agent_config(config_path, mcpc, &config).await?;

    let new_count = new_servers.len();
    let message = match (old_servers, new_count) {
        (0, 0) => "No MCP servers configured".to_string(),
        (0, n) => format!("Added {} MCP server(s)", n),
        (old, new) if old == new => format!("Updated MCP server configuration ({} server(s))", new),
        (old, new) => format!(
            "Updated MCP server configuration (was {}, now {})",
            old, new
        ),
    };

    Ok(message)
}

/// Helper function to get MCP servers from config using a path
fn get_mcp_servers_from_config_path(raw_config: &Value, path: &[String]) -> HashMap<String, Value> {
    let mut current = raw_config;
    for part in path {
        current = match current.get(part) {
            Some(val) => val,
            None => return HashMap::new(),
        };
    }
    // Extract the servers object
    match current.as_object() {
        Some(servers) => servers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        None => HashMap::new(),
    }
}

/// Helper function to set MCP servers in config using a path
fn set_mcp_servers_in_config_path(
    raw_config: &mut Value,
    path: &[String],
    servers: &HashMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Ensure config is an object
    if !raw_config.is_object() {
        *raw_config = serde_json::json!({});
    }

    let mut current = raw_config;
    // Navigate/create the nested structure (all parts except the last)
    for part in &path[..path.len() - 1] {
        if current.get(part).is_none() {
            current
                .as_object_mut()
                .unwrap()
                .insert(part.to_string(), serde_json::json!({}));
        }
        current = current.get_mut(part).unwrap();
        if !current.is_object() {
            *current = serde_json::json!({});
        }
    }

    // Set the final attribute
    let final_attr = path.last().unwrap();
    current
        .as_object_mut()
        .unwrap()
        .insert(final_attr.to_string(), serde_json::to_value(servers)?);

    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProfilesContent {
    pub content: String,
    pub path: String,
    pub revision: String,
}

async fn get_profiles(
    State(_deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<ProfilesContent>> {
    let profiles_path = utils::assets::profiles_path();

    // Use cached data to ensure consistency with runtime and PUT updates
    let profiles = ExecutorConfigs::get_cached();

    let content = serde_json::to_string_pretty(&profiles).unwrap_or_else(|e| {
        tracing::error!("Failed to serialize profiles to JSON: {}", e);
        serde_json::to_string_pretty(&ExecutorConfigs::from_defaults())
            .unwrap_or_else(|_| "{}".to_string())
    });

    ResponseJson(ApiResponse::success(ProfilesContent {
        revision: profiles.revision(),
        content,
        path: profiles_path.display().to_string(),
    }))
}

#[derive(Debug, Deserialize)]
struct UpdateProfilesRequest {
    content: String,
    revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CompatibleUpdateProfilesRequest {
    Versioned(UpdateProfilesRequest),
    Legacy(ExecutorConfigs),
}

async fn update_profiles(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Json(request): Json<CompatibleUpdateProfilesRequest>,
) -> Response {
    let (executor_profiles, expected_revision) = match request {
        CompatibleUpdateProfilesRequest::Versioned(request) => {
            match serde_json::from_str::<ExecutorConfigs>(&request.content) {
                Ok(profiles) => (profiles, Some(request.revision)),
                Err(e) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        ResponseJson(ApiResponse::<String>::error(&format!(
                            "Invalid executor profiles format: {e}"
                        ))),
                    )
                        .into_response();
                }
            }
        }
        CompatibleUpdateProfilesRequest::Legacy(profiles) => (profiles, None),
    };

    match expected_revision {
        Some(expected_revision) => {
            match ExecutorConfigs::replace_if_revision(executor_profiles, &expected_revision) {
                Ok(new_revision) => {
                    tracing::info!(source_host = headers.get("x-vibe-source-host").and_then(|v| v.to_str().ok()).unwrap_or("browser"), target_host = %deployment.user_id(), previous_revision = %expected_revision, revision = %new_revision, changed_fields = ?["executors"], "executor profiles updated");
                    ResponseJson(ApiResponse::<String>::success(new_revision)).into_response()
                }
                Err(ProfileError::RevisionConflict { current, .. }) => (
                    StatusCode::CONFLICT,
                    ResponseJson(ApiResponse::<String>::error(&format!(
                        "Profiles changed since they were loaded (current revision {current})"
                    ))),
                )
                    .into_response(),
                Err(e) => {
                    tracing::error!("Failed to save executor profiles: {}", e);
                    (
                        StatusCode::BAD_REQUEST,
                        ResponseJson(ApiResponse::<String>::error(&format!(
                            "Failed to save executor profiles: {}",
                            e
                        ))),
                    )
                        .into_response()
                }
            }
        }
        None => match executor_profiles.save_overrides() {
            Ok(()) => {
                ExecutorConfigs::reload();
                ResponseJson(ApiResponse::<String>::success(
                    "Executor profiles updated successfully".to_string(),
                ))
                .into_response()
            }
            Err(e) => (
                StatusCode::BAD_REQUEST,
                ResponseJson(ApiResponse::<String>::error(&format!(
                    "Failed to save executor profiles: {e}"
                ))),
            )
                .into_response(),
        },
    }
}

#[derive(Debug, Deserialize)]
struct UpdateRecentModelsRequest {
    executor: BaseCodingAgent,
    recently_used_models: ExecutorRecentModels,
    revision: String,
}

async fn update_recent_models(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Json(request): Json<UpdateRecentModelsRequest>,
) -> Response {
    match ExecutorConfigs::update_recent_models_if_revision(
        request.executor,
        request.recently_used_models,
        &request.revision,
    ) {
        Ok((profiles, new_revision)) => {
            tracing::info!(source_host = headers.get("x-vibe-source-host").and_then(|v| v.to_str().ok()).unwrap_or("browser"), target_host = %deployment.user_id(), previous_revision = %request.revision, revision = %new_revision, changed_fields = ?["recently_used_models"], "recent model metadata updated");
            ResponseJson(ApiResponse::<ProfilesContent>::success(ProfilesContent {
                content: serde_json::to_string_pretty(&profiles)
                    .unwrap_or_else(|_| "{}".to_string()),
                path: utils::assets::profiles_path().display().to_string(),
                revision: new_revision,
            }))
            .into_response()
        }
        Err(ProfileError::RevisionConflict { current, .. }) => (
            StatusCode::CONFLICT,
            ResponseJson(ApiResponse::<ProfilesContent>::error(&format!(
                "Profiles changed since they were loaded (current revision {current})"
            ))),
        )
            .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            ResponseJson(ApiResponse::<ProfilesContent>::error(&error.to_string())),
        )
            .into_response(),
    }
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CheckEditorAvailabilityQuery {
    editor_type: EditorType,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CheckEditorAvailabilityResponse {
    available: bool,
}

async fn check_editor_availability(
    State(_deployment): State<DeploymentImpl>,
    Query(query): Query<CheckEditorAvailabilityQuery>,
) -> ResponseJson<ApiResponse<CheckEditorAvailabilityResponse>> {
    // Construct a minimal EditorConfig for checking
    let editor_config = EditorConfig::new(
        query.editor_type,
        None,  // custom_command
        None,  // remote_ssh_host
        None,  // remote_ssh_user
        false, // auto_install_extension
    );

    let available = editor_config.check_availability().await;
    ResponseJson(ApiResponse::success(CheckEditorAvailabilityResponse {
        available,
    }))
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CheckAgentAvailabilityQuery {
    executor: BaseCodingAgent,
}

async fn check_agent_availability(
    State(_deployment): State<DeploymentImpl>,
    Query(query): Query<CheckAgentAvailabilityQuery>,
) -> ResponseJson<ApiResponse<AvailabilityInfo>> {
    let profiles = ExecutorConfigs::get_cached();
    let profile_id = ExecutorProfileId::new(query.executor);

    let info = match profiles.get_coding_agent(&profile_id) {
        Some(agent) => agent.get_availability_info(),
        None => AvailabilityInfo::NotFound,
    };

    ResponseJson(ApiResponse::success(info))
}

#[derive(Debug, Deserialize, TS)]
pub struct AgentPresetOptionsQuery {
    pub executor: BaseCodingAgent,
    pub variant: Option<String>,
}

async fn get_agent_preset_options(
    Query(query): Query<AgentPresetOptionsQuery>,
) -> ResponseJson<ApiResponse<executors::profile::ExecutorConfig>> {
    let profiles = ExecutorConfigs::get_cached();
    let profile_id = if let Some(variant) = query.variant {
        ExecutorProfileId::with_variant(query.executor, variant)
    } else {
        ExecutorProfileId::new(query.executor)
    };

    let options = match profiles.get_coding_agent(&profile_id) {
        Some(agent) => agent.get_preset_options(),
        None => {
            // Return a default config if not found
            executors::profile::ExecutorConfig::new(query.executor)
        }
    };

    ResponseJson(ApiResponse::success(options))
}

#[derive(Debug, Deserialize)]
pub struct ExecutorDiscoveredOptionsStreamQuery {
    executor: BaseCodingAgent,
    #[serde(default)]
    session_id: Option<Uuid>,
    #[serde(default)]
    workspace_id: Option<Uuid>,
    #[serde(default)]
    repo_id: Option<Uuid>,
}

pub async fn stream_executor_discovered_options_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ExecutorDiscoveredOptionsStreamQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_executor_discovered_options_ws(socket, deployment, query).await {
            tracing::warn!("discovered options WS closed: {}", e);
        }
    })
}

/// SSE sibling of `stream_executor_discovered_options_ws`. `Ready` is sent
/// first so the stream is initialized even when discovery yields no options.
pub async fn stream_executor_discovered_options_sse(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ExecutorDiscoveredOptionsStreamQuery>,
) -> impl IntoResponse {
    use futures_util::StreamExt;

    let event_stream: futures_util::stream::BoxStream<'static, Result<Event, BoxError>> =
        match deployment
            .container()
            .discover_executor_options(
                ExecutorProfileId::new(query.executor),
                query.session_id,
                query.workspace_id,
                query.repo_id,
            )
            .await
        {
            Ok(Some(stream)) => futures_util::stream::once(async {
                Ok::<Event, BoxError>(LogMsg::Ready.to_sse_event())
            })
            .chain(
                stream.map(|patch| Ok::<Event, BoxError>(LogMsg::JsonPatch(patch).to_sse_event())),
            )
            .boxed(),
            Ok(None) => {
                futures_util::stream::once(async { Ok(LogMsg::Ready.to_sse_event()) }).boxed()
            }
            Err(e) => {
                tracing::warn!("Failed to start discovered options SSE stream: {}", e);
                futures_util::stream::empty().boxed()
            }
        };
    Sse::new(event_stream).keep_alive(KeepAlive::default())
}

async fn handle_executor_discovered_options_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    query: ExecutorDiscoveredOptionsStreamQuery,
) -> anyhow::Result<()> {
    use futures_util::StreamExt;

    match deployment
        .container()
        .discover_executor_options(
            ExecutorProfileId::new(query.executor),
            query.session_id,
            query.workspace_id,
            query.repo_id,
        )
        .await
    {
        Ok(Some(mut stream)) => {
            if let Some(patch) = stream.next().await {
                let _ = socket
                    .send(LogMsg::JsonPatch(patch).to_ws_message_unchecked())
                    .await;
            }

            let _ = socket.send(LogMsg::Ready.to_ws_message_unchecked()).await;

            loop {
                tokio::select! {
                    patch = stream.next() => {
                        let Some(patch) = patch else {
                            break;
                        };
                        if socket
                            .send(LogMsg::JsonPatch(patch).to_ws_message_unchecked())
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    inbound = socket.recv() => {
                        match inbound {
                            Ok(Some(Message::Close(_))) => break,
                            Ok(Some(_)) => {}
                            Ok(None) => break,
                            Err(_) => break,
                        }
                    }
                }
            }
        }
        Ok(None) => {
            let _ = socket.send(LogMsg::Ready.to_ws_message_unchecked()).await;
        }
        Err(e) => {
            tracing::warn!("Failed to start discovered options stream: {}", e);
        }
    }

    let _ = socket
        .send(LogMsg::Finished.to_ws_message_unchecked())
        .await;
    Ok(())
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;

    #[test]
    fn config_update_accepts_legacy_and_versioned_bodies() {
        let config = Config::default();
        let legacy = serde_json::to_value(&config).unwrap();
        let versioned = serde_json::json!({
            "config": config,
            "revision": "revision-1",
        });

        assert!(matches!(
            serde_json::from_value::<CompatibleUpdateConfigRequest>(legacy).unwrap(),
            CompatibleUpdateConfigRequest::Legacy(_)
        ));
        assert!(matches!(
            serde_json::from_value::<CompatibleUpdateConfigRequest>(versioned).unwrap(),
            CompatibleUpdateConfigRequest::Versioned(_)
        ));
    }

    #[test]
    fn profiles_update_accepts_legacy_and_versioned_bodies() {
        let profiles = ExecutorConfigs::from_defaults();
        let content = serde_json::to_string(&profiles).unwrap();
        let legacy = serde_json::to_value(&profiles).unwrap();
        let versioned = serde_json::json!({
            "content": content,
            "revision": "revision-1",
        });

        assert!(matches!(
            serde_json::from_value::<CompatibleUpdateProfilesRequest>(legacy).unwrap(),
            CompatibleUpdateProfilesRequest::Legacy(_)
        ));
        assert!(matches!(
            serde_json::from_value::<CompatibleUpdateProfilesRequest>(versioned).unwrap(),
            CompatibleUpdateProfilesRequest::Versioned(_)
        ));
    }
}
