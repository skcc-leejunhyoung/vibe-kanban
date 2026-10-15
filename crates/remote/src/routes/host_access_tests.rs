use api_types::{ChangeHostAccessRequest, HostAccessPolicy, User};
use axum::Extension;
use chrono::Utc;
use reqwest::StatusCode;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    auth::RequestContext,
    db::{
        auth::AuthSessionRepository,
        host_access::{HostAccessError, HostAccessRepository},
        hosts::HostRepository,
    },
};

struct Fixture {
    pool: PgPool,
    owner: Uuid,
    member: Uuid,
    outsider: Uuid,
    owner_session: Uuid,
    member_session: Uuid,
    host: Uuid,
    other_host: Uuid,
    org: Uuid,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("HOST_ACCESS_TEST_DATABASE_URL")
            .expect("provide a migrated disposable PostgreSQL database");
        let pool = PgPool::connect(&url).await.unwrap();
        let (owner, member, outsider, org) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        for user in [owner, member, outsider] {
            sqlx::query("INSERT INTO users (id, email) VALUES ($1, $2)")
                .bind(user)
                .bind(format!("{user}@example.test"))
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO organizations (id, name, slug) VALUES ($1, 'test', $2)")
            .bind(org)
            .bind(org.to_string())
            .execute(&pool)
            .await
            .unwrap();
        for user in [owner, member] {
            sqlx::query("INSERT INTO organization_member_metadata (organization_id, user_id) VALUES ($1, $2)")
                .bind(org).bind(user).execute(&pool).await.unwrap();
        }
        let host = sqlx::query_scalar("INSERT INTO hosts (owner_user_id, machine_id, name, shared_with_organization_id) VALUES ($1, 'first', 'First', $2) RETURNING id")
            .bind(owner).bind(org).fetch_one(&pool).await.unwrap();
        let other_host = sqlx::query_scalar("INSERT INTO hosts (owner_user_id, machine_id, name) VALUES ($1, 'second', 'Second') RETURNING id")
            .bind(outsider).fetch_one(&pool).await.unwrap();
        let sessions = AuthSessionRepository::new(&pool);
        let owner_session = sessions.create(owner, None).await.unwrap().id;
        sessions
            .set_current_refresh_token(owner_session, Uuid::new_v4())
            .await
            .unwrap();
        let member_session = sessions.create(member, None).await.unwrap().id;
        Self {
            pool,
            owner,
            member,
            outsider,
            owner_session,
            member_session,
            host,
            other_host,
            org,
        }
    }

    fn repo(&self) -> HostAccessRepository<'_> {
        HostAccessRepository::new(&self.pool)
    }

    async fn change(
        &self,
        user: Uuid,
        version: i32,
        grant: bool,
    ) -> Result<api_types::MutationResponse<api_types::HostAccessGrant>, HostAccessError> {
        self.repo()
            .change(
                self.host,
                self.owner,
                self.owner_session,
                user,
                &request(version),
                grant,
            )
            .await
    }

    async fn context(&self, user: Uuid, session_id: Uuid) -> RequestContext {
        let user = sqlx::query_as::<_, User>("SELECT id, email, first_name, last_name, username, created_at, updated_at FROM users WHERE id = $1")
            .bind(user).fetch_one(&self.pool).await.unwrap();
        RequestContext {
            user,
            session_id,
            access_token_expires_at: Utc::now() + chrono::Duration::hours(1),
        }
    }

    async fn cleanup(self) {
        sqlx::query("DELETE FROM users WHERE id = ANY($1)")
            .bind(vec![self.owner, self.member, self.outsider])
            .execute(&self.pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(self.org)
            .execute(&self.pool)
            .await
            .unwrap();
        self.pool.close().await;
    }
}

fn request(version: i32) -> ChangeHostAccessRequest {
    ChangeHostAccessRequest {
        expected_host_generation: 1,
        expected_version: version,
    }
}

async fn serve(pool: PgPool, ctx: RequestContext) -> (String, tokio::task::JoinHandle<()>) {
    let router = super::hosts::router::<PgPool>()
        .layer(Extension(ctx))
        .with_state(pool);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (url, server)
}

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn account_discovery_uses_explicit_grants_and_preserves_legacy_membership() {
    let f = Fixture::new().await;
    let hosts = HostRepository::new(&f.pool);
    assert_eq!(
        hosts.list_accessible_hosts(f.member).await.unwrap()[0].id,
        f.host
    );
    f.change(f.outsider, 0, true).await.unwrap();
    // Preparing a grant cannot bypass legacy pairing or organization membership.
    let outsider_hosts = hosts.list_accessible_hosts(f.outsider).await.unwrap();
    assert_eq!(outsider_hosts.len(), 1);
    assert_eq!(outsider_hosts[0].id, f.other_host);
    sqlx::query("UPDATE hosts SET auth_mode = 'account' WHERE id = $1")
        .bind(f.host)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        hosts
            .list_accessible_hosts(f.member)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        hosts.list_accessible_hosts(f.owner).await.unwrap()[0].access_role,
        "owner"
    );
    assert_eq!(
        hosts.list_accessible_hosts(f.outsider).await.unwrap().len(),
        2
    );
    f.change(f.outsider, 1, false).await.unwrap();
    assert_eq!(
        hosts.list_accessible_hosts(f.outsider).await.unwrap().len(),
        1
    );
    sqlx::query("UPDATE hosts SET deleted_at = NOW() WHERE id = $1")
        .bind(f.host)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        hosts
            .list_accessible_hosts(f.owner)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        hosts
            .update_name(f.host, f.owner, "Hidden")
            .await
            .unwrap()
            .is_none()
    );
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn access_api_enforces_ownership_versions_and_json_contract() {
    let f = Fixture::new().await;
    let (base, server) = serve(f.pool.clone(), f.context(f.owner, f.owner_session).await).await;
    let client = reqwest::Client::new();
    let path = format!("{base}/hosts/{}/access/{}", f.host, f.member);
    let response = client.put(&path).json(&request(0)).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response: serde_json::Value = response.json().await.unwrap();
    assert_eq!(response["data"]["version"], 1);
    assert!(response["txid"].as_i64().unwrap() > 0);

    for (version, generation, code) in [
        (0, 1, "GRANT_VERSION_CONFLICT"),
        (1, 2, "HOST_GENERATION_CONFLICT"),
    ] {
        let response = client
            .put(&path)
            .json(&ChangeHostAccessRequest {
                expected_version: version,
                expected_host_generation: generation,
            })
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap()["code"],
            code
        );
    }
    let response = client.put(&path).json(&request(-1)).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = client.put(&path).json(&serde_json::json!({"expected_version":1,"expected_host_generation":1,"owner_user_id":f.member})).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let response = client
        .put(format!("{base}/hosts/{}/access/{}", f.host, f.owner))
        .json(&request(0))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["code"],
        "OWNER_ACCESS_IMMUTABLE"
    );
    let response = client
        .put(format!("{base}/hosts/{}/access/{}", f.other_host, f.member))
        .json(&request(0))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = client
        .put(format!("{base}/hosts/{}/access/{}", f.host, Uuid::new_v4()))
        .json(&request(0))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let policy: HostAccessPolicy = client
        .get(format!("{base}/hosts/{}/access", f.host))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(policy.owner_user_id, f.owner);
    assert_eq!(policy.grants.len(), 1);
    sqlx::query(
        "UPDATE auth_sessions SET authenticated_at = NOW() - INTERVAL '6 minutes' WHERE id = $1",
    )
    .bind(f.owner_session)
    .execute(&f.pool)
    .await
    .unwrap();
    let response = client.put(&path).json(&request(1)).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["code"],
        "REAUTHENTICATION_REQUIRED"
    );
    let response = client
        .delete(&path)
        .query(&request(1))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["data"]["version"],
        2
    );

    let (member_base, member_server) =
        serve(f.pool.clone(), f.context(f.member, f.member_session).await).await;
    for method in [
        reqwest::Method::GET,
        reqwest::Method::PUT,
        reqwest::Method::DELETE,
    ] {
        let path = if method == reqwest::Method::GET {
            format!("{member_base}/hosts/{}/access", f.host)
        } else {
            format!("{member_base}/hosts/{}/access/{}", f.host, f.outsider)
        };
        let response = client
            .request(method, path)
            .query(&request(0))
            .json(&request(0))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    // The middleware context remains present, but a fresh database check wins.
    AuthSessionRepository::new(&f.pool)
        .revoke(f.owner_session)
        .await
        .unwrap();
    let response = client
        .delete(&path)
        .query(&request(2))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["code"],
        "ACCOUNT_SESSION_REVOKED"
    );
    member_server.abort();
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn revoke_and_regrant_never_revive_old_sessions_or_delayed_grants() {
    let f = Fixture::new().await;
    f.change(f.member, 0, true).await.unwrap();
    assert_eq!(f.change(f.member, 1, true).await.unwrap().data.version, 1);
    let old_session: Uuid = sqlx::query_scalar("INSERT INTO relay_browser_sessions (host_id, user_id, auth_session_id) VALUES ($1, $2, $3) RETURNING id")
        .bind(f.host).bind(f.member).bind(f.member_session).fetch_one(&f.pool).await.unwrap();
    let other_session: Uuid = sqlx::query_scalar("INSERT INTO relay_browser_sessions (host_id, user_id, auth_session_id) VALUES ($1, $2, $3) RETURNING id")
        .bind(f.other_host).bind(f.member).bind(f.member_session).fetch_one(&f.pool).await.unwrap();
    assert_eq!(f.change(f.member, 1, false).await.unwrap().data.version, 2);
    assert!(matches!(
        f.change(f.member, 1, true).await,
        Err(HostAccessError::GrantVersionConflict)
    ));
    assert_eq!(f.change(f.member, 2, false).await.unwrap().data.version, 2);
    assert_eq!(f.change(f.member, 2, true).await.unwrap().data.version, 3);
    for (session, revoked) in [(old_session, true), (other_session, false)] {
        assert_eq!(
            sqlx::query_scalar::<_, bool>(
                "SELECT revoked_at IS NOT NULL FROM relay_browser_sessions WHERE id = $1"
            )
            .bind(session)
            .fetch_one(&f.pool)
            .await
            .unwrap(),
            revoked
        );
    }
    assert_eq!(
        f.change(f.outsider, 0, false).await.unwrap().data.version,
        1
    );
    assert!(matches!(
        f.change(f.outsider, 0, true).await,
        Err(HostAccessError::GrantVersionConflict)
    ));
    assert_eq!(f.change(f.outsider, 1, true).await.unwrap().data.version, 2);
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn fresh_login_is_required_only_for_grants_and_refresh_does_not_renew_it() {
    let f = Fixture::new().await;
    f.change(f.member, 0, true).await.unwrap();
    sqlx::query(
        "UPDATE auth_sessions SET authenticated_at = NOW() - INTERVAL '6 minutes' WHERE id = $1",
    )
    .bind(f.owner_session)
    .execute(&f.pool)
    .await
    .unwrap();
    let auth = AuthSessionRepository::new(&f.pool);
    let session = auth.get(f.owner_session).await.unwrap();
    auth.rotate_tokens(
        session.id,
        session.refresh_token_id.unwrap(),
        Uuid::new_v4(),
        120,
    )
    .await
    .unwrap();
    assert!(matches!(
        f.change(f.outsider, 0, true).await,
        Err(HostAccessError::ReauthenticationRequired)
    ));
    assert!(
        f.change(f.member, 1, false).await.is_ok(),
        "urgent revoke does not require fresh login"
    );
    sqlx::query("UPDATE auth_sessions SET authenticated_at = NULL WHERE id = $1")
        .bind(f.owner_session)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        f.change(f.outsider, 0, true).await,
        Err(HostAccessError::ReauthenticationRequired)
    ));
    assert!(matches!(
        f.repo()
            .change(
                f.host,
                f.owner,
                f.member_session,
                f.member,
                &request(2),
                false
            )
            .await,
        Err(HostAccessError::AccountSessionRevoked)
    ));
    auth.revoke(f.owner_session).await.unwrap();
    assert!(matches!(
        f.change(f.member, 2, false).await,
        Err(HostAccessError::AccountSessionRevoked)
    ));
    assert!(matches!(
        f.repo().list(f.host, f.owner, f.owner_session).await,
        Err(HostAccessError::AccountSessionRevoked)
    ));
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn concurrent_changes_cannot_overwrite_each_other_or_cross_a_transition() {
    let f = Fixture::new().await;
    let (grant, revoke) = tokio::join!(f.change(f.member, 0, true), f.change(f.member, 0, false));
    assert_eq!(usize::from(grant.is_ok()) + usize::from(revoke.is_ok()), 1);
    let error = match (grant, revoke) {
        (Err(error), Ok(_)) | (Ok(_), Err(error)) => error,
        _ => panic!("exactly one concurrent change must succeed"),
    };
    assert!(matches!(error, HostAccessError::GrantVersionConflict));
    sqlx::query("UPDATE hosts SET auth_mode = 'migrating' WHERE id = $1")
        .bind(f.host)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        f.change(f.outsider, 0, true).await,
        Err(HostAccessError::HostTransitionInProgress)
    ));
    sqlx::query("UPDATE hosts SET auth_mode = 'account', auth_generation = 2 WHERE id = $1")
        .bind(f.host)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        f.change(f.outsider, 0, true).await,
        Err(HostAccessError::HostGenerationConflict)
    ));
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn failed_session_revocation_rolls_back_the_grant_change() {
    let f = Fixture::new().await;
    f.change(f.member, 0, true).await.unwrap();
    let browser_session: Uuid = sqlx::query_scalar(
        "INSERT INTO relay_browser_sessions (host_id, user_id, auth_session_id)
         VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(f.host)
    .bind(f.member)
    .bind(f.member_session)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let failure = format!("test_revoke_{}", Uuid::new_v4().simple());
    // Restrict the fault to this fixture so other database tests can run concurrently.
    sqlx::raw_sql(&format!(
        "CREATE FUNCTION {failure}() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN RAISE EXCEPTION 'simulated revocation failure'; END $$;
         CREATE TRIGGER {failure} BEFORE UPDATE ON relay_browser_sessions
             FOR EACH ROW WHEN (NEW.host_id = '{}') EXECUTE FUNCTION {failure}();",
        f.host,
    ))
    .execute(&f.pool)
    .await
    .unwrap();
    let result = f.change(f.member, 1, false).await;
    sqlx::raw_sql(&format!(
        "DROP TRIGGER {failure} ON relay_browser_sessions; DROP FUNCTION {failure}();"
    ))
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(matches!(result, Err(HostAccessError::Database(_))));
    let policy = f
        .repo()
        .list(f.host, f.owner, f.owner_session)
        .await
        .unwrap();
    assert_eq!(policy.grants[0].version, 1);
    assert!(policy.grants[0].revoked_at.is_none());
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT revoked_at IS NULL FROM relay_browser_sessions WHERE id = $1"
        )
        .bind(browser_session)
        .fetch_one(&f.pool)
        .await
        .unwrap()
    );
    f.cleanup().await;
}
