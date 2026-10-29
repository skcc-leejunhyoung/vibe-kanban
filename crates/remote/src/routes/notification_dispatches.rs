use api_types::{AcceptNotificationHandoff, MutationResponse, NotificationHandoffMember};
use axum::{
    Json, Router,
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    routing::{get, post, put},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    AppState,
    auth::RequestContext,
    db::{get_txid, hosts::HostRepository},
    routes::error::ErrorResponse,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/autopilot-notification-leases", put(lease))
        .route("/notification-host-capabilities", put(capability))
        .route("/notification-claims", get(recover))
        .route("/notification-handoffs/accept", post(accept_handoff))
        .route("/notifications/{id}/claim", post(claim))
        .route("/notifications/{id}/renew-claim", post(renew))
        .route("/notifications/{id}/handoff", post(handoff))
        .route("/notifications/{id}/consume", post(consume))
        .route("/notifications/{id}/release", post(release))
        .route("/notification-host-deliveries", post(host_deliveries))
        .route(
            "/notification-host-deliveries/{id}/complete",
            post(host_complete),
        )
}
fn internal(error: sqlx::Error) -> ErrorResponse {
    tracing::error!(?error, "notification routing operation failed");
    ErrorResponse::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "notification routing operation failed",
    )
}
fn conflict() -> ErrorResponse {
    ErrorResponse::new(
        StatusCode::CONFLICT,
        "expired or superseded notification claim",
    )
}
async fn owned(pool: &PgPool, user: Uuid, host: Uuid) -> Result<(), ErrorResponse> {
    if !HostRepository::new(pool)
        .is_owned_by(host, user)
        .await
        .map_err(internal)?
    {
        return Err(ErrorResponse::new(StatusCode::NOT_FOUND, "host not found"));
    }
    Ok(())
}
#[derive(Deserialize)]
struct Capability {
    host_id: Uuid,
    protocol: i32,
}
async fn capability(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(p): Json<Capability>,
) -> Result<StatusCode, ErrorResponse> {
    owned(state.pool(), ctx.user.id, p.host_id).await?;
    if p.protocol != 1 {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "unsupported notification protocol",
        ));
    }
    sqlx::query("INSERT INTO notification_host_capabilities(host_id,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '90 seconds') ON CONFLICT(host_id) DO UPDATE SET user_id=EXCLUDED.user_id,expires_at=EXCLUDED.expires_at")
        .bind(p.host_id).bind(ctx.user.id).execute(state.pool()).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
struct Lease {
    host_id: Uuid,
    routine_id: String,
    instance_id: Uuid,
    kinds: Vec<String>,
    #[serde(default = "legacy_protocol")]
    protocol: i32,
    #[serde(default)]
    register: bool,
    #[serde(default)]
    revoke: bool,
}
fn legacy_protocol() -> i32 {
    1
}

async fn lease(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(p): Json<Lease>,
) -> Result<Json<Value>, ErrorResponse> {
    owned(state.pool(), ctx.user.id, p.host_id).await?;
    if ![1, 2].contains(&p.protocol)
        || p.routine_id.is_empty()
        || p.routine_id.len() > 128
        || p.kinds.len() > 32
        || p.kinds.iter().any(|s| s.len() > 128)
    {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "invalid notification lease",
        ));
    }
    let id = upsert_lease(state.pool(), ctx.user.id, &p).await?;
    Ok(Json(json!({"id":id,"protocol":2})))
}
async fn upsert_lease(pool: &PgPool, user: Uuid, p: &Lease) -> Result<Uuid, ErrorResponse> {
    let id = if p.register {
        sqlx::query_scalar("INSERT INTO autopilot_notification_leases(user_id,host_id,routine_id,instance_id,kinds,expires_at,protocol) VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN NOW() ELSE NOW()+INTERVAL '90 seconds' END,$7) ON CONFLICT(user_id,host_id,routine_id) DO UPDATE SET instance_id=EXCLUDED.instance_id,kinds=EXCLUDED.kinds,expires_at=EXCLUDED.expires_at,protocol=EXCLUDED.protocol RETURNING id")
            .bind(user).bind(p.host_id).bind(&p.routine_id).bind(p.instance_id).bind(&p.kinds).bind(p.revoke).bind(p.protocol).fetch_optional(pool).await.map_err(internal)?
    } else {
        // Renewal never takes ownership from a newer worker registration.
        sqlx::query_scalar("UPDATE autopilot_notification_leases SET kinds=$5,protocol=$7,expires_at=CASE WHEN $6 THEN NOW() ELSE NOW()+INTERVAL '90 seconds' END WHERE user_id=$1 AND host_id=$2 AND routine_id=$3 AND instance_id=$4 RETURNING id")
            .bind(user).bind(p.host_id).bind(&p.routine_id).bind(p.instance_id).bind(&p.kinds).bind(p.revoke).bind(p.protocol).fetch_optional(pool).await.map_err(internal)?
    };
    id.ok_or_else(conflict)
}

#[derive(Deserialize)]
struct Consumer {
    lease_id: Uuid,
    instance_id: Uuid,
}
async fn recover(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Query(p): Query<Consumer>,
) -> Result<Json<Value>, ErrorResponse> {
    let rows=sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('id',n.id,'revision',n.revision,'state',n.routing_state,'type',n.notification_type,'host_id',n.payload->>'host_id','workspace_id',n.payload->>'workspace_id','at',n.created_at,'cursor',(SELECT e.id FROM agent_events e WHERE e.notification_id=n.id AND e.host_id IS NULL AND e.kind='cloud.notification' AND e.data->'revision'=to_jsonb(n.revision) ORDER BY e.id DESC LIMIT 1),'claim_token',d.claim_token,'handoff_key',d.handoff_key,'handoff',d.handoff) FROM notification_dispatches d JOIN notifications n ON n.id=d.notification_id AND n.revision=d.revision JOIN autopilot_notification_leases l ON l.id=d.lease_id JOIN hosts h ON h.id=l.host_id AND h.owner_user_id=$1 AND h.deleted_at IS NULL WHERE n.user_id=$1 AND l.id=$2 AND l.instance_id=$3 AND l.expires_at>NOW() AND n.routing_state IN ('autopilot_pending','autopilot_claimed') AND d.handoff_deadline>NOW() ORDER BY n.created_at LIMIT 500")
        .bind(ctx.user.id).bind(p.lease_id).bind(p.instance_id).fetch_all(&pool).await.map_err(internal)?;
    Ok(Json(json!({"claims":rows})))
}
type HandoffMember = NotificationHandoffMember;

async fn accept_handoff(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(p): Json<AcceptNotificationHandoff>,
) -> Result<Json<MutationResponse<Value>>, ErrorResponse> {
    admit_handoff(state.pool(), ctx.user.id, p).await
}

async fn admit_handoff(
    pool: &PgPool,
    user: Uuid,
    p: AcceptNotificationHandoff,
) -> Result<Json<MutationResponse<Value>>, ErrorResponse> {
    let key = p.request.handoff["meta"]["idempotencyKey"]
        .as_str()
        .filter(|key| !key.is_empty() && key.len() <= 200)
        .ok_or_else(conflict)?;
    let mut members: Vec<HandoffMember> =
        serde_json::from_value(p.request.handoff["members"].clone()).map_err(|_| conflict())?;
    if members.is_empty() || members.len() > 500 {
        return Err(conflict());
    }
    members.sort_by_key(|member| member.id);
    if members.windows(2).any(|pair| pair[0].id == pair[1].id) {
        return Err(conflict());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    // Match mutate's lease -> sorted notifications lock order. Admission and
    // watchdog fallback then choose one terminal route for the entire batch.
    let lease: Option<Uuid> = sqlx::query_scalar("SELECT l.id FROM autopilot_notification_leases l JOIN hosts h ON h.id=l.host_id AND h.owner_user_id=$1 AND h.deleted_at IS NULL WHERE l.id=$2 AND l.user_id=$1 AND l.host_id=$3 FOR SHARE OF l")
        .bind(user).bind(p.request.lease_id).bind(p.host_id).fetch_optional(&mut *tx).await.map_err(internal)?;
    lease.ok_or_else(conflict)?;
    let mut pending = Vec::new();
    for member in &members {
        let row = sqlx::query("SELECT n.revision,n.routing_state,d.reason,d.handoff,d.handoff_key,d.claim_token FROM notifications n JOIN notification_dispatches d ON d.notification_id=n.id AND d.revision=$3 WHERE n.id=$1 AND n.user_id=$2 AND d.lease_id=$4 FOR UPDATE OF n,d")
            .bind(member.id).bind(user).bind(member.revision).bind(p.request.lease_id).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(conflict)?;
        if row.get::<Option<String>, _>("handoff_key").as_deref() != Some(key)
            || row.get::<Option<Value>, _>("handoff").as_ref() != Some(&p.request.handoff)
            || row.get::<Option<Uuid>, _>("claim_token") != Some(member.claim_token)
        {
            return Err(conflict());
        }
        // A lost admission response can be retried after lease expiry or a new
        // revision; the durable decision for the old revision stays authoritative.
        if row.get::<String, _>("reason") == "queue_accepted" {
            continue;
        }
        if row.get::<i32, _>("revision") != member.revision
            || row.get::<String, _>("routing_state") != "autopilot_claimed"
        {
            return Err(conflict());
        }
        pending.push(member.id);
    }
    // Recheck wall-clock deadlines after every potentially blocking row lock.
    let timely: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notifications n JOIN notification_dispatches d ON d.notification_id=n.id AND d.revision=n.revision JOIN autopilot_notification_leases l ON l.id=d.lease_id JOIN notification_host_capabilities c ON c.host_id=l.host_id AND c.user_id=$2 WHERE n.id=ANY($1) AND l.id=$3 AND l.protocol=2 AND l.expires_at>clock_timestamp() AND c.expires_at>clock_timestamp() AND d.claim_expires_at>clock_timestamp() AND d.handoff_deadline>clock_timestamp()")
        .bind(&pending).bind(user).bind(p.request.lease_id).fetch_one(&mut *tx).await.map_err(internal)?;
    if timely != pending.len() as i64 {
        return Err(conflict());
    }
    for member in &members {
        sqlx::query("UPDATE notifications SET routing_state='autopilot_consumed',seen=true,dismissed_at=NOW() WHERE id=$1 AND revision=$2 AND routing_state='autopilot_claimed'")
            .bind(member.id).bind(member.revision).execute(&mut *tx).await.map_err(internal)?;
        sqlx::query("UPDATE notification_dispatches SET reason='queue_accepted' WHERE notification_id=$1 AND revision=$2")
            .bind(member.id).bind(member.revision).execute(&mut *tx).await.map_err(internal)?;
    }
    let txid = get_txid(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(MutationResponse {
        data: json!({}),
        txid,
    }))
}

#[derive(Deserialize)]
struct Claim {
    revision: i32,
    lease_id: Uuid,
    instance_id: Uuid,
    claim_token: Option<Uuid>,
    handoff_key: Option<String>,
    handoff: Option<Value>,
    #[serde(default)]
    members: Vec<HandoffMember>,
}
async fn mutate(
    pool: PgPool,
    user: Uuid,
    id: Uuid,
    p: Claim,
    operation: &str,
) -> Result<Json<MutationResponse<Value>>, ErrorResponse> {
    let started = std::time::Instant::now();
    if p.members.len() > 500 {
        return Err(conflict());
    }
    if p.handoff_key
        .as_ref()
        .is_some_and(|k| k.is_empty() || k.len() > 512)
        || p.handoff
            .as_ref()
            .is_some_and(|v| v.to_string().len() > 65536)
    {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "invalid notification handoff",
        ));
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM notifications WHERE id=$1 AND user_id=$2)")
            .bind(id)
            .bind(user)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    if !exists {
        return Err(ErrorResponse::new(
            StatusCode::NOT_FOUND,
            "notification not found",
        ));
    }
    // Fence registration before locking any notification, including a batch.
    let active:Option<Uuid>=sqlx::query_scalar("SELECT l.id FROM autopilot_notification_leases l JOIN hosts h ON h.id=l.host_id AND h.owner_user_id=$1 AND h.deleted_at IS NULL WHERE l.id=$2 AND l.user_id=$1 AND l.instance_id=$3 AND l.expires_at>NOW() AND l.protocol=2 FOR SHARE OF l")
        .bind(user).bind(p.lease_id).bind(p.instance_id).fetch_optional(&mut *tx).await.map_err(internal)?;
    if active.is_none() {
        return Err(conflict());
    }
    // Lock the notification before dispatch everywhere, including watchdog and delivery.
    let row=sqlx::query("SELECT n.routing_state,d.claim_token,d.handoff_key,d.handoff FROM notifications n JOIN notification_dispatches d ON d.notification_id=n.id AND d.revision=n.revision JOIN autopilot_notification_leases l ON l.id=d.lease_id JOIN hosts h ON h.id=l.host_id AND h.owner_user_id=$2 AND h.deleted_at IS NULL WHERE n.id=$1 AND n.user_id=$2 AND n.revision=$3 AND l.id=$4 AND l.instance_id=$5 AND l.expires_at>NOW() AND l.protocol=2 AND d.handoff_deadline>NOW() AND ((n.routing_state='autopilot_pending' AND d.pending_deadline>NOW()) OR (n.routing_state='autopilot_claimed' AND d.claim_expires_at>NOW())) FOR UPDATE OF n,d")
        .bind(id).bind(user).bind(p.revision).bind(p.lease_id).bind(p.instance_id).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(conflict)?;
    let route: String = row.get("routing_state");
    let token: Option<Uuid> = row.get("claim_token");
    if route == "autopilot_claimed" && token != p.claim_token {
        return Err(conflict());
    }
    if operation != "claim" && operation != "release" && route != "autopilot_claimed" {
        return Err(conflict());
    }
    let token = token.unwrap_or_else(Uuid::new_v4);
    match operation {
        "claim" | "renew" => {
            sqlx::query("UPDATE notification_dispatches SET claim_token=$2,claim_expires_at=LEAST(NOW()+INTERVAL '90 seconds',handoff_deadline),reason='claimed' WHERE notification_id=$1 AND revision=$3").bind(id).bind(token).bind(p.revision).execute(&mut *tx).await.map_err(internal)?;
            sqlx::query("UPDATE notifications SET routing_state='autopilot_claimed' WHERE id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
        }
        "handoff" => {
            let key = p.handoff_key.as_deref().ok_or_else(conflict)?;
            let old: Option<String> = row.get("handoff_key");
            if old.as_deref().is_some_and(|k| k != key) {
                return Err(conflict());
            }
            let mut members = p.members;
            if !members.iter().any(|m| m.id == id) {
                members.push(HandoffMember {
                    id,
                    revision: p.revision,
                    claim_token: token,
                });
            }
            members.sort_by_key(|m| m.id);
            if members[0].id != id || members.windows(2).any(|pair| pair[0].id == pair[1].id) {
                return Err(conflict());
            }
            let mut frozen = p.handoff.ok_or_else(conflict)?;
            if !frozen.is_object() {
                return Err(conflict());
            }
            frozen["members"] = json!(members);
            let old: Option<Value> = row.get("handoff");
            if old.as_ref().is_some_and(|old| old != &frozen) {
                return Err(conflict());
            }
            for member in &members {
                let valid=sqlx::query("SELECT d.handoff FROM notifications n JOIN notification_dispatches d ON d.notification_id=n.id AND d.revision=n.revision WHERE n.id=$1 AND n.user_id=$2 AND n.revision=$3 AND n.routing_state='autopilot_claimed' AND d.lease_id=$4 AND d.claim_token=$5 AND d.claim_expires_at>NOW() AND d.handoff_deadline>NOW() AND (d.handoff_key IS NULL OR d.handoff_key=$6) FOR UPDATE OF n,d")
                    .bind(member.id).bind(user).bind(member.revision).bind(p.lease_id).bind(member.claim_token).bind(key).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(conflict)?;
                let previous: Option<Value> = valid.get("handoff");
                if previous.as_ref().is_some_and(|old| old != &frozen) {
                    return Err(conflict());
                }
            }
            for member in &members {
                sqlx::query("UPDATE notification_dispatches SET handoff_key=$2,handoff=COALESCE(handoff,$3),reason='handoff_prepared' WHERE notification_id=$1 AND revision=$4").bind(member.id).bind(key).bind(&frozen).bind(member.revision).execute(&mut *tx).await.map_err(internal)?;
            }
        }
        "consume" => {
            let old: Option<String> = row.get("handoff_key");
            if old.is_none() || old != p.handoff_key {
                return Err(conflict());
            }
            sqlx::query("UPDATE notifications SET routing_state='autopilot_consumed',seen=true,dismissed_at=NOW() WHERE id=$1").bind(id).execute(&mut *tx).await.map_err(internal)?;
            sqlx::query("UPDATE notification_dispatches SET reason='queue_accepted' WHERE notification_id=$1 AND revision=$2").bind(id).bind(p.revision).execute(&mut *tx).await.map_err(internal)?;
        }
        "release" => {
            sqlx::query("UPDATE notifications SET routing_state='user',seen=false,dismissed_at=NULL WHERE id=$1").bind(id).execute(&mut *tx).await.map_err(internal)?;
            sqlx::query(
                "UPDATE notification_dispatches SET reason='released' WHERE notification_id=$1 AND revision=$2",
            )
            .bind(id)
            .bind(p.revision)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        }
        _ => unreachable!(),
    }
    let txid = get_txid(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    let next_state = match operation {
        "consume" => "autopilot_consumed",
        "release" => "user",
        _ => "autopilot_claimed",
    };
    tracing::info!(notification_id=%id, revision=p.revision, previous_state=%route,
        next_state, operation, lease_id=%p.lease_id, worker_instance=%p.instance_id,
        elapsed_ms=started.elapsed().as_millis() as u64,
        "notification routing transition committed");
    Ok(Json(MutationResponse {
        data: json!({"claim_token":token}),
        txid,
    }))
}
macro_rules! endpoint {
    ($name:ident) => {
        async fn $name(
            State(state): State<AppState>,
            Extension(ctx): Extension<RequestContext>,
            Path(id): Path<Uuid>,
            Json(p): Json<Claim>,
        ) -> Result<Json<MutationResponse<Value>>, ErrorResponse> {
            mutate(state.pool().clone(), ctx.user.id, id, p, stringify!($name)).await
        }
    };
}
endpoint!(claim);
endpoint!(renew);
endpoint!(handoff);
endpoint!(consume);
endpoint!(release);

#[derive(Deserialize)]
struct HostDelivery {
    host_id: Uuid,
}
async fn host_deliveries(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(p): Json<HostDelivery>,
) -> Result<Json<Value>, ErrorResponse> {
    owned(state.pool(), ctx.user.id, p.host_id).await?;
    let mut tx = state.pool().begin().await.map_err(internal)?;
    let rows=sqlx::query_scalar::<_,Value>("WITH selected AS (SELECT j.notification_id,j.revision FROM notification_delivery_jobs j JOIN notifications n ON n.id=j.notification_id AND n.revision=j.revision WHERE n.user_id=$1 AND n.routing_state='user' AND NOT n.seen AND n.dismissed_at IS NULL AND j.channel='host' AND j.target_id=$2 AND j.status='pending' ORDER BY j.updated_at LIMIT 50 FOR UPDATE OF n,j SKIP LOCKED), claimed AS (UPDATE notification_delivery_jobs j SET status='sending',attempt_token=gen_random_uuid(),updated_at=NOW() FROM selected s WHERE j.notification_id=s.notification_id AND j.revision=s.revision AND j.channel='host' AND j.target_id=$2 RETURNING j.*) SELECT jsonb_build_object('notification',to_jsonb(n),'token',c.attempt_token) FROM claimed c JOIN notifications n ON n.id=c.notification_id")
        .bind(ctx.user.id).bind(p.host_id).fetch_all(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({"deliveries":rows})))
}
#[derive(Deserialize)]
struct HostComplete {
    host_id: Uuid,
    revision: i32,
    token: Uuid,
}
async fn host_complete(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
    Json(p): Json<HostComplete>,
) -> Result<StatusCode, ErrorResponse> {
    owned(state.pool(), ctx.user.id, p.host_id).await?;
    sqlx::query("UPDATE notification_delivery_jobs SET status='sent',updated_at=NOW() WHERE notification_id=$1 AND revision=$2 AND channel='host' AND target_id=$3 AND attempt_token=$4 AND status='sending' AND EXISTS(SELECT 1 FROM notifications n WHERE n.id=notification_delivery_jobs.notification_id AND n.user_id=$5)")
        .bind(id).bind(p.revision).bind(p.host_id).bind(p.token).bind(ctx.user.id).execute(state.pool()).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use api_types::{
        Notification, NotificationHandoff, NotificationIntent, NotificationPayload,
        NotificationRoutingState, NotificationType,
    };
    use axum::response::IntoResponse;

    use super::*;
    use crate::db::notifications::NotificationRepository;

    // Sweeps and trigger DDL span the shared test database; explicit races
    // still run concurrently inside each test.
    static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct Fixture {
        pool: PgPool,
        user: Uuid,
        org: Uuid,
        host: Uuid,
        lease: Uuid,
        instance: Uuid,
    }
    impl Fixture {
        async fn new() -> Self {
            let url = std::env::var("NOTIFICATION_ROUTING_TEST_DATABASE_URL")
                .expect("use a disposable migrated PostgreSQL database");
            let pool = PgPool::connect(&url).await.unwrap();
            let user = Uuid::new_v4();
            let org = Uuid::new_v4();
            let host = Uuid::new_v4();
            let lease = Uuid::new_v4();
            let instance = Uuid::new_v4();
            sqlx::query("INSERT INTO users(id,email) VALUES($1,$2)")
                .bind(user)
                .bind(format!("{user}@example.test"))
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO organizations(id,name,slug) VALUES($1,'Synthetic notification tests',$2)").bind(org).bind(org.to_string()).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO hosts(id,owner_user_id,machine_id,name) VALUES($1,$2,$3,'Synthetic host')").bind(host).bind(user).bind(host.to_string()).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO notification_host_capabilities(host_id,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 hour')").bind(host).bind(user).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO autopilot_notification_leases(id,user_id,host_id,routine_id,instance_id,kinds,expires_at,protocol) VALUES($1,$2,$3,'synthetic-routine',$4,ARRAY['cloud.notification'],NOW()+INTERVAL '1 hour',2)").bind(lease).bind(user).bind(host).bind(instance).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO web_push_subscriptions(id,user_id,endpoint,p256dh,auth) VALUES($1,$2,$3,'synthetic-key','synthetic-auth')").bind(Uuid::new_v4()).bind(user).bind(format!("https://push.example.test/{user}")).execute(&pool).await.unwrap();
            Self {
                pool,
                user,
                org,
                host,
                lease,
                instance,
            }
        }
        async fn create(
            &self,
            intent: NotificationIntent,
            autopilot: bool,
            key: Option<&str>,
        ) -> Notification {
            NotificationRepository::create_with_intent(
                &self.pool,
                self.org,
                self.user,
                NotificationType::WorkspaceTaskCompleted,
                NotificationPayload {
                    title: Some("Synthetic alert".into()),
                    body: Some("Synthetic body".into()),
                    autopilot: Some(autopilot),
                    ..Default::default()
                },
                None,
                None,
                intent,
                key,
            )
            .await
            .unwrap()
        }
        fn request(&self, n: &Notification, token: Option<Uuid>) -> Claim {
            Claim {
                revision: n.revision,
                lease_id: self.lease,
                instance_id: self.instance,
                claim_token: token,
                handoff_key: None,
                handoff: None,
                members: vec![],
            }
        }
        async fn act(
            &self,
            n: &Notification,
            token: Option<Uuid>,
            op: &str,
        ) -> Result<Json<MutationResponse<Value>>, ErrorResponse> {
            mutate(
                self.pool.clone(),
                self.user,
                n.id,
                self.request(n, token),
                op,
            )
            .await
        }
        async fn jobs(&self, n: &Notification) -> i64 {
            sqlx::query_scalar("SELECT COUNT(*) FROM notification_delivery_jobs WHERE notification_id=$1 AND revision=$2 AND status='pending'").bind(n.id).bind(n.revision).fetch_one(&self.pool).await.unwrap()
        }
        async fn load(&self, n: &Notification) -> Notification {
            NotificationRepository::find_by_id(&self.pool, n.id)
                .await
                .unwrap()
                .unwrap()
        }
        async fn token(&self, n: &Notification) -> Uuid {
            serde_json::from_value(
                self.act(n, None, "claim").await.unwrap().0.data["claim_token"].clone(),
            )
            .unwrap()
        }
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn fallback_races_leave_exactly_one_terminal_route() {
        let _serial = TEST_LOCK.lock().await;
        let expired = Fixture::new().await;
        let raw = expired
            .create(NotificationIntent::RawEvent, false, None)
            .await;
        sqlx::query("UPDATE notification_dispatches SET pending_deadline=NOW()-INTERVAL '1 second' WHERE notification_id=$1").bind(raw.id).execute(&expired.pool).await.unwrap();
        let (claim, sweep) = tokio::join!(
            expired.act(&raw, None, "claim"),
            crate::web_push_notifications::sweep_expired(&expired.pool)
        );
        assert_eq!(
            claim.unwrap_err().into_response().status(),
            StatusCode::CONFLICT
        );
        sweep.unwrap();
        assert_eq!(
            expired.load(&raw).await.routing_state,
            NotificationRoutingState::User
        );
        assert_eq!(expired.jobs(&raw).await, 2);

        let f = Fixture::new().await;
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        let token = f.token(&n).await;
        let mut prepare = f.request(&n, Some(token));
        prepare.handoff_key = Some("synthetic-race-handoff".into());
        prepare.handoff = Some(json!({"path":"/synthetic/queue"}));
        let _ = mutate(f.pool.clone(), f.user, n.id, prepare, "handoff")
            .await
            .unwrap();
        let mut accept = f.request(&n, Some(token));
        accept.handoff_key = Some("synthetic-race-handoff".into());
        let revoke = async {
            sqlx::query("UPDATE autopilot_notification_leases SET expires_at=NOW() WHERE id=$1")
                .bind(f.lease)
                .execute(&f.pool)
                .await
                .unwrap();
            crate::web_push_notifications::sweep_expired(&f.pool)
                .await
                .unwrap();
        };
        let (consume, ()) = tokio::join!(
            mutate(f.pool.clone(), f.user, n.id, accept, "consume"),
            revoke
        );
        let final_row = f.load(&n).await;
        if consume.is_ok() {
            assert_eq!(
                final_row.routing_state,
                NotificationRoutingState::AutopilotConsumed
            );
            assert!(final_row.seen);
            assert_eq!(f.jobs(&n).await, 0);
        } else {
            assert_eq!(final_row.routing_state, NotificationRoutingState::User);
            assert!(!final_row.seen);
            assert_eq!(f.jobs(&n).await, 2);
        }
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn claim_and_reraise_do_not_deadlock_on_the_lease_foreign_key() {
        let _serial = TEST_LOCK.lock().await;
        use std::{str::FromStr, time::Duration};

        use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
        let f = Fixture::new().await;
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        let mut reraising = f.pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM notifications WHERE id=$1 FOR UPDATE")
            .bind(n.id)
            .execute(&mut *reraising)
            .await
            .unwrap();
        let application = format!("synthetic-claim-{}", Uuid::new_v4());
        let options = PgConnectOptions::from_str(
            &std::env::var("NOTIFICATION_ROUTING_TEST_DATABASE_URL").unwrap(),
        )
        .unwrap()
        .application_name(&application);
        let claimant = PgPoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let request = f.request(&n, None);
        let user = f.user;
        let id = n.id;
        let task = tokio::spawn(async move { mutate(claimant, user, id, request, "claim").await });
        // Wait until the real handler holds its lease lock and waits for this row.
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock')").bind(&application).fetch_one(&f.pool).await.unwrap();
                if waiting { break; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.unwrap();
        sqlx::query("UPDATE notifications SET created_at=clock_timestamp() WHERE id=$1")
            .bind(n.id)
            .execute(&mut *reraising)
            .await
            .unwrap();
        reraising.commit().await.unwrap();
        assert_eq!(
            task.await.unwrap().unwrap_err().into_response().status(),
            StatusCode::CONFLICT
        );
        assert_eq!(f.load(&n).await.revision, 2);
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn handoff_body_and_members_are_frozen_and_prior_revisions_survive() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        let token = f.token(&n).await;
        let prepare = || {
            let mut p = f.request(&n, Some(token));
            p.handoff_key = Some("synthetic-fixed-handoff".into());
            p.handoff = Some(json!({"path":"/synthetic/queue","payload":{"message":"original"}}));
            p
        };
        let _ = mutate(f.pool.clone(), f.user, n.id, prepare(), "handoff")
            .await
            .unwrap();
        // A repeat is idempotent, but the same key cannot refer to another prompt.
        let _ = mutate(f.pool.clone(), f.user, n.id, prepare(), "handoff")
            .await
            .unwrap();
        let mut changed = prepare();
        changed.handoff.as_mut().unwrap()["payload"]["message"] = json!("changed");
        assert_eq!(
            mutate(f.pool.clone(), f.user, n.id, changed, "handoff")
                .await
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::CONFLICT
        );
        let another = f.create(NotificationIntent::RawEvent, false, None).await;
        let another_token = f.token(&another).await;
        let mut changed = prepare();
        changed.members = vec![HandoffMember {
            id: another.id,
            revision: another.revision,
            claim_token: another_token,
        }];
        assert_eq!(
            mutate(f.pool.clone(), f.user, n.id, changed, "handoff")
                .await
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::CONFLICT
        );
        sqlx::query("UPDATE notifications SET created_at=clock_timestamp(),seen=false,dismissed_at=NULL WHERE id=$1").bind(n.id).execute(&f.pool).await.unwrap();
        let current = f.load(&n).await;
        assert_eq!(current.revision, 2);
        let history: Vec<(i32,String,Option<String>)> = sqlx::query_as("SELECT revision,reason,handoff_key FROM notification_dispatches WHERE notification_id=$1 ORDER BY revision").bind(n.id).fetch_all(&f.pool).await.unwrap();
        assert_eq!(
            history,
            vec![
                (
                    1,
                    "superseded".into(),
                    Some("synthetic-fixed-handoff".into())
                ),
                (2, "created".into(), None)
            ]
        );
        f.token(&current).await;
        let old_reason: String = sqlx::query_scalar(
            "SELECT reason FROM notification_dispatches WHERE notification_id=$1 AND revision=1",
        )
        .bind(n.id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
        assert_eq!(old_reason, "superseded");
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn source_keys_are_scoped_to_the_origin_host() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let mut alerts = Vec::new();
        for host in [f.host, Uuid::new_v4(), f.host] {
            alerts.push(
                NotificationRepository::create_with_intent(
                    &f.pool,
                    f.org,
                    f.user,
                    NotificationType::WorkspaceTaskCompleted,
                    NotificationPayload {
                        host_id: Some(host),
                        ..Default::default()
                    },
                    None,
                    None,
                    NotificationIntent::UserReport,
                    Some("synthetic-host-source"),
                )
                .await
                .unwrap(),
            );
        }
        assert_ne!(alerts[0].id, alerts[1].id);
        assert_eq!(alerts[0].id, alerts[2].id);
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn routing_classifies_before_any_delivery_and_deduplicates_ingress() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let raw = f
            .create(
                NotificationIntent::RawEvent,
                false,
                Some("synthetic-source"),
            )
            .await;
        assert_eq!(
            raw.routing_state,
            NotificationRoutingState::AutopilotPending
        );
        assert!(!raw.seen);
        assert!(raw.dismissed_at.is_none());
        assert_eq!(f.jobs(&raw).await, 0);
        assert!(
            NotificationRepository::list_by_user(&f.pool, f.user, true)
                .await
                .unwrap()
                .is_empty()
        );
        let event: Value =
            sqlx::query_scalar("SELECT data FROM agent_events WHERE notification_id=$1")
                .bind(raw.id)
                .fetch_one(&f.pool)
                .await
                .unwrap();
        assert_eq!(event["revision"], 1);
        assert!(event.get("body").is_none());
        let again = f
            .create(
                NotificationIntent::RawEvent,
                false,
                Some("synthetic-source"),
            )
            .await;
        assert_eq!(again.id, raw.id);
        assert_eq!(again.revision, raw.revision);
        assert_eq!(f.jobs(&raw).await, 0);
        for (intent, autopilot) in [
            (NotificationIntent::UserReport, false),
            (NotificationIntent::Legacy, false),
            (NotificationIntent::RawEvent, true),
        ] {
            let n = f.create(intent, autopilot, None).await;
            assert_eq!(n.routing_state, NotificationRoutingState::User);
            assert_eq!(f.jobs(&n).await, 2);
        }
        let local = NotificationRepository::create_with_intent(
            &f.pool,
            f.org,
            f.user,
            NotificationType::WorkspaceTaskCompleted,
            NotificationPayload {
                remote_push_enabled: Some(false),
                ..Default::default()
            },
            None,
            None,
            NotificationIntent::UserReport,
            None,
        )
        .await
        .unwrap();
        assert_eq!(f.jobs(&local).await, 1);
        sqlx::query("UPDATE autopilot_notification_leases SET expires_at=NOW() WHERE id=$1")
            .bind(f.lease)
            .execute(&f.pool)
            .await
            .unwrap();
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        assert_eq!(n.routing_state, NotificationRoutingState::User);
        assert_eq!(f.jobs(&n).await, 2);
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn claims_keep_alert_unseen_until_durable_handoff_and_fence_other_workers() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        let token = f.token(&n).await;
        assert_eq!(
            f.load(&n).await.routing_state,
            NotificationRoutingState::AutopilotClaimed
        );
        assert!(!f.load(&n).await.seen);
        assert_eq!(f.jobs(&n).await, 0);
        assert!(
            NotificationRepository::update(&f.pool, n.id, Some(true), Some(true))
                .await
                .is_err()
        );
        assert_eq!(
            f.act(&n, None, "claim")
                .await
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            f.act(&n, Some(token), "consume")
                .await
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::CONFLICT
        );
        let mut p = f.request(&n, Some(token));
        p.handoff_key = Some("synthetic-handoff".into());
        p.handoff = Some(json!({"path":"/synthetic/queue"}));
        let _ = mutate(f.pool.clone(), f.user, n.id, p, "handoff")
            .await
            .unwrap();
        let mut p = f.request(&n, Some(token));
        p.handoff_key = Some("synthetic-handoff".into());
        let _ = mutate(f.pool.clone(), f.user, n.id, p, "consume")
            .await
            .unwrap();
        let consumed = f.load(&n).await;
        assert!(consumed.seen);
        assert!(consumed.dismissed_at.is_some());
        assert_eq!(
            consumed.routing_state,
            NotificationRoutingState::AutopilotConsumed
        );
        assert_eq!(f.jobs(&n).await, 0);
        assert_eq!(
            f.act(&n, Some(token), "release")
                .await
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::CONFLICT
        );
        let next = f.create(NotificationIntent::RawEvent, false, None).await;
        let mut stranger = f.request(&next, None);
        stranger.instance_id = Uuid::new_v4();
        assert_eq!(
            mutate(f.pool.clone(), f.user, next.id, stranger, "claim")
                .await
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            mutate(
                f.pool.clone(),
                Uuid::new_v4(),
                next.id,
                f.request(&next, None),
                "claim"
            )
            .await
            .unwrap_err()
            .into_response()
            .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn timeout_fallback_is_terminal_and_old_revision_cannot_archive_a_reraise() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        sqlx::query("UPDATE notification_dispatches SET pending_deadline=NOW()-INTERVAL '1 second' WHERE notification_id=$1").bind(n.id).execute(&f.pool).await.unwrap();
        crate::web_push_notifications::sweep_expired(&f.pool)
            .await
            .unwrap();
        assert_eq!(
            f.load(&n).await.routing_state,
            NotificationRoutingState::User
        );
        assert!(!f.load(&n).await.seen);
        assert_eq!(f.jobs(&n).await, 2);
        assert_eq!(
            f.act(&n, None, "claim")
                .await
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::CONFLICT
        );
        sqlx::query("UPDATE notifications SET created_at=clock_timestamp(),seen=false,dismissed_at=NULL WHERE id=$1").bind(n.id).execute(&f.pool).await.unwrap();
        let reraised = f.load(&n).await;
        assert_eq!(reraised.revision, 2);
        assert_eq!(
            reraised.routing_state,
            NotificationRoutingState::AutopilotPending
        );
        assert_eq!(
            f.act(&n, None, "claim")
                .await
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::CONFLICT
        );
        let token = f.token(&reraised).await;
        sqlx::query("UPDATE notification_dispatches SET handoff_deadline=NOW()-INTERVAL '1 second' WHERE notification_id=$1").bind(n.id).execute(&f.pool).await.unwrap();
        crate::web_push_notifications::sweep_expired(&f.pool)
            .await
            .unwrap();
        assert_eq!(
            f.load(&n).await.routing_state,
            NotificationRoutingState::User
        );
        assert_eq!(f.jobs(&reraised).await, 2);
        assert_eq!(
            f.act(&reraised, Some(token), "consume")
                .await
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::CONFLICT
        );
        let orphan = Fixture::new().await;
        let held = orphan
            .create(NotificationIntent::RawEvent, false, None)
            .await;
        sqlx::query("DELETE FROM autopilot_notification_leases WHERE id=$1")
            .bind(orphan.lease)
            .execute(&orphan.pool)
            .await
            .unwrap();
        crate::web_push_notifications::sweep_expired(&orphan.pool)
            .await
            .unwrap();
        assert_eq!(
            orphan.load(&held).await.routing_state,
            NotificationRoutingState::User
        );
        assert_eq!(orphan.jobs(&held).await, 2);
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn only_one_claim_wins_and_read_cancels_unsent_jobs() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        let (a, b) = tokio::join!(f.act(&n, None, "claim"), f.act(&n, None, "claim"));
        assert_ne!(a.is_ok(), b.is_ok());
        let accepted = a.or(b).unwrap();
        let token = serde_json::from_value(accepted.0.data["claim_token"].clone()).unwrap();
        let _ = f.act(&n, Some(token), "release").await.unwrap();
        assert_eq!(f.jobs(&n).await, 2);
        NotificationRepository::update(&f.pool, n.id, Some(true), None)
            .await
            .unwrap();
        assert_eq!(f.jobs(&n).await, 0);
        sqlx::query("UPDATE notification_delivery_jobs SET status='sending',updated_at=NOW()-INTERVAL '2 minutes' WHERE notification_id=$1").bind(n.id).execute(&f.pool).await.unwrap();
        crate::web_push_notifications::sweep_expired(&f.pool)
            .await
            .unwrap();
        let statuses: Vec<String> = sqlx::query_scalar(
            "SELECT status FROM notification_delivery_jobs WHERE notification_id=$1",
        )
        .bind(n.id)
        .fetch_all(&f.pool)
        .await
        .unwrap();
        assert!(statuses.iter().all(|s| s == "uncertain"));
        NotificationRepository::delete(&f.pool, n.id).await.unwrap();
        assert_eq!(f.jobs(&n).await, 0);
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn handoff_batch_validation_is_atomic_and_revoked_capability_falls_back() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let a = f.create(NotificationIntent::RawEvent, false, None).await;
        let b = f.create(NotificationIntent::RawEvent, false, None).await;
        let ta = f.token(&a).await;
        let tb = f.token(&b).await;
        let ((first, tf), (second, ts)) = if a.id < b.id {
            ((&a, ta), (&b, tb))
        } else {
            ((&b, tb), (&a, ta))
        };
        let mut p = f.request(first, Some(tf));
        p.handoff_key = Some("synthetic-batch".into());
        p.handoff = Some(json!({"payload":"synthetic"}));
        p.members = vec![HandoffMember {
            id: second.id,
            revision: second.revision,
            claim_token: Uuid::new_v4(),
        }];
        assert_eq!(
            mutate(f.pool.clone(), f.user, first.id, p, "handoff")
                .await
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::CONFLICT
        );
        let key: Option<String> = sqlx::query_scalar(
            "SELECT handoff_key FROM notification_dispatches WHERE notification_id=$1",
        )
        .bind(first.id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
        assert!(key.is_none());
        let mut p = f.request(first, Some(tf));
        p.handoff_key = Some("synthetic-batch".into());
        p.handoff = Some(json!({"payload":"synthetic"}));
        p.members = vec![HandoffMember {
            id: second.id,
            revision: second.revision,
            claim_token: ts,
        }];
        let _ = mutate(f.pool.clone(), f.user, first.id, p, "handoff")
            .await
            .unwrap();
        let keys: Vec<String> = sqlx::query_scalar(
            "SELECT handoff_key FROM notification_dispatches WHERE notification_id=ANY($1)",
        )
        .bind(vec![a.id, b.id])
        .fetch_all(&f.pool)
        .await
        .unwrap();
        assert_eq!(keys, vec!["synthetic-batch", "synthetic-batch"]);
        sqlx::query("UPDATE notification_host_capabilities SET expires_at=NOW() WHERE host_id=$1")
            .bind(f.host)
            .execute(&f.pool)
            .await
            .unwrap();
        crate::web_push_notifications::sweep_expired(&f.pool)
            .await
            .unwrap();
        assert_eq!(
            f.load(&a).await.routing_state,
            NotificationRoutingState::User
        );
        assert_eq!(
            f.load(&b).await.routing_state,
            NotificationRoutingState::User
        );
    }
    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn event_failure_rolls_back_a_held_alert_and_old_online_hosts_disable_holding() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let mut tx = f.pool.begin().await.unwrap();
        let trigger = format!("synthetic_{}", Uuid::new_v4().simple());
        let ddl = format!(
            "CREATE FUNCTION pg_temp.{trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic event failure'; END $$; CREATE TRIGGER {trigger} BEFORE INSERT ON agent_events FOR EACH ROW WHEN (NEW.owner_user_id='{}'::uuid) EXECUTE FUNCTION pg_temp.{trigger}()",
            f.user
        );
        // Match the production advisory-lock -> event-table lock order.
        sqlx::query("SELECT pg_advisory_xact_lock(94838368587348)")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::raw_sql(&ddl).execute(&mut *tx).await.unwrap();
        let failed = NotificationRepository::create_with_intent(
            &mut *tx,
            f.org,
            f.user,
            NotificationType::WorkspaceTaskCompleted,
            NotificationPayload::default(),
            None,
            None,
            NotificationIntent::RawEvent,
            Some("synthetic-rollback"),
        )
        .await;
        assert!(failed.is_err());
        tx.rollback().await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notifications WHERE user_id=$1")
            .bind(f.user)
            .fetch_one(&f.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let old_host = Uuid::new_v4();
        sqlx::query("INSERT INTO hosts(id,owner_user_id,machine_id,name,status) VALUES($1,$2,$3,'Synthetic older host','online')").bind(old_host).bind(f.user).bind(old_host.to_string()).execute(&f.pool).await.unwrap();
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        assert_eq!(n.routing_state, NotificationRoutingState::User);
        assert_eq!(f.jobs(&n).await, 2);
    }
    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn registration_fences_old_worker_and_preserves_recoverable_handoff() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        let token = f.token(&n).await;
        let mut p = f.request(&n, Some(token));
        p.handoff_key = Some("synthetic-recovery".into());
        p.handoff = Some(json!({"payload":"synthetic"}));
        let _ = mutate(f.pool.clone(), f.user, n.id, p, "handoff")
            .await
            .unwrap();
        let next = Uuid::new_v4();
        let mut registration = Lease {
            host_id: f.host,
            routine_id: "synthetic-routine".into(),
            instance_id: next,
            kinds: vec!["cloud.notification".into()],
            protocol: 2,
            register: true,
            revoke: false,
        };
        assert_eq!(
            upsert_lease(&f.pool, f.user, &registration).await.unwrap(),
            f.lease
        );
        assert_eq!(
            f.act(&n, Some(token), "renew")
                .await
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::CONFLICT
        );
        registration.register = false;
        registration.instance_id = f.instance;
        assert_eq!(
            upsert_lease(&f.pool, f.user, &registration)
                .await
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::CONFLICT
        );
        let mut recovered = f.request(&n, Some(token));
        recovered.instance_id = next;
        let _ = mutate(f.pool.clone(), f.user, n.id, recovered, "renew")
            .await
            .unwrap();
        let key: Option<String> = sqlx::query_scalar(
            "SELECT handoff_key FROM notification_dispatches WHERE notification_id=$1",
        )
        .bind(n.id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
        assert_eq!(key.as_deref(), Some("synthetic-recovery"));
    }
    impl Fixture {
        async fn prepare_batch(&self, notifications: &[Notification]) -> NotificationHandoff {
            let mut members = Vec::new();
            for n in notifications {
                members.push(HandoffMember {
                    id: n.id,
                    revision: n.revision,
                    claim_token: self.token(n).await,
                });
            }
            members.sort_by_key(|m| m.id);
            let head = notifications
                .iter()
                .find(|n| n.id == members[0].id)
                .unwrap();
            let mut p = self.request(head, Some(members[0].claim_token));
            p.members = members;
            p.handoff_key = Some(format!("synthetic-batch-{}", Uuid::new_v4()));
            p.handoff = Some(
                json!({"path":format!("/api/sessions/{}/queue",Uuid::new_v4()),"payload":{"message":"Synthetic batch"},"meta":{"idempotencyKey":p.handoff_key}}),
            );
            let _ = mutate(self.pool.clone(), self.user, head.id, p, "handoff")
                .await
                .unwrap();
            let handoff:Value=sqlx::query_scalar("SELECT handoff FROM notification_dispatches WHERE notification_id=$1 AND revision=$2").bind(head.id).bind(head.revision).fetch_one(&self.pool).await.unwrap();
            NotificationHandoff {
                lease_id: self.lease,
                handoff,
            }
        }
        async fn admit(
            &self,
            request: NotificationHandoff,
        ) -> Result<Json<MutationResponse<Value>>, ErrorResponse> {
            admit_handoff(
                &self.pool,
                self.user,
                AcceptNotificationHandoff {
                    host_id: self.host,
                    request,
                },
            )
            .await
        }
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn durable_host_admission_is_atomic_and_rejects_fallback_supersession_and_tampering() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let a = f.create(NotificationIntent::RawEvent, false, None).await;
        let b = f.create(NotificationIntent::RawEvent, false, None).await;
        let request = f.prepare_batch(&[a.clone(), b.clone()]).await;
        let mut altered = request.clone();
        altered.handoff["payload"]["message"] = json!("Changed body");
        assert!(f.admit(altered).await.is_err());
        assert!(
            admit_handoff(
                &f.pool,
                Uuid::new_v4(),
                AcceptNotificationHandoff {
                    host_id: f.host,
                    request: request.clone()
                }
            )
            .await
            .is_err()
        );
        assert!(
            admit_handoff(
                &f.pool,
                f.user,
                AcceptNotificationHandoff {
                    host_id: Uuid::new_v4(),
                    request: request.clone()
                }
            )
            .await
            .is_err()
        );
        sqlx::query("UPDATE notifications SET created_at=clock_timestamp() WHERE id=$1")
            .bind(b.id)
            .execute(&f.pool)
            .await
            .unwrap();
        assert!(f.admit(request.clone()).await.is_err());
        assert_eq!(
            f.load(&a).await.routing_state,
            NotificationRoutingState::AutopilotClaimed
        );
        assert!(!f.load(&a).await.seen);
        sqlx::query("UPDATE autopilot_notification_leases SET expires_at=NOW() WHERE id=$1")
            .bind(f.lease)
            .execute(&f.pool)
            .await
            .unwrap();
        crate::web_push_notifications::sweep_expired(&f.pool)
            .await
            .unwrap();
        assert!(f.admit(request).await.is_err());
        for n in [&a, &b] {
            assert_eq!(
                f.load(n).await.routing_state,
                NotificationRoutingState::User
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn accepted_handoff_survives_lost_responses_expiry_and_a_new_revision() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        let request = f.prepare_batch(std::slice::from_ref(&n)).await;
        let _ = f.admit(request.clone()).await.unwrap();
        sqlx::query("UPDATE autopilot_notification_leases SET expires_at=NOW() WHERE id=$1")
            .bind(f.lease)
            .execute(&f.pool)
            .await
            .unwrap();
        crate::web_push_notifications::sweep_expired(&f.pool)
            .await
            .unwrap();
        assert_eq!(
            f.load(&n).await.routing_state,
            NotificationRoutingState::AutopilotConsumed
        );
        assert_eq!(f.jobs(&n).await, 0);
        sqlx::query("UPDATE notifications SET created_at=clock_timestamp(),seen=false,dismissed_at=NULL WHERE id=$1").bind(n.id).execute(&f.pool).await.unwrap();
        let _ = f.admit(request).await.unwrap();
        let newer = f.load(&n).await;
        assert_eq!(newer.revision, 2);
        assert!(!newer.seen);
        assert_eq!(newer.routing_state, NotificationRoutingState::User);
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn host_admission_and_watchdog_cannot_split_a_batch_between_terminal_routes() {
        let _serial = TEST_LOCK.lock().await;
        for _ in 0..5 {
            let f = Fixture::new().await;
            let a = f.create(NotificationIntent::RawEvent, false, None).await;
            let b = f.create(NotificationIntent::RawEvent, false, None).await;
            let request = f.prepare_batch(&[a.clone(), b.clone()]).await;
            let fallback = async {
                sqlx::query("UPDATE autopilot_notification_leases SET expires_at=clock_timestamp() WHERE id=$1").bind(f.lease).execute(&f.pool).await.unwrap();
                crate::web_push_notifications::sweep_expired(&f.pool)
                    .await
                    .unwrap();
            };
            let (admitted, ()) = tokio::join!(f.admit(request), fallback);
            crate::web_push_notifications::sweep_expired(&f.pool)
                .await
                .unwrap();
            let expected = if admitted.is_ok() {
                NotificationRoutingState::AutopilotConsumed
            } else {
                NotificationRoutingState::User
            };
            for n in [&a, &b] {
                assert_eq!(f.load(n).await.routing_state, expected);
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn older_worker_leases_do_not_hold_new_notifications() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        sqlx::query("UPDATE autopilot_notification_leases SET protocol=1 WHERE id=$1")
            .bind(f.lease)
            .execute(&f.pool)
            .await
            .unwrap();
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        assert_eq!(n.routing_state, NotificationRoutingState::User);
        assert_eq!(f.jobs(&n).await, 2);
    }
    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn blocked_host_admission_rechecks_the_deadline_after_its_row_lock() {
        use std::{str::FromStr, time::Duration};

        use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        let request = f.prepare_batch(std::slice::from_ref(&n)).await;
        let mut blocker = f.pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM notifications WHERE id=$1 FOR UPDATE")
            .bind(n.id)
            .execute(&mut *blocker)
            .await
            .unwrap();
        let application = format!("synthetic-admission-{}", Uuid::new_v4());
        let options = PgConnectOptions::from_str(
            &std::env::var("NOTIFICATION_ROUTING_TEST_DATABASE_URL").unwrap(),
        )
        .unwrap()
        .application_name(&application);
        let admission_pool = PgPoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let user = f.user;
        let host = f.host;
        let task = tokio::spawn(async move {
            admit_handoff(
                &admission_pool,
                user,
                AcceptNotificationHandoff {
                    host_id: host,
                    request,
                },
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5),async {
            loop {
                let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock')").bind(&application).fetch_one(&f.pool).await.unwrap();
                if waiting { break; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.unwrap();
        // This timestamp is later than the admission transaction's NOW(), but
        // expires while it waits. Only a post-lock wall-clock check rejects it.
        sqlx::query("UPDATE notification_dispatches SET claim_expires_at=clock_timestamp()+INTERVAL '30 milliseconds' WHERE notification_id=$1").bind(n.id).execute(&mut *blocker).await.unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        blocker.commit().await.unwrap();
        assert_eq!(
            task.await.unwrap().unwrap_err().into_response().status(),
            StatusCode::CONFLICT
        );
        crate::web_push_notifications::sweep_expired(&f.pool)
            .await
            .unwrap();
        assert_eq!(
            f.load(&n).await.routing_state,
            NotificationRoutingState::User
        );
    }
    #[tokio::test]
    #[ignore = "requires NOTIFICATION_ROUTING_TEST_DATABASE_URL (disposable PostgreSQL)"]
    async fn recovery_preserves_journal_metadata_and_does_not_expose_other_owners_claims() {
        let _serial = TEST_LOCK.lock().await;
        let f = Fixture::new().await;
        let n = f.create(NotificationIntent::RawEvent, false, None).await;
        let user=sqlx::query_as::<_,api_types::User>("SELECT id,email,first_name,last_name,username,created_at,updated_at FROM users WHERE id=$1").bind(f.user).fetch_one(&f.pool).await.unwrap();
        let ctx = RequestContext {
            user,
            session_id: Uuid::new_v4(),
            access_token_expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
        };
        let cursor: i64 =
            sqlx::query_scalar("SELECT id FROM agent_events WHERE notification_id=$1")
                .bind(n.id)
                .fetch_one(&f.pool)
                .await
                .unwrap();
        let page = recover(
            State(f.pool.clone()),
            Extension(ctx.clone()),
            Query(Consumer {
                lease_id: f.lease,
                instance_id: f.instance,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(page["claims"].as_array().unwrap().len(), 1);
        assert_eq!(page["claims"][0]["id"], json!(n.id));
        assert_eq!(page["claims"][0]["cursor"], cursor);
        assert!(page["claims"][0]["at"].as_str().is_some());
        assert_eq!(page["claims"][0]["revision"], 1);
        for wrong_owner in [false, true] {
            let mut stranger = ctx.clone();
            if wrong_owner {
                stranger.user.id = Uuid::new_v4();
            }
            let page = recover(
                State(f.pool.clone()),
                Extension(stranger),
                Query(Consumer {
                    lease_id: f.lease,
                    instance_id: if wrong_owner {
                        f.instance
                    } else {
                        Uuid::new_v4()
                    },
                }),
            )
            .await
            .unwrap()
            .0;
            assert!(page["claims"].as_array().unwrap().is_empty());
        }
    }
}
