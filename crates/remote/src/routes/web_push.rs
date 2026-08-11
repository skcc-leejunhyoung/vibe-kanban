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
    db::{
        notifications::NotificationRepository, organizations::OrganizationRepository,
        projects::ProjectRepository, web_push::WebPushSubscriptionRepository,
        workspaces::WorkspaceRepository,
    },
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

    let notification_id =
        match resolve_notification_target(&state, &ctx, payload.workspace_id).await? {
            Some(target) => {
                match NotificationRepository::create(
                    state.pool(),
                    target.organization_id,
                    ctx.user.id,
                    api_types::NotificationType::WorkspaceTaskCompleted,
                    api_types::NotificationPayload {
                        deeplink_path: Some(target.deeplink_path),
                        title: Some(payload.title.clone()),
                        body: Some(payload.body.clone()),
                        workspace_id: payload.workspace_id,
                        ..Default::default()
                    },
                    target.issue_id,
                    None,
                )
                .await
                {
                    Ok(notification) => Some(notification.id),
                    Err(error) => {
                        tracing::warn!(?error, "failed to save workspace notification");
                        None
                    }
                }
            }
            None => None,
        };

    tokio::spawn(crate::web_push_notifications::send_custom_notification(
        state.pool().clone(),
        ctx.user.id,
        payload.title,
        payload.body,
        payload.workspace_id,
        notification_id,
    ));

    Ok(StatusCode::ACCEPTED)
}

/// Where an in-app notification row should hang: the org it belongs to, its
/// optional linked issue, and the deep-link the user clicks through to.
struct NotificationTarget {
    organization_id: Uuid,
    issue_id: Option<Uuid>,
    deeplink_path: String,
}

/// Resolve the in-app notification target for a forwarded workspace completion.
///
/// A regular workspace has a synced cloud row, so we hang the notification off
/// its project's organization and linked issue. A quick-chat (`in_place`)
/// workspace runs in the user's real checkout and is never synced to the cloud,
/// so `find_by_local_id` returns `None`; we fall back to the user's personal org
/// and the alias route so the completion still lands in the in-app list (the
/// OS/web push already fired independently).
async fn resolve_notification_target(
    state: &AppState,
    ctx: &RequestContext,
    workspace_id: Option<Uuid>,
) -> Result<Option<NotificationTarget>, ErrorResponse> {
    let Some(workspace_id) = workspace_id else {
        return Ok(None);
    };

    match WorkspaceRepository::find_by_local_id(state.pool(), workspace_id).await {
        Ok(Some(workspace)) if workspace.owner_user_id == ctx.user.id => {
            let organization_id =
                ProjectRepository::organization_id(state.pool(), workspace.project_id)
                    .await
                    .map_err(|error| {
                        tracing::warn!(
                            ?error,
                            %workspace_id,
                            "failed to resolve workspace notification organization"
                        );
                        ErrorResponse::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "internal server error",
                        )
                    })?
                    .ok_or_else(|| {
                        ErrorResponse::new(StatusCode::NOT_FOUND, "workspace project not found")
                    })?;

            Ok(Some(NotificationTarget {
                organization_id,
                issue_id: workspace.issue_id,
                deeplink_path: workspace_deeplink_path(workspace.host_id, workspace_id),
            }))
        }
        Ok(Some(_)) => Err(ErrorResponse::new(
            StatusCode::NOT_FOUND,
            "workspace not found",
        )),
        Ok(None) => Ok(personal_organization_id(state, ctx.user.id)
            .await
            .map(|organization_id| NotificationTarget {
                organization_id,
                issue_id: None,
                deeplink_path: workspace_deeplink_path(None, workspace_id),
            })),
        Err(error) => {
            tracing::warn!(?error, %workspace_id, "failed to load workspace");
            Ok(None)
        }
    }
}

/// The user's personal org (every signed-in user has one), else any org they
/// belong to. Used to anchor notifications that aren't tied to a cloud project.
async fn personal_organization_id(state: &AppState, user_id: Uuid) -> Option<Uuid> {
    let orgs = OrganizationRepository::new(state.pool())
        .list_user_organizations(user_id)
        .await
        .inspect_err(|error| {
            tracing::warn!(?error, %user_id, "failed to resolve personal org for notification");
        })
        .ok()?;

    pick_notification_org(&orgs)
}

/// Prefer the personal org, else fall back to any membership.
fn pick_notification_org(orgs: &[api_types::OrganizationWithRole]) -> Option<Uuid> {
    orgs.iter()
        .find(|org| org.is_personal)
        .or_else(|| orgs.first())
        .map(|org| org.id)
}

fn workspace_deeplink_path(host_id: Option<Uuid>, workspace_id: Uuid) -> String {
    match host_id {
        Some(host_id) => format!("/hosts/{host_id}/workspaces/{workspace_id}"),
        None => format!("/workspace/{workspace_id}"),
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::{pick_notification_org, workspace_deeplink_path};

    fn org(is_personal: bool) -> api_types::OrganizationWithRole {
        api_types::OrganizationWithRole {
            id: Uuid::new_v4(),
            name: "org".into(),
            slug: "org".into(),
            is_personal,
            issue_prefix: "ORG".into(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            user_role: api_types::MemberRole::Admin,
        }
    }

    #[test]
    fn pick_notification_org_prefers_personal() {
        let team = org(false);
        let personal = org(true);
        let orgs = vec![team, personal.clone()];

        assert_eq!(pick_notification_org(&orgs), Some(personal.id));
        assert_eq!(pick_notification_org(&[]), None);
        // No personal org -> falls back to the first membership.
        let team_only = org(false);
        assert_eq!(
            pick_notification_org(std::slice::from_ref(&team_only)),
            Some(team_only.id)
        );
    }

    #[test]
    fn workspace_notification_uses_host_scoped_route() {
        let host_id = Uuid::parse_str("018f5f99-7f0d-7a7f-9abc-001122334455").unwrap();
        let workspace_id = Uuid::parse_str("028f5f99-7f0d-7a7f-9abc-001122334455").unwrap();

        assert_eq!(
            workspace_deeplink_path(Some(host_id), workspace_id),
            "/hosts/018f5f99-7f0d-7a7f-9abc-001122334455/workspaces/028f5f99-7f0d-7a7f-9abc-001122334455"
        );
    }

    #[test]
    fn legacy_workspace_keeps_resolvable_alias_route() {
        let workspace_id = Uuid::parse_str("028f5f99-7f0d-7a7f-9abc-001122334455").unwrap();

        assert_eq!(
            workspace_deeplink_path(None, workspace_id),
            "/workspace/028f5f99-7f0d-7a7f-9abc-001122334455"
        );
    }
}
