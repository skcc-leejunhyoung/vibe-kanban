use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

use relay_types::{ACCOUNT_LEASE_SECS, HostConnectionLease};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone)]
pub struct AccountSession {
    pub identity: HostConnectionLease,
    pub cancelled: CancellationToken,
    deadline: Arc<Mutex<Instant>>,
    wall_deadline: Arc<Mutex<SystemTime>>,
}

#[derive(Clone, Copy)]
pub struct LeaseRequestTime {
    monotonic: Instant,
    wall: SystemTime,
}
impl LeaseRequestTime {
    pub fn now() -> Self {
        Self {
            monotonic: Instant::now(),
            wall: SystemTime::now(),
        }
    }
}

impl AccountSession {
    pub fn active(&self) -> bool {
        !self.cancelled.is_cancelled()
            && Instant::now() < *self.deadline.lock().unwrap()
            && SystemTime::now() < *self.wall_deadline.lock().unwrap()
    }
}

#[derive(Clone, Default)]
pub struct AccountSessions(Arc<Mutex<HashMap<Uuid, AccountSession>>>);

impl AccountSessions {
    pub fn get(&self, id: Uuid) -> Option<AccountSession> {
        self.0
            .lock()
            .unwrap()
            .get(&id)
            .filter(|s| s.active())
            .cloned()
    }

    pub fn active_ids(&self) -> Vec<Uuid> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, s)| s.active())
            .map(|(id, _)| *id)
            .collect()
    }

    /// The deadline starts BEFORE the central request. A slow or suspended
    /// request cannot convert an old lease into another 60 seconds of access.
    pub fn approve(&self, lease: HostConnectionLease, request_started: LeaseRequestTime) -> bool {
        let duration =
            Duration::from_secs(u64::from(lease.remaining_seconds).min(ACCOUNT_LEASE_SECS));
        let deadline = request_started.monotonic + duration;
        let wall_deadline = request_started.wall + duration;
        // Monotonic time prevents a clock rollback extending permission. The
        // additional wall bound fails closed on platforms whose monotonic clock
        // pauses during sleep, including a response received after resumption.
        if deadline <= Instant::now() || wall_deadline <= SystemTime::now() {
            return false;
        }
        let mut sessions = self.0.lock().unwrap();
        if let Some(existing) = sessions.get(&lease.connection_id) {
            if !existing.active()
                || existing.identity.public_key_b64 != lease.public_key_b64
                || existing.identity.auth_session_id != lease.auth_session_id
                || existing.identity.user_id != lease.user_id
                || existing.identity.host_generation != lease.host_generation
                || existing.identity.grant_version != lease.grant_version
            {
                existing.cancelled.cancel();
                return false;
            }
            *existing.deadline.lock().unwrap() = deadline;
            *existing.wall_deadline.lock().unwrap() = wall_deadline;
            return true;
        }
        let session = AccountSession {
            identity: lease,
            cancelled: CancellationToken::new(),
            deadline: Arc::new(Mutex::new(deadline)),
            wall_deadline: Arc::new(Mutex::new(wall_deadline)),
        };
        let id = session.identity.connection_id;
        sessions.insert(id, session.clone());
        let map = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _=session.cancelled.cancelled()=>break,
                    _=tokio::time::sleep(Duration::from_millis(100))=>{}
                }
                if !session.active() {
                    break;
                }
            }
            session.cancelled.cancel();
            if let Some(map) = map.upgrade() {
                let mut map = map.lock().unwrap();
                if map
                    .get(&id)
                    .is_some_and(|current| Arc::ptr_eq(&current.deadline, &session.deadline))
                {
                    map.remove(&id);
                }
            }
        });
        true
    }

    pub fn revoke(&self, id: Uuid) {
        if let Some(session) = self.0.lock().unwrap().remove(&id) {
            session.cancelled.cancel();
        }
    }

    pub fn revoke_all(&self) {
        for (_, session) in self.0.lock().unwrap().drain() {
            session.cancelled.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn lease() -> HostConnectionLease {
        HostConnectionLease {
            connection_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            auth_session_id: Uuid::new_v4(),
            public_key_b64: "key".into(),
            host_generation: 2,
            grant_version: 3,
            remaining_seconds: 60,
        }
    }
    #[tokio::test]
    async fn delayed_or_sleeping_approval_cannot_extend_the_sixty_second_limit() {
        let sessions = AccountSessions::default();
        let row = lease();
        let before_sleep = LeaseRequestTime {
            monotonic: Instant::now(),
            wall: SystemTime::now() - Duration::from_secs(61),
        };
        assert!(!sessions.approve(row.clone(), before_sleep));
        let delayed = LeaseRequestTime {
            monotonic: Instant::now() - Duration::from_secs(61),
            wall: SystemTime::now(),
        };
        assert!(!sessions.approve(row.clone(), delayed));
        let mut oversized = row.clone();
        oversized.remaining_seconds = 600;
        assert!(sessions.approve(oversized, LeaseRequestTime::now()));
        let current = sessions.get(row.connection_id).unwrap();
        assert!(*current.deadline.lock().unwrap() <= Instant::now() + Duration::from_secs(60));
        *current.wall_deadline.lock().unwrap() = SystemTime::now() - Duration::from_secs(1);
        assert!(!current.active());
        assert!(!sessions.approve(row, LeaseRequestTime::now()));
        assert!(current.cancelled.is_cancelled());
    }
    #[tokio::test]
    async fn changed_identity_is_rejected_and_old_cleanup_cannot_remove_a_new_session() {
        let sessions = AccountSessions::default();
        let row = lease();
        assert!(sessions.approve(row.clone(), LeaseRequestTime::now()));
        let previous = sessions.get(row.connection_id).unwrap();
        let mut attacker = row.clone();
        attacker.auth_session_id = Uuid::new_v4();
        assert!(!sessions.approve(attacker, LeaseRequestTime::now()));
        assert!(previous.cancelled.is_cancelled());
        sessions.revoke(row.connection_id);
        assert!(sessions.approve(row.clone(), LeaseRequestTime::now()));
        tokio::task::yield_now().await;
        assert!(sessions.get(row.connection_id).is_some());
        sessions.revoke_all();
        assert!(sessions.get(row.connection_id).is_none());
    }
}
