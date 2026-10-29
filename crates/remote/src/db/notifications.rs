use api_types::{
    Notification, NotificationIntent, NotificationPayload, NotificationRoutingState,
    NotificationType,
};
use chrono::{DateTime, Utc};
use sqlx::{Executor, FromRow, Postgres};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum NotificationError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, FromRow)]
struct NotificationRow {
    source_key: Option<String>,
    intent: NotificationIntent,
    routing_state: NotificationRoutingState,
    revision: i32,
    id: Uuid,
    organization_id: Uuid,
    user_id: Uuid,
    notification_type: NotificationType,
    payload: sqlx::types::Json<NotificationPayload>,
    issue_id: Option<Uuid>,
    comment_id: Option<Uuid>,
    seen: bool,
    dismissed_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

impl From<NotificationRow> for Notification {
    fn from(row: NotificationRow) -> Self {
        Self {
            source_key: row.source_key,
            intent: row.intent,
            routing_state: row.routing_state,
            revision: row.revision,
            id: row.id,
            organization_id: row.organization_id,
            user_id: row.user_id,
            notification_type: row.notification_type,
            payload: row.payload.0,
            issue_id: row.issue_id,
            comment_id: row.comment_id,
            seen: row.seen,
            dismissed_at: row.dismissed_at,
            created_at: row.created_at,
        }
    }
}

pub struct NotificationRepository;

impl NotificationRepository {
    pub async fn find_by_id<'e, E: Executor<'e, Database = Postgres>>(
        executor: E,
        id: Uuid,
    ) -> Result<Option<Notification>, NotificationError> {
        Ok(
            sqlx::query_as::<_, NotificationRow>("SELECT * FROM notifications WHERE id = $1")
                .bind(id)
                .fetch_optional(executor)
                .await?
                .map(Into::into),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create<'e, E: Executor<'e, Database = Postgres>>(
        executor: E,
        organization_id: Uuid,
        user_id: Uuid,
        notification_type: NotificationType,
        payload: NotificationPayload,
        issue_id: Option<Uuid>,
        comment_id: Option<Uuid>,
    ) -> Result<Notification, NotificationError> {
        Self::create_with_intent(
            executor,
            organization_id,
            user_id,
            notification_type,
            payload,
            issue_id,
            comment_id,
            NotificationIntent::RawEvent,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_with_intent<'e, E: Executor<'e, Database = Postgres>>(
        executor: E,
        organization_id: Uuid,
        user_id: Uuid,
        notification_type: NotificationType,
        payload: NotificationPayload,
        issue_id: Option<Uuid>,
        comment_id: Option<Uuid>,
        intent: NotificationIntent,
        source_key: Option<&str>,
    ) -> Result<Notification, NotificationError> {
        Ok(sqlx::query_as::<_, NotificationRow>(
            "INSERT INTO notifications (organization_id, user_id, notification_type, payload, issue_id, comment_id, intent, source_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id, (COALESCE(payload->>'host_id','')), source_key) WHERE source_key IS NOT NULL DO UPDATE SET source_key = EXCLUDED.source_key RETURNING *")
            .bind(organization_id).bind(user_id).bind(notification_type).bind(sqlx::types::Json(payload)).bind(issue_id).bind(comment_id).bind(intent).bind(source_key)
            .fetch_one(executor).await?.into())
    }

    pub async fn list_by_user<'e, E: Executor<'e, Database = Postgres>>(
        executor: E,
        user_id: Uuid,
        include_dismissed: bool,
    ) -> Result<Vec<Notification>, NotificationError> {
        Ok(sqlx::query_as::<_, NotificationRow>("SELECT * FROM notifications WHERE user_id = $1 AND routing_state IN ('user','autopilot_consumed') AND ($2 OR dismissed_at IS NULL) ORDER BY created_at DESC")
            .bind(user_id).bind(include_dismissed).fetch_all(executor).await?.into_iter().map(Into::into).collect())
    }

    pub async fn update<'e, E: Executor<'e, Database = Postgres>>(
        executor: E,
        id: Uuid,
        seen: Option<bool>,
        archived: Option<bool>,
    ) -> Result<Notification, NotificationError> {
        Ok(sqlx::query_as::<_, NotificationRow>("UPDATE notifications SET seen = COALESCE($2,seen), dismissed_at = CASE WHEN $3 = false THEN NULL WHEN ($3 = true OR ($3 IS NULL AND $2 = true)) THEN COALESCE(dismissed_at,NOW()) ELSE dismissed_at END WHERE id=$1 AND routing_state NOT IN ('autopilot_pending','autopilot_claimed') RETURNING *")
            .bind(id).bind(seen).bind(archived).fetch_one(executor).await?.into())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_recent<'e, E: Executor<'e, Database = Postgres>>(
        executor: E,
        organization_id: Uuid,
        user_id: Uuid,
        notification_type: NotificationType,
        payload: NotificationPayload,
        issue_id: Option<Uuid>,
        comment_id: Option<Uuid>,
    ) -> Result<Notification, NotificationError> {
        Ok(sqlx::query_as::<_, NotificationRow>(r#"
            WITH existing AS (SELECT id FROM notifications WHERE user_id=$2 AND notification_type=$3 AND issue_id IS NOT DISTINCT FROM $5 AND comment_id IS NOT DISTINCT FROM $6 AND created_at > NOW()-INTERVAL '1 minute' ORDER BY created_at DESC LIMIT 1 FOR UPDATE),
            updated AS (UPDATE notifications SET payload=$4, seen=false, dismissed_at=NULL, created_at=clock_timestamp(), intent='raw_event' WHERE id=(SELECT id FROM existing) RETURNING *),
            inserted AS (INSERT INTO notifications (organization_id,user_id,notification_type,payload,issue_id,comment_id,intent) SELECT $1,$2,$3,$4,$5,$6,'raw_event' WHERE NOT EXISTS (SELECT 1 FROM existing) RETURNING *)
            SELECT * FROM updated UNION ALL SELECT * FROM inserted"#)
            .bind(organization_id).bind(user_id).bind(notification_type).bind(sqlx::types::Json(payload)).bind(issue_id).bind(comment_id).fetch_one(executor).await?.into())
    }

    pub async fn delete<'e, E: Executor<'e, Database = Postgres>>(
        executor: E,
        id: Uuid,
    ) -> Result<(), NotificationError> {
        sqlx::query("DELETE FROM notifications WHERE id=$1")
            .bind(id)
            .execute(executor)
            .await?;
        Ok(())
    }
}
