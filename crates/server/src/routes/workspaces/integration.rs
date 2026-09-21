use std::path::{Component, Path, PathBuf};

use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{workspace::Workspace, workspace_repo::WorkspaceRepo};
use deployment::Deployment;
use executors::{
    executors::{CodingAgent, ExecutorError},
    profile::{ExecutorConfigs, ExecutorProfileId},
};
use serde::{Deserialize, Serialize};
use services::services::container::ContainerService;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use super::{codex_setup, cursor_setup, gh_cli_setup::GhCliSetupError};
use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct RunAgentSetupRequest {
    pub executor_profile_id: ExecutorProfileId,
}

#[derive(Debug, Serialize, TS)]
pub struct RunAgentSetupResponse {}

#[derive(Deserialize, TS)]
pub struct OpenEditorRequest {
    editor_type: Option<String>,
    file_path: Option<String>,
    #[ts(optional)]
    repo_id: Option<Uuid>,
    /// Whether the request originates from the remote web app. Used together
    /// with the editor's `remote_ssh_only_in_remote_web` setting.
    #[serde(default)]
    is_remote_web: Option<bool>,
}

#[derive(Debug, Serialize, TS)]
pub struct OpenEditorResponse {
    pub url: Option<String>,
}

#[derive(Debug, Serialize, TS)]
pub struct OpenEditorPathResponse {
    pub workspace_path: String,
}

#[derive(Debug, Deserialize)]
pub struct OpenEditorPathQuery {
    file_path: Option<String>,
    repo_id: Option<Uuid>,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/editor/path", get(get_workspace_editor_path))
        .route("/editor/open", post(open_workspace_in_editor))
        .route("/agent/setup", post(run_agent_setup))
        .route("/github/cli/setup", post(gh_cli_setup_handler))
}

#[axum::debug_handler]
pub async fn run_agent_setup(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<RunAgentSetupRequest>,
) -> Result<ResponseJson<ApiResponse<RunAgentSetupResponse>>, ApiError> {
    let executor_profile_id = payload.executor_profile_id;
    let config = ExecutorConfigs::get_cached();
    let coding_agent = config.get_coding_agent_or_default(&executor_profile_id);
    match coding_agent {
        CodingAgent::CursorAgent(_) => {
            cursor_setup::run_cursor_setup(&deployment, &workspace).await?;
        }
        CodingAgent::Codex(codex) => {
            codex_setup::run_codex_setup(&deployment, &workspace, &codex).await?;
        }
        _ => return Err(ApiError::Executor(ExecutorError::SetupHelperNotSupported)),
    }

    Ok(ResponseJson(ApiResponse::success(RunAgentSetupResponse {})))
}

pub async fn open_workspace_in_editor(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<OpenEditorRequest>,
) -> Result<ResponseJson<ApiResponse<OpenEditorResponse>>, ApiError> {
    let path = resolve_workspace_editor_path(
        &deployment,
        &workspace,
        payload.file_path.as_deref(),
        payload.repo_id,
    )
    .await?;

    let editor_config = {
        let config = deployment.config().read().await;
        let editor_type_str = payload.editor_type.as_deref();
        config.editor.with_override(editor_type_str)
    };

    let is_remote_web = payload.is_remote_web.unwrap_or(false);
    match editor_config.open_file(path.as_path(), is_remote_web).await {
        Ok(url) => {
            tracing::info!(
                "Opened editor for workspace {} at path: {}{}",
                workspace.id,
                path.display(),
                if url.is_some() { " (remote mode)" } else { "" }
            );

            Ok(ResponseJson(ApiResponse::success(OpenEditorResponse {
                url,
            })))
        }
        Err(e) => {
            tracing::error!(
                "Failed to open editor for attempt {}: {:?}",
                workspace.id,
                e
            );
            Err(ApiError::EditorOpen(e))
        }
    }
}

pub async fn get_workspace_editor_path(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<OpenEditorPathQuery>,
) -> Result<ResponseJson<ApiResponse<OpenEditorPathResponse>>, ApiError> {
    let path = resolve_workspace_editor_path(
        &deployment,
        &workspace,
        query.file_path.as_deref(),
        query.repo_id,
    )
    .await?;

    Ok(ResponseJson(ApiResponse::success(OpenEditorPathResponse {
        workspace_path: path.to_string_lossy().into_owned(),
    })))
}

async fn resolve_workspace_editor_path(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    file_path: Option<&str>,
    repo_id: Option<Uuid>,
) -> Result<PathBuf, ApiError> {
    let container_ref = deployment
        .container()
        .ensure_container_exists(workspace)
        .await?;
    deployment.container().touch(workspace).await?;

    let workspace_repos =
        WorkspaceRepo::find_repos_for_workspace(&deployment.db().pool, workspace.id).await?;
    let repo = match repo_id {
        Some(repo_id) => Some(
            workspace_repos
                .iter()
                .find(|repo| repo.id == repo_id)
                .ok_or_else(|| {
                    ApiError::BadRequest(format!(
                        "Repository {repo_id} does not belong to workspace {}",
                        workspace.id
                    ))
                })?,
        ),
        None => workspace_repos
            .first()
            .filter(|_| workspace_repos.len() == 1),
    };

    Ok(editor_path(
        Path::new(&container_ref),
        workspace.in_place,
        repo.map(|repo| repo.name.as_str()),
        file_path,
    ))
}

/// Map a workspace's container dir to the path to hand the editor.
///
/// In-place ("quick chat") workspaces run inside the user's real checkout, so
/// `container_ref` already IS the repo root — joining the repo name there points
/// at a directory that does not exist, and the editor opens it as a new empty
/// file instead of the folder. Diff file paths are repo-name prefixed (see
/// `path_prefix` in `diff_stream`), which the repo root already accounts for.
fn editor_path(
    container_ref: &Path,
    in_place: bool,
    repo_name: Option<&str>,
    file_path: Option<&str>,
) -> PathBuf {
    let repo_root = match repo_name {
        Some(name) if !in_place => container_ref.join(name),
        _ => container_ref.to_path_buf(),
    };
    let Some(file_path) = file_path else {
        return repo_root;
    };
    let file_path = repo_name
        .and_then(|name| file_path.strip_prefix(&format!("{name}/")))
        .unwrap_or(file_path);
    // Diff paths are always workspace-relative. An absolute path (`join` drops
    // the root it is joined onto) or a `..` hop would hand the editor a file
    // outside the workspace, so ignore it and open the workspace itself.
    if Path::new(file_path)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return repo_root;
    }
    repo_root.join(file_path)
}

#[axum::debug_handler]
pub async fn gh_cli_setup_handler(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<
    ResponseJson<ApiResponse<db::models::execution_process::ExecutionProcess, GhCliSetupError>>,
    ApiError,
> {
    match super::gh_cli_setup::run_gh_cli_setup(&deployment, &workspace).await {
        Ok(execution_process) => Ok(ResponseJson(ApiResponse::success(execution_process))),
        Err(ApiError::Executor(executors::executors::ExecutorError::ExecutableNotFound {
            program,
        })) if program == "brew" => Ok(ResponseJson(ApiResponse::error_with_data(
            GhCliSetupError::BrewMissing,
        ))),
        Err(ApiError::Executor(ExecutorError::SetupHelperNotSupported)) => Ok(ResponseJson(
            ApiResponse::error_with_data(GhCliSetupError::SetupHelperNotSupported),
        )),
        Err(ApiError::Executor(err)) => Ok(ResponseJson(ApiResponse::error_with_data(
            GhCliSetupError::Other {
                message: err.to_string(),
            },
        ))),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_workspace_descends_into_repo_dir() {
        let root = Path::new("/ws");
        assert_eq!(
            editor_path(root, false, Some("sample-repo"), None),
            Path::new("/ws/sample-repo")
        );
        assert_eq!(
            editor_path(
                root,
                false,
                Some("sample-repo"),
                Some("sample-repo/src/main.py")
            ),
            Path::new("/ws/sample-repo/src/main.py")
        );
    }

    #[test]
    fn in_place_workspace_opens_container_ref_itself() {
        let root = Path::new("/Users/me/VSC/sample-repo");
        assert_eq!(editor_path(root, true, Some("sample-repo"), None), root);
        assert_eq!(
            editor_path(
                root,
                true,
                Some("sample-repo"),
                Some("sample-repo/src/main.py")
            ),
            Path::new("/Users/me/VSC/sample-repo/src/main.py")
        );
    }

    #[test]
    fn paths_escaping_the_workspace_fall_back_to_the_root() {
        let root = Path::new("/ws");
        assert_eq!(editor_path(root, false, None, Some("/etc/passwd")), root);
        assert_eq!(
            editor_path(root, false, None, Some("../../etc/passwd")),
            root
        );
        assert_eq!(
            editor_path(root, false, Some("api"), Some("api/../../etc/passwd")),
            Path::new("/ws/api")
        );
    }

    #[test]
    fn multi_repo_file_path_keeps_its_prefix() {
        assert_eq!(
            editor_path(Path::new("/ws"), false, None, Some("api/src/main.rs")),
            Path::new("/ws/api/src/main.rs")
        );
    }
}
