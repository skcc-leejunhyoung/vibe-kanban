use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum ScheduledResumeError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// A wakeup the coding agent scheduled for itself (claude `ScheduleWakeup`,
/// surfaced as a `session_crons` entry in the Stop hook input). The agent ends
/// its turn and a background watcher resumes the session with `prompt` once
/// `next_fire_at` passes — implementing the CLI's "the harness re-invokes you
/// when the wakeup fires" contract that vibe-kanban must fulfil itself.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct ScheduledResume {
    pub id: Uuid,
    pub session_id: Uuid,
    /// The CLI's session_cron id, used to dedupe re-reported crons.
    pub cron_id: String,
    /// Prompt to resume the session with when the wakeup fires.
    pub prompt: String,
    /// Raw cron expression from the CLI (e.g. "21 14 * * *"); kept so the
    /// watcher can compute the next fire time for recurring wakeups.
    pub schedule: String,
    pub recurring: bool,
    pub next_fire_at: DateTime<Utc>,
    /// pending | fired | cancelled
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const COLUMNS: &str = "id, session_id, cron_id, prompt, schedule, recurring, \
                       next_fire_at, status, created_at, updated_at";

impl ScheduledResume {
    /// Register a scheduled resume, ignoring duplicates for the same
    /// (session_id, cron_id). The CLI re-reports every active cron on every
    /// Stop hook, so the unique index + DO NOTHING keeps a wakeup registered
    /// exactly once (and prevents a fired one-shot from being re-armed).
    pub async fn upsert(
        pool: &SqlitePool,
        session_id: Uuid,
        cron_id: &str,
        prompt: &str,
        schedule: &str,
        recurring: bool,
        next_fire_at: DateTime<Utc>,
    ) -> Result<(), ScheduledResumeError> {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO scheduled_resumes \
             (id, session_id, cron_id, prompt, schedule, recurring, next_fire_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(session_id, cron_id) DO NOTHING",
        )
        .bind(id)
        .bind(session_id)
        .bind(cron_id)
        .bind(prompt)
        .bind(schedule)
        .bind(recurring)
        .bind(next_fire_at)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Pending resumes whose fire time has passed, oldest first.
    pub async fn find_due(
        pool: &SqlitePool,
        now: DateTime<Utc>,
    ) -> Result<Vec<Self>, ScheduledResumeError> {
        let rows = sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM scheduled_resumes \
             WHERE status = 'pending' AND next_fire_at <= ? \
             ORDER BY next_fire_at ASC"
        ))
        .bind(now)
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// Mark a one-shot resume as fired so it is not picked up again.
    pub async fn mark_fired(pool: &SqlitePool, id: Uuid) -> Result<(), ScheduledResumeError> {
        sqlx::query(
            "UPDATE scheduled_resumes \
             SET status = 'fired', updated_at = datetime('now','subsec') \
             WHERE id = ?",
        )
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Reschedule a recurring resume to its next fire time, keeping it pending.
    pub async fn reschedule(
        pool: &SqlitePool,
        id: Uuid,
        next_fire_at: DateTime<Utc>,
    ) -> Result<(), ScheduledResumeError> {
        sqlx::query(
            "UPDATE scheduled_resumes \
             SET next_fire_at = ?, updated_at = datetime('now','subsec') \
             WHERE id = ?",
        )
        .bind(next_fire_at)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Cancel all pending resumes for a session (e.g. when the user takes over).
    pub async fn cancel_pending_for_session(
        pool: &SqlitePool,
        session_id: Uuid,
    ) -> Result<u64, ScheduledResumeError> {
        let res = sqlx::query(
            "UPDATE scheduled_resumes \
             SET status = 'cancelled', updated_at = datetime('now','subsec') \
             WHERE session_id = ? AND status = 'pending'",
        )
        .bind(session_id)
        .execute(pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// Compute the next fire time strictly after `after` for a claude
    /// `session_crons` schedule (5-field cron: minute hour day month weekday).
    /// Returns None if the expression cannot be parsed.
    pub fn next_fire_after(schedule: &str, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        // The `cron` crate expects 6 fields (leading seconds); claude emits 5.
        let with_seconds = format!("0 {schedule}");
        cron::Schedule::from_str(&with_seconds)
            .ok()?
            .after(&after)
            .next()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(rfc3339: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn parses_claude_five_field_cron_same_day() {
        // "21 14 * * *" = daily 14:21; from 10:00 the next fire is the same day.
        let next = ScheduledResume::next_fire_after("21 14 * * *", at("2026-06-18T10:00:00Z"));
        assert_eq!(next.unwrap().to_rfc3339(), "2026-06-18T14:21:00+00:00");
    }

    #[test]
    fn rolls_to_next_day_when_time_already_passed() {
        let next = ScheduledResume::next_fire_after("21 14 * * *", at("2026-06-18T15:00:00Z"));
        assert_eq!(next.unwrap().to_rfc3339(), "2026-06-19T14:21:00+00:00");
    }

    #[test]
    fn invalid_schedule_returns_none() {
        assert!(
            ScheduledResume::next_fire_after("not a cron", at("2026-06-18T10:00:00Z")).is_none()
        );
    }
}
