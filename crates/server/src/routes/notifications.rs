//! Let an agent (or the `vk` CLI) raise a user notification through the same
//! path the server uses for its own "turn finished" alerts.

use axum::{Json, Router, extract::State, response::Json as ResponseJson, routing::post};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use services::services::container::ContainerService;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct SendNotificationRequest {
    pub title: String,
    pub message: String,
    /// Workspace the notification deep-links to when clicked.
    pub workspace_id: Option<Uuid>,
    /// Deliver only to this host's own subscriptions and OS notifier, not to
    /// the user's cloud web-push devices.
    #[serde(default)]
    pub local_only: bool,
}

async fn send_notification(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<SendNotificationRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let title = request.title.trim();
    let message = request.message.trim();
    if title.is_empty() && message.is_empty() {
        return Err(ApiError::BadRequest(
            "Provide a title or a message".to_string(),
        ));
    }
    let service = deployment.container().notification_service();
    if request.local_only {
        service
            .notify_local_only(title, message, request.workspace_id)
            .await;
    } else {
        service.notify(title, message, request.workspace_id).await;
    }
    Ok(ResponseJson(ApiResponse::success(())))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/notifications/send", post(send_notification))
}
