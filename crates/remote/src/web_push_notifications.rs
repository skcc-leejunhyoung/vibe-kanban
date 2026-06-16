use api_types::{Notification, NotificationPayload, NotificationType};
use secrecy::ExposeSecret;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, Urgency, VapidSignatureBuilder,
    WebPushClient, WebPushError, WebPushMessageBuilder,
};

use crate::{
    config::WebPushConfig,
    db::web_push::{WebPushSubscription, WebPushSubscriptionRepository},
};

#[derive(Debug, Serialize)]
struct PushPayload<'a> {
    title: &'a str,
    body: String,
    deeplink_path: Option<&'a str>,
    notification_id: String,
}

pub async fn send_notification(pool: PgPool, notification: Notification) {
    let Some(config) = WebPushConfig::from_env().ok().flatten() else {
        return;
    };

    let subscriptions =
        match WebPushSubscriptionRepository::list_by_user(&pool, notification.user_id).await {
            Ok(subscriptions) => subscriptions,
            Err(error) => {
                tracing::warn!(
                    ?error,
                    user_id = %notification.user_id,
                    "failed to list web push subscriptions"
                );
                return;
            }
        };

    if subscriptions.is_empty() {
        return;
    }

    let client = match IsahcWebPushClient::new() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(?error, "failed to initialize web push client");
            return;
        }
    };
    let deeplink_path = remote_web_push_click_url(&pool, &config, &notification).await;

    for subscription in subscriptions {
        if let Err(error) = send_to_subscription(
            &client,
            &config,
            &subscription,
            &notification,
            deeplink_path.as_deref(),
        )
        .await
        {
            tracing::warn!(
                error = %error,
                error_kind = error.short_description(),
                subscription_id = %subscription.id,
                user_id = %subscription.user_id,
                "failed to send web push notification"
            );

            if is_expired_subscription_error(&error)
                && let Err(delete_error) =
                    WebPushSubscriptionRepository::delete_by_endpoint(&pool, &subscription.endpoint)
                        .await
            {
                tracing::warn!(
                    ?delete_error,
                    subscription_id = %subscription.id,
                    "failed to delete expired web push subscription"
                );
            }
        }
    }
}

async fn send_to_subscription(
    client: &IsahcWebPushClient,
    config: &WebPushConfig,
    subscription: &WebPushSubscription,
    notification: &Notification,
    deeplink_path: Option<&str>,
) -> Result<(), WebPushError> {
    let subscription_info = SubscriptionInfo::new(
        subscription.endpoint.as_str(),
        subscription.p256dh.as_str(),
        subscription.auth.as_str(),
    );

    let mut signature =
        VapidSignatureBuilder::from_base64(config.private_key.expose_secret(), &subscription_info)?;
    signature.add_claim("sub", config.subject.as_str());
    let signature = signature.build()?;

    let payload = PushPayload {
        title: "Vibe Kanban",
        body: notification_body(notification.notification_type, &notification.payload),
        deeplink_path,
        notification_id: notification.id.to_string(),
    };
    let payload = serde_json::to_vec(&payload).map_err(|_| WebPushError::InvalidResponse)?;

    let mut message = WebPushMessageBuilder::new(&subscription_info);
    message.set_payload(ContentEncoding::Aes128Gcm, &payload);
    message.set_vapid_signature(signature);
    message.set_ttl(60 * 60 * 24);
    message.set_urgency(Urgency::Normal);

    client.send(message.build()?).await
}

/// Send an arbitrary push to all of a user's web push subscriptions.
///
/// Used to forward a local host event (e.g. a coding-agent workspace/task
/// completion) to the user's remote devices (phone, etc.) via the authenticated
/// `POST /v1/web-push/self` endpoint.
pub async fn send_custom_notification(
    pool: PgPool,
    user_id: Uuid,
    title: String,
    body: String,
    workspace_id: Option<Uuid>,
) {
    let Some(config) = WebPushConfig::from_env().ok().flatten() else {
        return;
    };

    let subscriptions = match WebPushSubscriptionRepository::list_by_user(&pool, user_id).await {
        Ok(subscriptions) => subscriptions,
        Err(error) => {
            tracing::warn!(?error, %user_id, "failed to list web push subscriptions");
            return;
        }
    };

    if subscriptions.is_empty() {
        return;
    }

    let client = match IsahcWebPushClient::new() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(?error, "failed to initialize web push client");
            return;
        }
    };

    let deeplink_path = match (workspace_id, config.remote_base_url.as_deref()) {
        (Some(workspace_id), Some(base_url)) => match resolve_user_host_id(&pool, user_id).await {
            // Direct link to the workspace on its host. This is the canonical
            // route (`/hosts/{host}/workspaces/{ws}`); the `/workspace/{ws}`
            // alias requires client-side host resolution which is unreliable.
            Some(host_id) => Some(format!(
                "{base_url}/hosts/{host_id}/workspaces/{workspace_id}"
            )),
            None => Some(format!(
                "{base_url}{}",
                workspace_path(&config.workspace_path_template, workspace_id)
            )),
        },
        _ => None,
    };

    for subscription in subscriptions {
        if let Err(error) = send_custom_to_subscription(
            &client,
            &config,
            &subscription,
            &title,
            &body,
            deeplink_path.as_deref(),
        )
        .await
        {
            tracing::warn!(
                error = %error,
                error_kind = error.short_description(),
                subscription_id = %subscription.id,
                user_id = %subscription.user_id,
                "failed to send custom web push notification"
            );

            if is_expired_subscription_error(&error)
                && let Err(delete_error) =
                    WebPushSubscriptionRepository::delete_by_endpoint(&pool, &subscription.endpoint)
                        .await
            {
                tracing::warn!(
                    ?delete_error,
                    subscription_id = %subscription.id,
                    "failed to delete expired web push subscription"
                );
            }
        }
    }
}

async fn send_custom_to_subscription(
    client: &IsahcWebPushClient,
    config: &WebPushConfig,
    subscription: &WebPushSubscription,
    title: &str,
    body: &str,
    deeplink_path: Option<&str>,
) -> Result<(), WebPushError> {
    let subscription_info = SubscriptionInfo::new(
        subscription.endpoint.as_str(),
        subscription.p256dh.as_str(),
        subscription.auth.as_str(),
    );

    let mut signature =
        VapidSignatureBuilder::from_base64(config.private_key.expose_secret(), &subscription_info)?;
    signature.add_claim("sub", config.subject.as_str());
    let signature = signature.build()?;

    let payload = PushPayload {
        title,
        body: body.to_string(),
        deeplink_path,
        notification_id: Uuid::new_v4().to_string(),
    };
    let payload = serde_json::to_vec(&payload).map_err(|_| WebPushError::InvalidResponse)?;

    let mut message = WebPushMessageBuilder::new(&subscription_info);
    message.set_payload(ContentEncoding::Aes128Gcm, &payload);
    message.set_vapid_signature(signature);
    message.set_ttl(60 * 60 * 24);
    message.set_urgency(Urgency::Normal);

    client.send(message.build()?).await
}

async fn remote_web_push_click_url(
    pool: &PgPool,
    config: &WebPushConfig,
    notification: &Notification,
) -> Option<String> {
    let base_url = config.remote_base_url.as_deref()?;
    if let Some(path) = notification.payload.deeplink_path.as_deref() {
        return Some(remote_path(base_url, path));
    }

    let workspace_id = notification_workspace_id(pool, notification).await?;
    Some(remote_path(
        base_url,
        &workspace_path(&config.workspace_path_template, workspace_id),
    ))
}

async fn notification_workspace_id(pool: &PgPool, notification: &Notification) -> Option<Uuid> {
    let issue_id = notification.payload.issue_id.or(notification.issue_id)?;

    match sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT local_workspace_id
        FROM workspaces
        WHERE issue_id = $1
          AND owner_user_id = $2
          AND local_workspace_id IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
        "#,
    )
    .bind(issue_id)
    .bind(notification.user_id)
    .fetch_optional(pool)
    .await
    {
        Ok(workspace_id) => workspace_id,
        Err(error) => {
            tracing::warn!(
                ?error,
                notification_id = %notification.id,
                issue_id = %issue_id,
                "failed to resolve web push workspace URL"
            );
            None
        }
    }
}

/// Resolve the host a user's workspace deep-link should point at. Prefers an
/// online host, falling back to the most recently seen one.
async fn resolve_user_host_id(pool: &PgPool, user_id: Uuid) -> Option<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT id
        FROM hosts
        WHERE owner_user_id = $1
        ORDER BY (status = 'online') DESC, last_seen_at DESC NULLS LAST
        LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

fn workspace_path(template: &str, workspace_id: Uuid) -> String {
    let path = template.replace("{workspace_id}", &workspace_id.to_string());

    if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    }
}

fn remote_path(base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn is_expired_subscription_error(error: &WebPushError) -> bool {
    matches!(
        error,
        WebPushError::EndpointNotFound(_) | WebPushError::EndpointNotValid(_)
    )
}

fn notification_body(notification_type: NotificationType, payload: &NotificationPayload) -> String {
    let issue = issue_label(payload);
    match notification_type {
        NotificationType::IssueCommentAdded => format!("{issue}: new comment"),
        NotificationType::IssueStatusChanged => {
            if let Some(status) = payload.new_status_name.as_deref() {
                format!("{issue}: moved to {status}")
            } else {
                format!("{issue}: status changed")
            }
        }
        NotificationType::IssueAssigneeChanged => format!("{issue}: assignee changed"),
        NotificationType::IssuePriorityChanged => format!("{issue}: priority changed"),
        NotificationType::IssueUnassigned => format!("{issue}: unassigned"),
        NotificationType::IssueCommentReaction => {
            if let Some(emoji) = payload.emoji.as_deref() {
                format!("{issue}: reacted with {emoji}")
            } else {
                format!("{issue}: new reaction")
            }
        }
        NotificationType::IssueDeleted => format!("{issue}: issue deleted"),
        NotificationType::IssueTitleChanged => format!("{issue}: title changed"),
        NotificationType::IssueDescriptionChanged => format!("{issue}: description changed"),
        NotificationType::IssueReviewRequested => format!("{issue}: ready for review"),
    }
}

fn issue_label(payload: &NotificationPayload) -> String {
    match (
        payload.issue_simple_id.as_deref(),
        payload.issue_title.as_deref(),
    ) {
        (Some(simple_id), Some(title)) => format!("{simple_id} {title}"),
        (Some(simple_id), None) => simple_id.to_string(),
        (None, Some(title)) => title.to_string(),
        (None, None) => "Issue".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::{remote_path, workspace_path};

    #[test]
    fn workspace_path_uses_workspace_alias() {
        let workspace_id = Uuid::parse_str("018f5f99-7f0d-7a7f-9abc-001122334455").unwrap();

        assert_eq!(
            workspace_path("/workspace/{workspace_id}", workspace_id),
            "/workspace/018f5f99-7f0d-7a7f-9abc-001122334455"
        );
    }

    #[test]
    fn workspace_path_adds_leading_slash() {
        let workspace_id = Uuid::parse_str("018f5f99-7f0d-7a7f-9abc-001122334455").unwrap();

        assert_eq!(
            workspace_path("workspace/{workspace_id}", workspace_id),
            "/workspace/018f5f99-7f0d-7a7f-9abc-001122334455"
        );
    }

    #[test]
    fn remote_path_joins_base_url_and_deeplink_path() {
        assert_eq!(
            remote_path("https://vk.example.com/", "/projects/p/issues/i"),
            "https://vk.example.com/projects/p/issues/i"
        );
    }
}
