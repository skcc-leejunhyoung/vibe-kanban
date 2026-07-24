use api_types::{UpdateUserWebSettingsRequest, UserWebSettings};
use axum::{
    Json, Router,
    extract::{Extension, State},
    http::StatusCode,
    routing::get,
};
use tracing::instrument;

use super::error::ErrorResponse;
use crate::{AppState, auth::RequestContext, db::user_web_settings::UserWebSettingsRepository};

pub fn router() -> Router<AppState> {
    Router::new().route("/user-web-settings", get(get_settings).put(update_settings))
}

#[instrument(
    name = "user_web_settings.get",
    skip(state, ctx),
    fields(user_id = %ctx.user.id)
)]
async fn get_settings(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
) -> Result<Json<UserWebSettings>, ErrorResponse> {
    let settings = UserWebSettingsRepository::find_or_default(state.pool(), ctx.user.id)
        .await
        .map_err(|error| {
            tracing::error!(?error, "failed to load user web settings");
            ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to load remote web settings",
            )
        })?;

    Ok(Json(settings))
}

#[instrument(
    name = "user_web_settings.update",
    skip(state, ctx, payload),
    fields(user_id = %ctx.user.id)
)]
async fn update_settings(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<UpdateUserWebSettingsRequest>,
) -> Result<Json<UserWebSettings>, ErrorResponse> {
    let settings = UserWebSettingsRepository::upsert(state.pool(), ctx.user.id, payload.settings)
        .await
        .map_err(|error| {
            tracing::error!(?error, "failed to update user web settings");
            ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to save remote web settings",
            )
        })?;

    Ok(Json(settings))
}
