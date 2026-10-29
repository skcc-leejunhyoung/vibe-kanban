use api_types::{Notification, NotificationType, notification_body};
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
    revision: i32,
}

pub fn spawn_delivery(pool: PgPool) {
    let watchdog = pool.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            interval.tick().await;
            if let Err(error) = sweep_expired(&watchdog).await {
                tracing::warn!(?error, "notification deadline sweep failed");
            }
        }
    });
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            interval.tick().await;
            if let Err(error) = drain_delivery(&pool).await {
                tracing::warn!(?error, "notification delivery sweep failed");
            }
        }
    });
}

pub(crate) async fn sweep_expired(pool: &PgPool) -> Result<(), sqlx::Error> {
    // A lost provider response is uncertain; replay could create another banner.
    sqlx::query("UPDATE notification_delivery_jobs SET status='uncertain',updated_at=NOW() WHERE status='sending' AND updated_at<NOW()-INTERVAL '90 seconds'").execute(pool).await?;
    let mut tx = pool.begin().await?;
    let ids=sqlx::query_scalar::<_,Uuid>(r#"
        SELECT n.id FROM notifications n LEFT JOIN notification_dispatches d ON d.notification_id=n.id AND d.revision=n.revision
        LEFT JOIN autopilot_notification_leases l ON l.id=d.lease_id
        LEFT JOIN notification_host_capabilities c ON c.host_id=l.host_id
        LEFT JOIN hosts h ON h.id=l.host_id
        WHERE n.routing_state IN ('autopilot_pending','autopilot_claimed') AND
          (d.notification_id IS NULL OR l.id IS NULL OR h.id IS NULL OR l.expires_at<=NOW() OR c.expires_at IS NULL OR c.expires_at<=NOW() OR h.owner_user_id<>n.user_id OR h.deleted_at IS NOT NULL
           OR EXISTS(SELECT 1 FROM hosts other LEFT JOIN notification_host_capabilities supported ON supported.host_id=other.id AND supported.user_id=n.user_id AND supported.expires_at>NOW() WHERE other.owner_user_id=n.user_id AND other.deleted_at IS NULL AND other.status='online' AND supported.host_id IS NULL)
           OR d.handoff_deadline<=NOW() OR (n.routing_state='autopilot_pending' AND d.pending_deadline<=NOW())
           OR (n.routing_state='autopilot_claimed' AND d.claim_expires_at<=NOW()))
        ORDER BY n.id LIMIT 500 FOR UPDATE OF n SKIP LOCKED"#).fetch_all(&mut *tx).await?;
    for id in ids {
        sqlx::query("UPDATE notifications SET routing_state='user',seen=false,dismissed_at=NULL WHERE id=$1").bind(id).execute(&mut *tx).await?;
        sqlx::query("UPDATE notification_dispatches SET reason='deadline_or_lease_expired' WHERE notification_id=$1").bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await
}

async fn drain_delivery(pool: &PgPool) -> Result<(), sqlx::Error> {
    use sqlx::Row;
    let Some(config) = WebPushConfig::from_env().ok().flatten() else {
        return Ok(());
    };
    let Ok(client) = IsahcWebPushClient::new() else {
        return Ok(());
    };
    for _ in 0..100 {
        let mut tx = pool.begin().await?;
        let job=sqlx::query("SELECT j.notification_id,j.revision,j.target_id FROM notification_delivery_jobs j JOIN notifications n ON n.id=j.notification_id AND n.revision=j.revision WHERE j.status='pending' AND j.updated_at<=NOW()-INTERVAL '5 seconds' AND j.channel='web_push' AND n.routing_state='user' AND NOT n.seen AND n.dismissed_at IS NULL ORDER BY j.updated_at LIMIT 1 FOR UPDATE OF n,j SKIP LOCKED").fetch_optional(&mut *tx).await?;
        let Some(job) = job else { break };
        let id: Uuid = job.get("notification_id");
        let revision: i32 = job.get("revision");
        let target: Uuid = job.get("target_id");
        let notification =
            crate::db::notifications::NotificationRepository::find_by_id(&mut *tx, id)
                .await
                .map_err(|e| match e {
                    crate::db::notifications::NotificationError::Database(e) => e,
                })?
                .ok_or(sqlx::Error::RowNotFound)?;
        let subscription = sqlx::query_as::<_, WebPushSubscription>(
            "SELECT * FROM web_push_subscriptions WHERE id=$1 AND user_id=$2",
        )
        .bind(target)
        .bind(notification.user_id)
        .fetch_optional(&mut *tx)
        .await?;
        if subscription.is_none() {
            sqlx::query("UPDATE notification_delivery_jobs SET status='cancelled',updated_at=NOW() WHERE notification_id=$1 AND revision=$2 AND channel='web_push' AND target_id=$3").bind(id).bind(revision).bind(target).execute(&mut *tx).await?;
            tx.commit().await?;
            continue;
        }
        let attempt = Uuid::new_v4();
        sqlx::query("UPDATE notification_delivery_jobs SET status='sending',attempt_token=$4,updated_at=NOW() WHERE notification_id=$1 AND revision=$2 AND channel='web_push' AND target_id=$3").bind(id).bind(revision).bind(target).bind(attempt).execute(&mut *tx).await?;
        tx.commit().await?;
        let subscription = subscription.unwrap();
        let url = remote_web_push_click_url(pool, &config, &notification).await;
        // The durable sending transition is the cancellation boundary. A crash here
        // stays uncertain rather than repeating an irreversible native alert.
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            send_to_subscription(
                &client,
                &config,
                &subscription,
                &notification,
                url.as_deref(),
            ),
        )
        .await;
        let status = match result {
            Ok(Ok(())) => "sent",
            Ok(Err((ref e, _))) if is_expired_subscription_error(e) => {
                let _ =
                    WebPushSubscriptionRepository::delete_by_endpoint(pool, &subscription.endpoint)
                        .await;
                "cancelled"
            }
            Ok(Err((_, false))) => "pending",
            _ => "uncertain",
        };
        sqlx::query("UPDATE notification_delivery_jobs SET status=$5,updated_at=NOW() WHERE notification_id=$1 AND revision=$2 AND channel='web_push' AND target_id=$3 AND attempt_token=$4").bind(id).bind(revision).bind(target).bind(attempt).bind(status).execute(pool).await?;
    }
    Ok(())
}

async fn send_to_subscription(
    client: &IsahcWebPushClient,
    config: &WebPushConfig,
    subscription: &WebPushSubscription,
    notification: &Notification,
    deeplink_path: Option<&str>,
) -> Result<(), (WebPushError, bool)> {
    let message = (|| -> Result<_, WebPushError> {
        let subscription_info = SubscriptionInfo::new(
            subscription.endpoint.as_str(),
            subscription.p256dh.as_str(),
            subscription.auth.as_str(),
        );

        let mut signature = VapidSignatureBuilder::from_base64(
            config.private_key.expose_secret(),
            &subscription_info,
        )?;
        signature.add_claim("sub", config.subject.as_str());
        let signature = signature.build()?;

        let payload = PushPayload {
            title: notification
                .payload
                .title
                .as_deref()
                .unwrap_or("Vibe Kanban"),
            body: notification_body(notification.notification_type, &notification.payload),
            deeplink_path,
            notification_id: notification.id.to_string(),
            revision: notification.revision,
        };
        let payload = serde_json::to_vec(&payload).map_err(|_| WebPushError::InvalidResponse)?;

        let mut message = WebPushMessageBuilder::new(&subscription_info);
        message.set_payload(ContentEncoding::Aes128Gcm, &payload);
        message.set_vapid_signature(signature);
        message.set_ttl(60 * 60 * 24);
        message.set_urgency(Urgency::Normal);

        message.build()
    })()
    .map_err(|error| (error, false))?;
    client.send(message).await.map_err(|error| (error, true))
}

async fn remote_web_push_click_url(
    pool: &PgPool,
    config: &WebPushConfig,
    notification: &Notification,
) -> Option<String> {
    let base_url = config.remote_base_url.as_deref()?;
    if notification.payload.workspace_id.is_some() || notification.payload.drawer_note_id.is_some()
    {
        return notification
            .payload
            .deeplink_path
            .as_deref()
            .map(|path| remote_path(base_url, path));
    }
    let workspace_id = notification_workspace_id(pool, notification).await;
    remote_web_push_click_url_from_parts(
        base_url,
        &config.workspace_path_template,
        notification.notification_type,
        notification.payload.pull_request_url.as_deref(),
        workspace_id,
        notification.payload.deeplink_path.as_deref(),
    )
}

fn remote_web_push_click_url_from_parts(
    base_url: &str,
    workspace_path_template: &str,
    notification_type: NotificationType,
    pull_request_url: Option<&str>,
    workspace_id: Option<Uuid>,
    deeplink_path: Option<&str>,
) -> Option<String> {
    if notification_type == NotificationType::PullRequestCommentAdded {
        return Some(match pull_request_url {
            Some(pull_request_url) => remote_path(
                base_url,
                &format!(
                    "/pull-requests?prUrl={}",
                    urlencoding::encode(pull_request_url)
                ),
            ),
            _ => remote_path(base_url, "/notifications"),
        });
    }

    if let Some(workspace_id) = workspace_id {
        return Some(remote_path(
            base_url,
            &workspace_path(workspace_path_template, workspace_id),
        ));
    }

    deeplink_path.map(|path| remote_path(base_url, path))
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

fn workspace_path(template: &str, workspace_id: Uuid) -> String {
    const DEFAULT_WORKSPACE_PATH_TEMPLATE: &str = "/workspace/{workspace_id}";

    let template = if template.contains("{workspace_id}") {
        template
    } else {
        tracing::warn!(
            "ignoring web push workspace path template without workspace_id placeholder"
        );
        DEFAULT_WORKSPACE_PATH_TEMPLATE
    };
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

#[cfg(test)]
mod tests {
    use api_types::NotificationType;
    use uuid::Uuid;

    use super::{remote_path, remote_web_push_click_url_from_parts, workspace_path};

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
    fn workspace_path_rejects_template_without_workspace_id() {
        let workspace_id = Uuid::parse_str("018f5f99-7f0d-7a7f-9abc-001122334455").unwrap();

        assert_eq!(
            workspace_path("/workspace", workspace_id),
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

    #[test]
    fn remote_web_push_click_url_prefers_workspace_over_deeplink_path() {
        let workspace_id = Uuid::parse_str("018f5f99-7f0d-7a7f-9abc-001122334455").unwrap();

        assert_eq!(
            remote_web_push_click_url_from_parts(
                "https://vk.example.com/",
                "/workspace/{workspace_id}",
                NotificationType::IssueCommentAdded,
                None,
                Some(workspace_id),
                Some("/projects/project-id/issues/issue-id"),
            ),
            Some(
                "https://vk.example.com/workspace/018f5f99-7f0d-7a7f-9abc-001122334455".to_string()
            )
        );
    }

    #[test]
    fn remote_web_push_click_url_uses_deeplink_without_workspace() {
        assert_eq!(
            remote_web_push_click_url_from_parts(
                "https://vk.example.com/",
                "/workspace/{workspace_id}",
                NotificationType::IssueCommentAdded,
                None,
                None,
                Some("/projects/project-id/issues/issue-id"),
            ),
            Some("https://vk.example.com/projects/project-id/issues/issue-id".to_string())
        );
    }

    #[test]
    fn pull_request_comment_uses_account_pull_request_route() {
        assert_eq!(
            remote_web_push_click_url_from_parts(
                "https://vk.example.com/",
                "/workspace/{workspace_id}",
                NotificationType::PullRequestCommentAdded,
                Some("https://github.com/BloopAI/vibe-kanban/pull/123"),
                None,
                Some("/projects/project-id/issues/issue-id"),
            ),
            Some(
                "https://vk.example.com/pull-requests?prUrl=https%3A%2F%2Fgithub.com%2FBloopAI%2Fvibe-kanban%2Fpull%2F123"
                    .to_string()
            )
        );
    }

    #[test]
    fn pull_request_comment_without_url_uses_notifications_fallback() {
        assert_eq!(
            remote_web_push_click_url_from_parts(
                "https://vk.example.com/",
                "/workspace/{workspace_id}",
                NotificationType::PullRequestCommentAdded,
                None,
                None,
                Some("/projects/project-id/issues/issue-id"),
            ),
            Some("https://vk.example.com/notifications".to_string())
        );
    }
}
