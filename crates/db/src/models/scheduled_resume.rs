use std::str::FromStr;

use chrono::{DateTime, Duration, TimeZone, Utc};
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

    /// Cron has one-minute resolution, so when registering a wakeup we treat the
    /// just-elapsed minute as still due: if the agent's turn ends a few seconds
    /// past the target minute, the wakeup fires now instead of being deferred a
    /// whole period. 60s exactly covers "the current minute".
    const REGISTRATION_LOOKBACK_SECS: i64 = 60;

    /// Compute the next fire time strictly after `after` for a claude
    /// `session_crons` schedule (5-field cron: minute hour day month weekday).
    /// Returns None if the expression cannot be parsed.
    ///
    /// Claude Code interprets self-scheduled crons in the **local system
    /// timezone** ("0 9 * * *" means 9am local, not UTC; see its scheduled-tasks
    /// docs), and the CLI runs on the same machine as this server, so the cron
    /// fields are evaluated against `chrono::Local`'s wall clock.
    pub fn next_fire_after(schedule: &str, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        Self::next_fire_after_in_tz(schedule, after, &chrono::Local)
    }

    /// The `next_fire_at` to persist when (re-)registering a cron observed at
    /// `now`. Applies [`REGISTRATION_LOOKBACK_SECS`] so a wakeup whose target
    /// minute has only just elapsed still fires promptly rather than rolling to
    /// the next period. Used only at registration time; recurring reschedules
    /// use [`next_fire_after`] (strict) to avoid re-firing the occurrence that
    /// was just handled.
    pub fn next_fire_at_for_registration(
        schedule: &str,
        now: DateTime<Utc>,
    ) -> Option<DateTime<Utc>> {
        Self::next_fire_after(
            schedule,
            now - Duration::seconds(Self::REGISTRATION_LOOKBACK_SECS),
        )
    }

    /// Like [`next_fire_after`] but evaluates the cron fields in an explicit
    /// timezone's wall clock. Kept separate so tests can pin a timezone without
    /// depending on the host's `TZ`.
    fn next_fire_after_in_tz<Tz: TimeZone>(
        schedule: &str,
        after: DateTime<Utc>,
        tz: &Tz,
    ) -> Option<DateTime<Utc>> {
        // The `cron` crate expects 6 fields (leading seconds); claude emits 5.
        let with_seconds = format!("0 {schedule}");
        let after_local = after.with_timezone(tz);
        cron::Schedule::from_str(&with_seconds)
            .ok()?
            .after(&after_local)
            .next()
            .map(|dt| dt.with_timezone(&Utc))
    }
}

#[cfg(test)]
mod tests {
    use chrono::FixedOffset;

    use super::*;

    fn at(rfc3339: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .with_timezone(&Utc)
    }

    // Tests pin the timezone explicitly via the in-tz helper so they don't
    // depend on the host's `TZ`.

    #[test]
    fn parses_claude_five_field_cron_same_day() {
        // "21 14 * * *" = daily 14:21; from 10:00 the next fire is the same day.
        let next =
            ScheduledResume::next_fire_after_in_tz("21 14 * * *", at("2026-06-18T10:00:00Z"), &Utc);
        assert_eq!(next.unwrap().to_rfc3339(), "2026-06-18T14:21:00+00:00");
    }

    #[test]
    fn rolls_to_next_day_when_time_already_passed() {
        let next =
            ScheduledResume::next_fire_after_in_tz("21 14 * * *", at("2026-06-18T15:00:00Z"), &Utc);
        assert_eq!(next.unwrap().to_rfc3339(), "2026-06-19T14:21:00+00:00");
    }

    #[test]
    fn invalid_schedule_returns_none() {
        assert!(
            ScheduledResume::next_fire_after_in_tz("not a cron", at("2026-06-18T10:00:00Z"), &Utc)
                .is_none()
        );
    }

    // #3: cron fields are local wall-clock time, not UTC. Claude on a UTC+9
    // machine emitting "21 14 * * *" means 14:21 local == 05:21 UTC.
    #[test]
    fn cron_is_evaluated_in_local_timezone_not_utc() {
        let kst = FixedOffset::east_opt(9 * 3600).unwrap();
        let next = ScheduledResume::next_fire_after_in_tz(
            "21 14 * * *",
            at("2026-06-18T00:00:00Z"), // 09:00 KST, before the 14:21 KST fire
            &kst,
        );
        // Bug behavior would have returned 2026-06-18T14:21:00Z.
        assert_eq!(next.unwrap().to_rfc3339(), "2026-06-18T05:21:00+00:00");
    }

    // #3: a local-time fire can land on a different UTC calendar day.
    #[test]
    fn cron_local_tz_crosses_utc_day_boundary() {
        // UTC-5: 14:21 local == 19:21 UTC. From 15:00 local (20:00 UTC), just
        // past today's fire, the next is tomorrow's 14:21 local == next-day
        // 19:21 UTC.
        let est = FixedOffset::west_opt(5 * 3600).unwrap();
        let next =
            ScheduledResume::next_fire_after_in_tz("21 14 * * *", at("2026-06-18T20:00:00Z"), &est);
        assert_eq!(next.unwrap().to_rfc3339(), "2026-06-19T19:21:00+00:00");
    }

    // #4: registration look-back keeps a just-elapsed minute due instead of
    // deferring it a whole day. The turn ends at 14:21:30, still within the
    // 14:21 minute, so the wakeup should fire at 14:21, not tomorrow.
    #[test]
    fn registration_keeps_just_elapsed_minute_due() {
        let now = at("2026-06-18T14:21:30Z");
        // Mirrors next_fire_at_for_registration's look-back, pinned to UTC.
        let fire = ScheduledResume::next_fire_after_in_tz(
            "21 14 * * *",
            now - Duration::seconds(ScheduledResume::REGISTRATION_LOOKBACK_SECS),
            &Utc,
        );
        assert_eq!(fire.unwrap().to_rfc3339(), "2026-06-18T14:21:00+00:00");

        // Strict (reschedule) semantics would have pushed it to the next day.
        let strict = ScheduledResume::next_fire_after_in_tz("21 14 * * *", now, &Utc);
        assert_eq!(strict.unwrap().to_rfc3339(), "2026-06-19T14:21:00+00:00");
    }

    // #4: past the one-minute grace window, a missed fire still rolls forward.
    #[test]
    fn registration_past_grace_window_rolls_forward() {
        let now = at("2026-06-18T14:23:00Z"); // 2 minutes past the 14:21 fire
        let fire = ScheduledResume::next_fire_after_in_tz(
            "21 14 * * *",
            now - Duration::seconds(ScheduledResume::REGISTRATION_LOOKBACK_SECS),
            &Utc,
        );
        assert_eq!(fire.unwrap().to_rfc3339(), "2026-06-19T14:21:00+00:00");
    }
}
