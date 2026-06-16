use api_types::{UpdateUserNotificationPreferenceRequest, UserNotificationPreference};
use axum::{
    Json, Router,
    extract::{Extension, State},
    http::StatusCode,
    routing::{get, put},
};
use tracing::instrument;

use super::error::ErrorResponse;
use crate::{
    AppState, auth::RequestContext,
    db::user_notification_preferences::UserNotificationPreferenceRepository,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/user-notification-preferences", get(get_preference))
        .route("/user-notification-preferences", put(update_preference))
}

#[instrument(
    name = "user_notification_preferences.get",
    skip(state, ctx),
    fields(user_id = %ctx.user.id)
)]
async fn get_preference(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
) -> Result<Json<UserNotificationPreference>, ErrorResponse> {
    let preference =
        UserNotificationPreferenceRepository::find_or_default(state.pool(), ctx.user.id)
            .await
            .map_err(|error| {
                tracing::error!(?error, "failed to load user notification preference");
                ErrorResponse::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "failed to load notification settings",
                )
            })?;

    Ok(Json(preference))
}

#[instrument(
    name = "user_notification_preferences.update",
    skip(state, ctx, payload),
    fields(user_id = %ctx.user.id)
)]
async fn update_preference(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<UpdateUserNotificationPreferenceRequest>,
) -> Result<Json<UserNotificationPreference>, ErrorResponse> {
    let preference = UserNotificationPreferenceRepository::upsert(
        state.pool(),
        ctx.user.id,
        payload.review_requested_enabled,
    )
    .await
    .map_err(|error| {
        tracing::error!(?error, "failed to update user notification preference");
        ErrorResponse::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to update notification settings",
        )
    })?;

    Ok(Json(preference))
}
