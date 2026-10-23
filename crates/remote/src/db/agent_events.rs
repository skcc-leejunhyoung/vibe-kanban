use api_types::{AgentEvent, PushedAgentEvent};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

/// Writers take it exclusively and readers shared, so ids commit in order and a
/// reader's cursor never jumps past a row that commits later.
// ponytail: one global lock serializes pushes from every host; shard it per
// owner if push volume ever makes it contend.
const AGENT_EVENTS_LOCK: i64 = 0x5641_4745_4e54; // "VAGENT"

/// How long events stay readable.
const RETENTION_DAYS: i32 = 3;

/// Store a host's batch; already stored `(host_id, host_cursor)` pairs are
/// skipped, so a retried push is harmless. Returns the number of new rows.
pub async fn insert_batch(
    pool: &PgPool,
    owner_user_id: Uuid,
    host_id: Uuid,
    events: &[PushedAgentEvent],
) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(AGENT_EVENTS_LOCK)
        .execute(&mut *tx)
        .await?;
    let mut inserted = 0;
    for event in events {
        inserted += sqlx::query(
            "INSERT INTO agent_events
                (owner_user_id, host_id, host_cursor, kind, workspace_id, session_id,
                 execution_id, autopilot, data, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (host_id, host_cursor) DO NOTHING",
        )
        .bind(owner_user_id)
        .bind(host_id)
        .bind(event.host_cursor)
        .bind(&event.kind)
        .bind(event.workspace_id)
        .bind(event.session_id)
        .bind(event.execution_id)
        .bind(event.autopilot)
        .bind(&event.data)
        .bind(event.at)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    }
    sqlx::query("DELETE FROM agent_events WHERE created_at < NOW() - make_interval(days => $1)")
        .bind(RETENTION_DAYS)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(inserted)
}

#[derive(FromRow)]
struct AgentEventRow {
    id: i64,
    occurred_at: DateTime<Utc>,
    kind: String,
    host_id: Uuid,
    host_name: String,
    workspace_id: Option<Uuid>,
    session_id: Option<Uuid>,
    execution_id: Option<Uuid>,
    autopilot: bool,
    data: Value,
}

/// The owner's events after `since` whose kind starts with one of `kinds`
/// (empty = all), oldest first, plus the cursor to resume from.
pub async fn list(
    pool: &PgPool,
    owner_user_id: Uuid,
    since: i64,
    kinds: &[String],
    limit: i64,
) -> Result<(Vec<AgentEvent>, i64), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
        .bind(AGENT_EVENTS_LOCK)
        .execute(&mut *tx)
        .await?;
    let patterns: Vec<String> = kinds
        .iter()
        .map(|kind| format!("{}%", escape_like(kind.trim_end_matches('*'))))
        .collect();
    let rows = sqlx::query_as::<_, AgentEventRow>(
        "SELECT e.id, e.occurred_at, e.kind, e.host_id,
                COALESCE(h.custom_name, h.name) AS host_name,
                e.workspace_id, e.session_id, e.execution_id, e.autopilot, e.data
         FROM agent_events e
         JOIN hosts h ON h.id = e.host_id
         WHERE e.owner_user_id = $1
           AND e.id > $2
           AND (cardinality($3::text[]) = 0 OR e.kind LIKE ANY($3))
         ORDER BY e.id
         LIMIT $4",
    )
    .bind(owner_user_id)
    .bind(since)
    .bind(&patterns)
    .bind(limit)
    .fetch_all(&mut *tx)
    .await?;
    // A full page may have more behind it; otherwise everything up to the
    // sequence's last id is visible (the shared lock waits out writers).
    let cursor =
        match rows.last() {
            Some(last) if rows.len() as i64 == limit => last.id,
            _ => sqlx::query_scalar::<_, i64>(
                "SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM agent_events_id_seq",
            )
            .fetch_one(&mut *tx)
            .await?,
        };
    tx.commit().await?;
    let events = rows
        .into_iter()
        .map(|row| AgentEvent {
            cursor: row.id,
            at: row.occurred_at,
            kind: row.kind,
            host_id: row.host_id,
            host_name: row.host_name,
            workspace_id: row.workspace_id,
            session_id: row.session_id,
            execution_id: row.execution_id,
            autopilot: row.autopilot,
            data: row.data,
        })
        .collect();
    Ok((events, cursor))
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;

    use super::*;

    fn event(host_cursor: i64, kind: &str) -> PushedAgentEvent {
        PushedAgentEvent {
            host_cursor,
            at: Utc::now(),
            kind: kind.to_string(),
            workspace_id: None,
            session_id: None,
            execution_id: None,
            autopilot: false,
            data: json!({ "n": host_cursor }),
        }
    }

    async fn user_with_host(pool: &PgPool, name: &str) -> (Uuid, Uuid) {
        let user = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, email) VALUES ($1, $2)")
            .bind(user)
            .bind(format!("{user}@example.test"))
            .execute(pool)
            .await
            .unwrap();
        let host = sqlx::query_scalar(
            "INSERT INTO hosts (owner_user_id, machine_id, name) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(user)
        .bind(format!("machine-{user}"))
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap();
        (user, host)
    }

    #[tokio::test]
    #[ignore = "requires AGENT_EVENTS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
    async fn stream_is_per_owner_idempotent_and_resumable() {
        let url = std::env::var("AGENT_EVENTS_TEST_DATABASE_URL")
            .expect("provide a migrated disposable PostgreSQL database");
        let pool = PgPool::connect(&url).await.unwrap();
        let (owner, main) = user_with_host(&pool, "main").await;
        let (_, other_host) = user_with_host(&pool, "stranger").await;
        let second = sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO hosts (owner_user_id, machine_id, name) VALUES ($1, $2, 'i9') RETURNING id",
        )
        .bind(owner)
        .bind(format!("i9-{owner}"))
        .fetch_one(&pool)
        .await
        .unwrap();

        // Seeding from the end sees nothing but gets a usable cursor.
        let (events, start) = list(&pool, owner, i64::MAX, &[], 1).await.unwrap();
        assert!(events.is_empty());

        let batch = [event(1, "process.completed"), event(2, "approval.pending")];
        assert_eq!(insert_batch(&pool, owner, main, &batch).await.unwrap(), 2);
        // A retried push stores nothing twice.
        assert_eq!(insert_batch(&pool, owner, main, &batch).await.unwrap(), 0);
        insert_batch(&pool, owner, second, &[event(1, "process.failed")])
            .await
            .unwrap();
        insert_batch(
            &pool,
            Uuid::nil(),
            other_host,
            &[event(9, "process.failed")],
        )
        .await
        .unwrap_err(); // owner must exist
        let (stranger, _) = user_with_host(&pool, "x").await;
        insert_batch(&pool, stranger, other_host, &[event(9, "process.failed")])
            .await
            .unwrap();

        let (events, cursor) = list(&pool, owner, start, &[], 100).await.unwrap();
        let seen: Vec<(String, String)> = events
            .iter()
            .map(|e| (e.host_name.clone(), e.kind.clone()))
            .collect();
        assert_eq!(
            seen,
            [
                ("main".to_string(), "process.completed".to_string()),
                ("main".to_string(), "approval.pending".to_string()),
                ("i9".to_string(), "process.failed".to_string()),
            ]
        );
        assert!(cursor >= events.last().unwrap().cursor);
        assert!(
            list(&pool, owner, cursor, &[], 100)
                .await
                .unwrap()
                .0
                .is_empty()
        );

        // Kind prefixes filter; a full page resumes right after its last event.
        let (filtered, _) = list(&pool, owner, start, &["process.".to_string()], 100)
            .await
            .unwrap();
        assert_eq!(filtered.len(), 2);
        let (first, page_cursor) = list(&pool, owner, start, &[], 1).await.unwrap();
        assert_eq!(page_cursor, first[0].cursor);
        let (rest, _) = list(&pool, owner, page_cursor, &[], 100).await.unwrap();
        assert_eq!(rest.len(), 2);
    }
}
