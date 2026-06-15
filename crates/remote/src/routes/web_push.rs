use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AppState,
    auth::RequestContext,
    config::WebPushConfig,
    db::web_push::WebPushSubscriptionRepository,
    routes::error::{ErrorResponse, db_error},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/web-push/public-key", get(public_key))
        .route(
            "/web-push/subscriptions",
            post(subscribe).delete(unsubscribe),
        )
        .route("/web-push/self", post(notify_self))
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

/// Forwarded local-host notification (e.g. coding-agent task completion) to be
/// delivered to the authenticated user's own web push subscriptions.
#[derive(Debug, Deserialize)]
struct SelfNotifyRequest {
    title: String,
    body: String,
    #[serde(default)]
    workspace_id: Option<Uuid>,
}

async fn public_key() -> Json<PublicKeyResponse> {
    let public_key = WebPushConfig::from_env()
        .ok()
        .flatten()
        .map(|config| config.public_key);

    Json(PublicKeyResponse {
        enabled: public_key.is_some(),
        public_key,
    })
}

async fn subscribe(
    State(state): State<AppState>,
    axum::extract::Extension(ctx): axum::extract::Extension<RequestContext>,
    headers: HeaderMap,
    Json(payload): Json<SubscribeRequest>,
) -> Result<StatusCode, ErrorResponse> {
    if payload.endpoint.trim().is_empty()
        || payload.keys.p256dh.trim().is_empty()
        || payload.keys.auth.trim().is_empty()
    {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "invalid web push subscription",
        ));
    }

    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok());

    WebPushSubscriptionRepository::upsert(
        state.pool(),
        ctx.user.id,
        payload.endpoint.trim(),
        payload.keys.p256dh.trim(),
        payload.keys.auth.trim(),
        user_agent,
    )
    .await
    .map_err(|error| {
        tracing::warn!(?error, user_id = %ctx.user.id, "failed to save web push subscription");
        db_error(error, "failed to save web push subscription")
    })?;

    Ok(StatusCode::NO_CONTENT)
}

async fn unsubscribe(
    State(state): State<AppState>,
    axum::extract::Extension(ctx): axum::extract::Extension<RequestContext>,
    Json(payload): Json<UnsubscribeRequest>,
) -> Result<StatusCode, ErrorResponse> {
    if payload.endpoint.trim().is_empty() {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "invalid web push subscription",
        ));
    }

    WebPushSubscriptionRepository::delete_for_user(
        state.pool(),
        ctx.user.id,
        payload.endpoint.trim(),
    )
    .await
    .map_err(|error| {
        tracing::warn!(?error, user_id = %ctx.user.id, "failed to delete web push subscription");
        db_error(error, "failed to delete web push subscription")
    })?;

    Ok(StatusCode::NO_CONTENT)
}

async fn notify_self(
    State(state): State<AppState>,
    axum::extract::Extension(ctx): axum::extract::Extension<RequestContext>,
    Json(payload): Json<SelfNotifyRequest>,
) -> Result<StatusCode, ErrorResponse> {
    if payload.title.trim().is_empty() && payload.body.trim().is_empty() {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "empty web push notification",
        ));
    }

    tokio::spawn(crate::web_push_notifications::send_custom_notification(
        state.pool().clone(),
        ctx.user.id,
        payload.title,
        payload.body,
        payload.workspace_id,
    ));

    Ok(StatusCode::ACCEPTED)
}
