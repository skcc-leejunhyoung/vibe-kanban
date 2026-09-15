//! In-process TTL caches for the two per-request Postgres round trips that
//! dominate idle load: auth session → user, and (user, resource) → access.
//!
//! Security invariants (covered by the tests below):
//! - A revoked session is never inserted, and every revoke path in
//!   `db::auth` invalidates its entry, so revocation is immediate.
//! - Only *positive* access results are cached; a denial is re-checked on
//!   every request, so granting access is immediate too.
//! - Keys carry the session id / user id plus the exact resource, so two
//!   users or two projects can never share an entry.
//! - Membership removal and org/project deletion flush the access cache.
//!
//! Anything that revokes access outside this process (manual SQL, the relay
//! server's inactivity revoke) is only bounded by [`AUTH_CACHE_TTL`].
//! ponytail: single-replica assumption; a second remote-server replica would
//! need shared invalidation (LISTEN/NOTIFY) before the TTL could be raised.

use std::{
    future::Future,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use api_types::User;
use chrono::{DateTime, Utc};
use moka::future::Cache;
use uuid::Uuid;

use crate::db::{
    auth::{AuthSessionError, MAX_SESSION_INACTIVITY_DURATION, SessionWithUser},
    identity_errors::IdentityError,
};

pub(crate) const AUTH_CACHE_TTL: Duration = Duration::from_secs(30);
const MAX_SESSION_ENTRIES: u64 = 10_000;
const MAX_ACCESS_ENTRIES: u64 = 100_000;

pub(crate) static AUTH_CACHE: LazyLock<AuthCache> =
    LazyLock::new(|| AuthCache::new(AUTH_CACHE_TTL));

/// Validated, non-revoked session. `last_used_at` is mutated in place after a
/// touch instead of re-inserting the entry, so a concurrent revoke can never
/// be resurrected by a stale re-insert.
pub(crate) struct CachedSession {
    pub user: User,
    created_at: DateTime<Utc>,
    last_used_at: Mutex<Option<DateTime<Utc>>>,
}

impl CachedSession {
    pub fn last_activity_at(&self) -> DateTime<Utc> {
        self.last_used_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .unwrap_or(self.created_at)
    }

    /// `touch` only writes when the (UTC) day changed; skip the round trip otherwise.
    pub fn needs_touch(&self, now: DateTime<Utc>) -> bool {
        self.last_used_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_none_or(|t| t.date_naive() < now.date_naive())
    }

    pub fn mark_touched(&self, now: DateTime<Utc>) {
        *self.last_used_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(now);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum AccessScope {
    Org(Uuid),
    Project(Uuid),
    Issue(Uuid),
}

#[derive(Debug)]
pub(crate) enum SessionRejection {
    NotFound,
    Revoked,
    Inactive { user_id: Uuid },
    Database(AuthSessionError),
}

pub(crate) struct AuthCache {
    sessions: Cache<Uuid, Arc<CachedSession>>,
    access: Cache<(Uuid, AccessScope), ()>,
}

impl AuthCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            sessions: Cache::builder()
                .time_to_live(ttl)
                .max_capacity(MAX_SESSION_ENTRIES)
                .build(),
            access: Cache::builder()
                .time_to_live(ttl)
                .max_capacity(MAX_ACCESS_ENTRIES)
                .build(),
        }
    }

    /// Resolve a session from cache, falling back to `load` (one JOIN query)
    /// on a miss. Revoked rows are rejected before they can be cached; the
    /// inactivity limit is re-evaluated on every hit.
    pub async fn resolve_session(
        &self,
        session_id: Uuid,
        now: DateTime<Utc>,
        load: impl Future<Output = Result<Option<SessionWithUser>, AuthSessionError>>,
    ) -> Result<Arc<CachedSession>, SessionRejection> {
        let session = match self.sessions.get(&session_id).await {
            Some(session) => session,
            None => {
                let row = load
                    .await
                    .map_err(SessionRejection::Database)?
                    .ok_or(SessionRejection::NotFound)?;
                if row.revoked_at.is_some() {
                    return Err(SessionRejection::Revoked);
                }
                let session = Arc::new(CachedSession {
                    user: row.user,
                    created_at: row.created_at,
                    last_used_at: Mutex::new(row.last_used_at),
                });
                self.sessions.insert(session_id, Arc::clone(&session)).await;
                session
            }
        };

        if now.signed_duration_since(session.last_activity_at()) > MAX_SESSION_INACTIVITY_DURATION {
            self.sessions.invalidate(&session_id).await;
            return Err(SessionRejection::Inactive {
                user_id: session.user.id,
            });
        }

        Ok(session)
    }

    pub async fn invalidate_session(&self, session_id: Uuid) {
        self.sessions.invalidate(&session_id).await;
    }

    pub fn invalidate_all_sessions(&self) {
        self.sessions.invalidate_all();
    }

    /// Positive-only access cache: a cached grant short-circuits `verify`;
    /// a denial is never stored, so the next request re-checks the database.
    pub async fn check_access(
        &self,
        user_id: Uuid,
        scope: AccessScope,
        verify: impl Future<Output = Result<(), IdentityError>>,
    ) -> Result<(), IdentityError> {
        let key = (user_id, scope);
        if self.access.get(&key).await.is_some() {
            return Ok(());
        }
        verify.await?;
        self.access.insert(key, ()).await;
        Ok(())
    }

    /// Membership changes are rare admin actions; flushing everything is
    /// cheaper and safer than tracking which resources a user could reach.
    pub fn invalidate_access(&self) {
        self.access.invalidate_all();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use chrono::Duration as ChronoDuration;

    use super::*;

    fn user(id: Uuid) -> User {
        User {
            id,
            email: format!("{id}@example.test"),
            first_name: None,
            last_name: None,
            username: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn row(user_id: Uuid, revoked: bool, created_at: DateTime<Utc>) -> SessionWithUser {
        SessionWithUser {
            created_at,
            last_used_at: None,
            revoked_at: revoked.then(Utc::now),
            user: user(user_id),
        }
    }

    /// Simulates the DB round trip: counts how many times it actually ran.
    async fn load(
        calls: &AtomicUsize,
        row: Option<SessionWithUser>,
    ) -> Result<Option<SessionWithUser>, AuthSessionError> {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(row)
    }

    #[tokio::test]
    async fn session_hits_skip_the_database_round_trip() {
        let cache = AuthCache::new(Duration::from_secs(30));
        let (session_id, user_id) = (Uuid::new_v4(), Uuid::new_v4());
        let calls = AtomicUsize::new(0);
        let now = Utc::now();

        for _ in 0..3 {
            let session = cache
                .resolve_session(
                    session_id,
                    now,
                    load(&calls, Some(row(user_id, false, now))),
                )
                .await
                .unwrap();
            assert_eq!(session.user.id, user_id);
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "3 requests → 1 PG round trip"
        );
    }

    #[tokio::test]
    async fn touch_runs_once_per_day() {
        let cache = AuthCache::new(Duration::from_secs(30));
        let session_id = Uuid::new_v4();
        let now = Utc::now();
        let session = cache
            .resolve_session(session_id, now, async {
                Ok(Some(row(Uuid::new_v4(), false, now)))
            })
            .await
            .unwrap();

        assert!(session.needs_touch(now), "never touched → write once");
        session.mark_touched(now);
        assert!(!session.needs_touch(now), "same day → skip the UPDATE");
        assert!(
            session.needs_touch(now + ChronoDuration::days(1)),
            "next day → write again"
        );
        // A later hit sees the touched state without any re-insert (the
        // loader below must not run; if it did, `Ok(None)` would fail unwrap).
        let hit = cache
            .resolve_session(session_id, now, async { Ok(None) })
            .await
            .unwrap();
        assert!(!hit.needs_touch(now));
    }

    #[tokio::test]
    async fn revoked_session_is_rejected_immediately_after_invalidation() {
        let cache = AuthCache::new(Duration::from_secs(30));
        let (session_id, user_id) = (Uuid::new_v4(), Uuid::new_v4());
        let calls = AtomicUsize::new(0);
        let now = Utc::now();

        cache
            .resolve_session(
                session_id,
                now,
                load(&calls, Some(row(user_id, false, now))),
            )
            .await
            .unwrap();

        // Logout / token reuse → db::auth revoke → this call. The TTL has not elapsed.
        cache.invalidate_session(session_id).await;

        let rejected = cache
            .resolve_session(session_id, now, load(&calls, Some(row(user_id, true, now))))
            .await;
        assert!(matches!(rejected, Err(SessionRejection::Revoked)));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "miss after invalidation re-reads PG"
        );
        assert!(
            cache.sessions.get(&session_id).await.is_none(),
            "revoked row never cached"
        );
    }

    #[tokio::test]
    async fn invalidate_all_sessions_drops_every_entry() {
        let cache = AuthCache::new(Duration::from_secs(30));
        let now = Utc::now();
        let ids = [Uuid::new_v4(), Uuid::new_v4()];
        for id in ids {
            cache
                .resolve_session(id, now, async { Ok(Some(row(Uuid::new_v4(), false, now))) })
                .await
                .unwrap();
        }
        cache.invalidate_all_sessions();
        for id in ids {
            assert!(cache.sessions.get(&id).await.is_none());
        }
    }

    #[tokio::test]
    async fn missing_and_inactive_sessions_are_rejected() {
        let cache = AuthCache::new(Duration::from_secs(30));
        let now = Utc::now();

        let missing = cache
            .resolve_session(Uuid::new_v4(), now, async { Ok(None) })
            .await;
        assert!(matches!(missing, Err(SessionRejection::NotFound)));

        let session_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let stale = now - MAX_SESSION_INACTIVITY_DURATION - ChronoDuration::days(1);
        let inactive = cache
            .resolve_session(session_id, now, async {
                Ok(Some(row(user_id, false, stale)))
            })
            .await;
        assert!(
            matches!(inactive, Err(SessionRejection::Inactive { user_id: id }) if id == user_id)
        );
        assert!(
            cache.sessions.get(&session_id).await.is_none(),
            "evicted on inactivity"
        );
    }

    #[tokio::test]
    async fn session_entry_expires_after_ttl() {
        let cache = AuthCache::new(Duration::from_millis(50));
        let session_id = Uuid::new_v4();
        let calls = AtomicUsize::new(0);
        let now = Utc::now();
        let fresh = || load(&calls, Some(row(Uuid::new_v4(), false, now)));

        cache
            .resolve_session(session_id, now, fresh())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(120)).await;
        cache
            .resolve_session(session_id, now, fresh())
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    async fn verify(calls: &AtomicUsize, allowed: bool) -> Result<(), IdentityError> {
        calls.fetch_add(1, Ordering::SeqCst);
        if allowed {
            Ok(())
        } else {
            Err(IdentityError::NotFound)
        }
    }

    #[tokio::test]
    async fn access_hits_skip_the_database_round_trip() {
        let cache = AuthCache::new(Duration::from_secs(30));
        let (user_id, project_id) = (Uuid::new_v4(), Uuid::new_v4());
        let calls = AtomicUsize::new(0);

        for _ in 0..3 {
            cache
                .check_access(
                    user_id,
                    AccessScope::Project(project_id),
                    verify(&calls, true),
                )
                .await
                .unwrap();
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "3 long polls → 1 access check"
        );
    }

    #[tokio::test]
    async fn denied_access_is_never_cached() {
        let cache = AuthCache::new(Duration::from_secs(30));
        let (user_id, project_id) = (Uuid::new_v4(), Uuid::new_v4());
        let calls = AtomicUsize::new(0);

        for _ in 0..2 {
            let denied = cache
                .check_access(
                    user_id,
                    AccessScope::Project(project_id),
                    verify(&calls, false),
                )
                .await;
            assert!(denied.is_err());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2, "denials always re-check");

        // Grant is visible on the very next request.
        cache
            .check_access(
                user_id,
                AccessScope::Project(project_id),
                verify(&calls, true),
            )
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn access_entries_never_cross_users_or_resources() {
        let cache = AuthCache::new(Duration::from_secs(30));
        let (user_a, user_b) = (Uuid::new_v4(), Uuid::new_v4());
        let (project, other) = (Uuid::new_v4(), Uuid::new_v4());
        let calls = AtomicUsize::new(0);

        cache
            .check_access(user_a, AccessScope::Project(project), verify(&calls, true))
            .await
            .unwrap();

        for (user, scope) in [
            (user_b, AccessScope::Project(project)),
            (user_a, AccessScope::Project(other)),
            (user_a, AccessScope::Org(project)),
            (user_a, AccessScope::Issue(project)),
        ] {
            assert!(
                cache
                    .check_access(user, scope, verify(&calls, false))
                    .await
                    .is_err(),
                "{scope:?} for {user} must not hit user_a's project entry"
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 5);
    }

    #[tokio::test]
    async fn revoked_membership_is_rechecked_immediately() {
        let cache = AuthCache::new(Duration::from_secs(30));
        let (user_id, project_id) = (Uuid::new_v4(), Uuid::new_v4());
        let calls = AtomicUsize::new(0);

        cache
            .check_access(
                user_id,
                AccessScope::Project(project_id),
                verify(&calls, true),
            )
            .await
            .unwrap();

        // remove_member / delete_organization → this call, before the TTL elapses.
        cache.invalidate_access();

        let denied = cache
            .check_access(
                user_id,
                AccessScope::Project(project_id),
                verify(&calls, false),
            )
            .await;
        assert!(
            denied.is_err(),
            "next request is denied without waiting for TTL"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
