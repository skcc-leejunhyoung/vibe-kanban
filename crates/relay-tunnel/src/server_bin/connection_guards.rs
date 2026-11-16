use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};

use sqlx::PgPool;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::db::relay_browser_sessions::RelayBrowserSessionRepository;

#[derive(Clone, Default)]
pub struct ConnectionGuards(Arc<Mutex<HashMap<Uuid, Arc<CancellationToken>>>>);

impl ConnectionGuards {
    pub async fn watch(&self, pool: PgPool, host: Uuid, id: Uuid) -> CancellationToken {
        let mut guards = self.0.lock().await;
        if let Some(token) = guards.get(&id).filter(|token| !token.is_cancelled()) {
            return token.as_ref().clone();
        }
        let token = Arc::new(CancellationToken::new());
        guards.insert(id, token.clone());
        let output = token.as_ref().clone();
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            const CHECK_FAILED: &str = "session check failing for 60s";
            let mut deadline = Instant::now() + Duration::from_secs(60);
            let mut wall_deadline = SystemTime::now() + Duration::from_secs(60);
            let reason = loop {
                if Instant::now() >= deadline || SystemTime::now() >= wall_deadline {
                    break Some(CHECK_FAILED);
                }
                let started = Instant::now();
                let wall_started = SystemTime::now();
                let remaining = deadline
                    .saturating_duration_since(started)
                    .min(Duration::from_secs(2));
                let result = tokio::time::timeout(remaining, async {
                    RelayBrowserSessionRepository::new(&pool)
                        .get_for_proxy(id, host)
                        .await
                })
                .await;
                match result {
                    Ok(Ok(Some(row)))
                        if row.host_allowed
                            && row.host_id == host
                            && row.revoked_at.is_none()
                            && row.session_revoked_at.is_none()
                            && row.session_user_id == Some(row.user_id)
                            && row
                                .session_last_used_at
                                .or(row.session_created_at)
                                .is_some_and(|at| {
                                    chrono::Utc::now().signed_duration_since(at)
                                        < chrono::Duration::days(365)
                                }) =>
                    {
                        deadline = started + Duration::from_secs(60);
                        wall_deadline = wall_started + Duration::from_secs(60);
                    }
                    Ok(Ok(_)) => break Some("session revoked or host access removed"),
                    _ if Instant::now() >= deadline => break Some(CHECK_FAILED),
                    _ => {}
                }
                tokio::select! {
                    _=token.cancelled()=>break None,
                    _=tokio::time::sleep(Duration::from_secs(2))=>{},
                    _=tokio::time::sleep_until(tokio::time::Instant::from_std(deadline))=>break Some(CHECK_FAILED),
                }
            };
            // Every relayed body and WebSocket of this session ends here.
            if let Some(reason) = reason {
                tracing::warn!(host_id = %host, session_id = %id, reason, "relay closing all connections of session");
            }
            token.cancel();
            if let Some(guards) = weak.upgrade() {
                let mut guards = guards.lock().await;
                if guards
                    .get(&id)
                    .is_some_and(|current| Arc::ptr_eq(current, &token))
                {
                    guards.remove(&id);
                }
            }
        });
        output
    }
}
