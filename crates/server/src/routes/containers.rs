use axum::{
    Router,
    extract::{Query, State},
    response::Json as ResponseJson,
    routing::get,
};
use db::models::{
    requests::ContainerQuery,
    workspace::{Workspace, WorkspaceContext, WorkspaceError},
};
use deployment::Deployment;
use serde::Serialize;
use sqlx::Error as SqlxError;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Serialize)]
struct ContainerInfo {
    pub attempt_id: Uuid,
}

fn maybe_found<T>(result: Result<T, SqlxError>) -> Result<Option<T>, ApiError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(SqlxError::RowNotFound) => Ok(None),
        Err(error) => Err(ApiError::Database(error)),
    }
}

fn maybe_workspace_found<T>(result: Result<T, WorkspaceError>) -> Result<Option<T>, ApiError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(WorkspaceError::WorkspaceNotFound) => Ok(None),
        Err(error) => Err(ApiError::Workspace(error)),
    }
}

async fn get_container_info(
    Query(query): Query<ContainerQuery>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<ContainerInfo>>, ApiError> {
    let info =
        Workspace::resolve_container_ref_by_prefix(&deployment.db().pool, &query.container_ref)
            .await
            .map_err(ApiError::Database)?;

    Ok(ResponseJson(ApiResponse::success(ContainerInfo {
        attempt_id: info.workspace_id,
    })))
}

async fn get_context(
    State(deployment): State<DeploymentImpl>,
    Query(payload): Query<ContainerQuery>,
) -> Result<ResponseJson<ApiResponse<Option<WorkspaceContext>>>, ApiError> {
    let Some(info) = maybe_found(
        Workspace::resolve_container_ref_by_prefix(&deployment.db().pool, &payload.container_ref)
            .await,
    )?
    else {
        return Ok(ResponseJson(ApiResponse::success(None)));
    };

    let ctx = maybe_workspace_found(
        Workspace::load_context(&deployment.db().pool, info.workspace_id).await,
    )?;
    Ok(ResponseJson(ApiResponse::success(ctx)))
}

pub(super) fn router(_deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    Router::new()
        // NOTE: /containers/info is required by the VSCode extension (vibe-kanban-vscode)
        // to auto-detect workspaces. It maps workspace_id to attempt_id for compatibility.
        // Do not remove this endpoint without updating the extension.
        .route("/containers/info", get(get_container_info))
        .route("/containers/attempt-context", get(get_context))
}

#[cfg(test)]
mod tests {
    use db::models::workspace::WorkspaceError;
    use sqlx::Error as SqlxError;

    use super::{maybe_found, maybe_workspace_found};

    #[test]
    fn maybe_found_returns_value_for_success() {
        let result = maybe_found::<i32>(Ok(7)).unwrap();
        assert_eq!(result, Some(7));
    }

    #[test]
    fn maybe_found_returns_none_for_missing_rows() {
        let result = maybe_found::<i32>(Err(SqlxError::RowNotFound)).unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn maybe_found_preserves_non_not_found_errors() {
        let error = maybe_found::<i32>(Err(SqlxError::Protocol("boom".into()))).unwrap_err();
        assert!(matches!(
            error,
            crate::error::ApiError::Database(SqlxError::Protocol(_))
        ));
    }

    #[test]
    fn maybe_workspace_found_returns_none_for_missing_workspace() {
        let result = maybe_workspace_found::<i32>(Err(WorkspaceError::WorkspaceNotFound)).unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn maybe_workspace_found_preserves_workspace_errors() {
        let error =
            maybe_workspace_found::<i32>(Err(WorkspaceError::ValidationError("boom".into())))
                .unwrap_err();
        assert!(matches!(
            error,
            crate::error::ApiError::Workspace(WorkspaceError::ValidationError(_))
        ));
    }
}
