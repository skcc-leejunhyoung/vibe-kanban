use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use services::services::container::ContainerService;
use utils::response::ApiResponse;

use crate::DeploymentImpl;

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/web-push/public-key", get(public_key))
        .route(
            "/web-push/subscriptions",
            post(subscribe).delete(unsubscribe),
        )
}

#[derive(Debug, Serialize)]
struct PublicKeyResponse {
    enabled: bool,
    public_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SubscriptionKeys {
    p256dh: String,
    auth: String,
}

#[derive(Debug, Deserialize)]
struct SubscribeRequest {
    endpoint: String,
    keys: SubscriptionKeys,
}

#[derive(Debug, Deserialize)]
struct UnsubscribeRequest {
    endpoint: String,
}

async fn public_key(
    State(deployment): State<DeploymentImpl>,
) -> Json<ApiResponse<PublicKeyResponse>> {
    let public_key = deployment
        .container()
        .notification_service()
        .web_push_public_key();

    Json(ApiResponse::success(PublicKeyResponse {
        enabled: public_key.is_some(),
        public_key,
    }))
}

async fn subscribe(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Json(payload): Json<SubscribeRequest>,
) -> (StatusCode, Json<ApiResponse<()>>) {
    if payload.endpoint.trim().is_empty()
        || payload.keys.p256dh.trim().is_empty()
        || payload.keys.auth.trim().is_empty()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(ApiResponse::error("invalid web push subscription")),
        );
    }

    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok());

    match deployment
        .container()
        .notification_service()
        .upsert_web_push_subscription(
            payload.endpoint.trim(),
            payload.keys.p256dh.trim(),
            payload.keys.auth.trim(),
            user_agent,
        )
        .await
    {
        Ok(()) => (StatusCode::NO_CONTENT, Json(ApiResponse::success(()))),
        Err(error) => {
            tracing::warn!(?error, "failed to save local web push subscription");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error("failed to save web push subscription")),
            )
        }
    }
}

async fn unsubscribe(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<UnsubscribeRequest>,
) -> (StatusCode, Json<ApiResponse<()>>) {
    if payload.endpoint.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ApiResponse::error("invalid web push subscription")),
        );
    }

    match deployment
        .container()
        .notification_service()
        .delete_web_push_subscription(payload.endpoint.trim())
        .await
    {
        Ok(()) => (StatusCode::NO_CONTENT, Json(ApiResponse::success(()))),
        Err(error) => {
            tracing::warn!(?error, "failed to delete local web push subscription");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error("failed to delete web push subscription")),
            )
        }
    }
}
