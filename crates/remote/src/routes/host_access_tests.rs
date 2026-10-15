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

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn emergency_revoke_is_allowed_during_migration_without_recent_login() {
    let f = Fixture::new().await;
    f.change(f.member, 0, true).await.unwrap();
    sqlx::query("UPDATE hosts SET auth_mode='migrating' WHERE id=$1")
        .bind(f.host)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE auth_sessions SET authenticated_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=$1",
    )
    .bind(f.owner_session)
    .execute(&f.pool)
    .await
    .unwrap();
    let revoked = f.change(f.member, 1, false).await.unwrap();
    assert!(revoked.data.revoked_at.is_some());
    assert_eq!(revoked.data.version, 2);
    sqlx::query("UPDATE hosts SET auth_mode='account' WHERE id=$1")
        .bind(f.host)
        .execute(&f.pool)
        .await
        .unwrap();
    let role: Option<String> = sqlx::query_scalar("SELECT host_access_role($1,$2)")
        .bind(f.host)
        .bind(f.member)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert!(role.is_none());
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn suspended_accounts_cannot_receive_grants_and_suspended_owners_stop_offering_hosts() {
    let f = Fixture::new().await;
    sqlx::query("UPDATE users SET suspended_at=clock_timestamp() WHERE id=$1")
        .bind(f.member)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        f.change(f.member, 0, true).await,
        Err(HostAccessError::AccountNotFound)
    ));
    sqlx::query("UPDATE users SET suspended_at=clock_timestamp() WHERE id=$1")
        .bind(f.owner)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        HostRepository::new(&f.pool)
            .list_accessible_hosts(f.owner)
            .await
            .unwrap()
            .is_empty()
    );
    let enabled: bool = sqlx::query_scalar("SELECT remote_access_enabled FROM hosts WHERE id=$1")
        .bind(f.host)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert!(!enabled);
    assert!(matches!(
        f.change(f.outsider, 0, true).await,
        Err(HostAccessError::AccountSessionRevoked)
    ));
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn account_registration_lease_revocation_and_rotation_are_bound_to_identity() {
    use relay_types::*;

    use crate::db::host_connections as c;
    let f = Fixture::new().await;
    let secret = relay_control::account::new_credential();
    let request = RegisterAccountHostRequest {
        request_id: Uuid::new_v4(),
        expected_generation: None,
        machine_id: "first".into(),
        name: "Account host".into(),
        credential: secret.clone(),
        capabilities: vec![ACCOUNT_PROTOCOL.into()],
    };
    let registration = c::register(&f.pool, f.owner, f.owner_session, request.clone())
        .await
        .unwrap()
        .data;
    assert_eq!(
        registration.host_id, f.host,
        "migration must preserve existing links"
    );
    assert_eq!(registration.auth_mode, "migrating");
    assert_eq!(
        c::register(&f.pool, f.owner, f.owner_session, request)
            .await
            .unwrap()
            .data
            .generation,
        registration.generation
    );
    let activated = ActivateAccountHostRequest {
        transition_request_id: registration.transition_request_id,
        generation: registration.generation,
        capabilities: vec![ACCOUNT_PROTOCOL.into()],
    };
    c::activate(&f.pool, &secret, activated.clone())
        .await
        .unwrap();
    c::activate(&f.pool, &secret, activated).await.unwrap();
    let key_path = std::env::temp_dir().join(format!("host-access-test-key-{}", Uuid::new_v4()));
    let key = relay_control::signing::RelaySigningService::load_or_generate(&key_path).unwrap();
    std::fs::remove_file(key_path).unwrap();
    use base64::Engine;
    let public_key_b64 =
        base64::engine::general_purpose::STANDARD.encode(key.server_public_key().as_bytes());
    let open = OpenHostConnectionRequest {
        public_key_b64: public_key_b64.clone(),
        connection_id: None,
    };
    assert!(
        matches!(
            c::open_connection(&f.pool, f.member, f.member_session, f.host, open.clone()).await,
            Err(c::AccountError::HostAccessDenied)
        ),
        "legacy organization sharing must not migrate"
    );
    f.repo()
        .change(
            f.host,
            f.owner,
            f.owner_session,
            f.member,
            &ChangeHostAccessRequest {
                expected_host_generation: registration.generation,
                expected_version: 0,
            },
            true,
        )
        .await
        .unwrap();
    let approval = c::open_connection(&f.pool, f.member, f.member_session, f.host, open.clone())
        .await
        .unwrap()
        .data;
    let keys = relay_control::account::HostGrantSigner::from_env()
        .unwrap()
        .public_keys();
    let claims = relay_control::account::verify_grant(
        &approval.grant,
        &keys,
        &keys.issuer,
        f.host,
        registration.generation,
        Utc::now().timestamp(),
    )
    .unwrap();
    assert_eq!(claims.auth_session_id, f.member_session);
    assert_eq!(claims.public_key_b64, public_key_b64);
    let renewal = RenewHostConnectionsRequest {
        connections: vec![approval.connection_id],
    };
    let lease = c::renew(&f.pool, &secret, renewal.clone()).await.unwrap();
    assert_eq!(lease.leases.len(), 1);
    assert!(lease.leases[0].remaining_seconds <= 60);
    assert!(
        c::renew(&f.pool, "user-jwt", renewal.clone())
            .await
            .is_err()
    );
    f.repo()
        .change(
            f.host,
            f.owner,
            f.owner_session,
            f.member,
            &ChangeHostAccessRequest {
                expected_host_generation: registration.generation,
                expected_version: 1,
            },
            false,
        )
        .await
        .unwrap();
    assert!(
        c::renew(&f.pool, &secret, renewal.clone())
            .await
            .unwrap()
            .leases
            .is_empty(),
        "a still-signed approval cannot reopen a revoked connection"
    );
    f.repo()
        .change(
            f.host,
            f.owner,
            f.owner_session,
            f.member,
            &ChangeHostAccessRequest {
                expected_host_generation: registration.generation,
                expected_version: 2,
            },
            true,
        )
        .await
        .unwrap();
    assert!(
        c::renew(&f.pool, &secret, renewal.clone())
            .await
            .unwrap()
            .leases
            .is_empty(),
        "regrant must not revive prior connections"
    );
    assert!(matches!(
        c::open_connection(
            &f.pool,
            f.member,
            f.member_session,
            f.host,
            OpenHostConnectionRequest {
                connection_id: Some(approval.connection_id),
                ..open
            }
        )
        .await,
        Err(c::AccountError::HostConnectionExpired)
    ));
    AuthSessionRepository::new(&f.pool)
        .revoke(f.owner_session)
        .await
        .unwrap();
    let successor = RotateHostCredentialRequest {
        request_id: Uuid::new_v4(),
        credential: relay_control::account::new_credential(),
    };
    c::rotate(&f.pool, &secret, successor.clone())
        .await
        .unwrap();
    c::rotate(&f.pool, &secret, successor.clone())
        .await
        .unwrap();
    assert!(
        c::renew(&f.pool, &successor.credential, renewal.clone())
            .await
            .is_ok(),
        "owner logout must not revoke host registration"
    );
    sqlx::query("UPDATE host_credentials SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE secret_hash=$1").bind(relay_control::account::credential_hash(&secret).unwrap()).execute(&f.pool).await.unwrap();
    assert!(matches!(
        c::renew(&f.pool, &secret, renewal.clone()).await,
        Err(c::AccountError::HostCredentialRevoked)
    ));
    sqlx::query("UPDATE users SET suspended_at=clock_timestamp() WHERE id=$1")
        .bind(f.owner)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        c::renew(&f.pool, &successor.credential, renewal)
            .await
            .is_err()
    );
    f.cleanup().await;
}

impl Fixture {
    async fn register_account(&self) -> (String, relay_types::AccountHostRegistration) {
        use relay_types::*;
        let secret = relay_control::account::new_credential();
        let registration = crate::db::host_connections::register(
            &self.pool,
            self.owner,
            self.owner_session,
            RegisterAccountHostRequest {
                request_id: Uuid::new_v4(),
                expected_generation: None,
                machine_id: "first".into(),
                name: "Host".into(),
                credential: secret.clone(),
                capabilities: vec![ACCOUNT_PROTOCOL.into()],
            },
        )
        .await
        .unwrap()
        .data;
        crate::db::host_connections::activate(
            &self.pool,
            &secret,
            ActivateAccountHostRequest {
                transition_request_id: registration.transition_request_id,
                generation: registration.generation,
                capabilities: vec![ACCOUNT_PROTOCOL.into()],
            },
        )
        .await
        .unwrap();
        (secret, registration)
    }
}

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn manual_credential_recovery_requires_fresh_owner_and_preserves_host_id() {
    use relay_types::*;

    use crate::db::host_connections as c;
    let f = Fixture::new().await;
    let (old, registration) = f.register_account().await;
    let mut request = RegisterAccountHostRequest {
        request_id: Uuid::new_v4(),
        expected_generation: Some(registration.generation),
        machine_id: "first".into(),
        name: "Host".into(),
        credential: relay_control::account::new_credential(),
        capabilities: vec![ACCOUNT_PROTOCOL.into()],
    };
    sqlx::query("UPDATE auth_sessions SET authenticated_at=clock_timestamp()-INTERVAL '6 minutes' WHERE id=$1").bind(f.owner_session).execute(&f.pool).await.unwrap();
    assert!(matches!(
        c::register(&f.pool, f.owner, f.owner_session, request.clone()).await,
        Err(c::AccountError::Access(
            HostAccessError::ReauthenticationRequired
        ))
    ));
    assert!(
        c::renew(
            &f.pool,
            &old,
            RenewHostConnectionsRequest {
                connections: vec![]
            }
        )
        .await
        .is_ok(),
        "failed recovery must roll back, preserving old credential"
    );
    sqlx::query("UPDATE auth_sessions SET authenticated_at=clock_timestamp() WHERE id=$1")
        .bind(f.owner_session)
        .execute(&f.pool)
        .await
        .unwrap();
    request.expected_generation = Some(registration.generation + 1);
    assert!(matches!(
        c::register(&f.pool, f.owner, f.owner_session, request.clone()).await,
        Err(c::AccountError::Conflict)
    ));
    request.expected_generation = Some(registration.generation);
    let recovered = c::register(&f.pool, f.owner, f.owner_session, request.clone())
        .await
        .unwrap()
        .data;
    assert_eq!(recovered.host_id, f.host);
    assert_eq!(recovered.generation, registration.generation + 1);
    assert_eq!(
        c::register(&f.pool, f.owner, f.owner_session, request.clone())
            .await
            .unwrap()
            .data
            .generation,
        recovered.generation,
        "lost reply retry is idempotent"
    );
    assert!(
        c::renew(
            &f.pool,
            &old,
            RenewHostConnectionsRequest {
                connections: vec![]
            }
        )
        .await
        .is_err()
    );
    c::activate(
        &f.pool,
        &request.credential,
        ActivateAccountHostRequest {
            transition_request_id: request.request_id,
            generation: recovered.generation,
            capabilities: vec![ACCOUNT_PROTOCOL.into()],
        },
    )
    .await
    .unwrap();
    c::change_state(
        &f.pool,
        f.host,
        f.owner,
        f.owner_session,
        ChangeHostStateRequest {
            expected_generation: recovered.generation,
            remote_access_enabled: false,
        },
        true,
    )
    .await
    .unwrap();
    request.expected_generation = Some(recovered.generation);
    request.request_id = Uuid::new_v4();
    request.credential = relay_control::account::new_credential();
    assert_eq!(
        c::register(&f.pool, f.owner, f.owner_session, request)
            .await
            .unwrap()
            .data
            .host_id,
        f.host,
        "unregister/re-register keeps installation links"
    );
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn preview_authorization_is_bound_to_port_consumption_owner_session_and_live_process_report()
{
    use relay_types::*;

    use crate::db::host_connections as c;
    let f = Fixture::new().await;
    let (secret, registration) = f.register_account().await;
    c::report_preview_ports(
        &f.pool,
        &secret,
        ReportPreviewPortsRequest { ports: vec![5173] },
    )
    .await
    .unwrap();
    assert!(
        c::create_preview(
            &f.pool,
            f.host,
            f.owner,
            f.owner_session,
            "https://app.test",
            CreateHostPreviewRequest { port: 5432 }
        )
        .await
        .is_err()
    );
    assert!(
        c::create_preview(
            &f.pool,
            f.host,
            f.member,
            f.member_session,
            "https://app.test",
            CreateHostPreviewRequest { port: 5173 }
        )
        .await
        .is_err()
    );
    let opened = c::create_preview(
        &f.pool,
        f.host,
        f.owner,
        f.owner_session,
        "https://app.test",
        CreateHostPreviewRequest { port: 5173 },
    )
    .await
    .unwrap()
    .data;
    assert!(opened.exchange_url.contains(&f.host.to_string()));
    assert!(!opened.exchange_url.contains(&opened.code));
    let (preview, connection, hash): (Uuid, Uuid, String) = sqlx::query_as(
        "SELECT id,connection_id,exchange_hash FROM host_preview_sessions WHERE host_id=$1",
    )
    .bind(f.host)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_ne!(hash, opened.code);
    let authorize = AuthorizeHostPreviewRequest {
        preview_id: preview,
        port: 5173,
    };
    assert!(
        c::authorize_preview(&f.pool, &secret, authorize.clone())
            .await
            .is_err(),
        "unconsumed codes cannot reach the host"
    );
    sqlx::query("UPDATE host_preview_sessions SET consumed_at=clock_timestamp() WHERE id=$1")
        .bind(preview)
        .execute(&f.pool)
        .await
        .unwrap();
    let lease = c::authorize_preview(&f.pool, &secret, authorize.clone())
        .await
        .unwrap();
    assert_eq!(lease.connection_id, connection);
    assert_eq!(lease.auth_session_id, f.owner_session);
    assert!(lease.remaining_seconds <= 60);
    c::report_preview_ports(
        &f.pool,
        &secret,
        ReportPreviewPortsRequest { ports: vec![] },
    )
    .await
    .unwrap();
    assert!(
        c::authorize_preview(&f.pool, &secret, authorize.clone())
            .await
            .is_err()
    );
    c::report_preview_ports(
        &f.pool,
        &secret,
        ReportPreviewPortsRequest { ports: vec![5173] },
    )
    .await
    .unwrap();
    c::change_state(
        &f.pool,
        f.host,
        f.owner,
        f.owner_session,
        ChangeHostStateRequest {
            expected_generation: registration.generation,
            remote_access_enabled: false,
        },
        false,
    )
    .await
    .unwrap();
    assert!(
        c::authorize_preview(&f.pool, &secret, authorize)
            .await
            .is_err()
    );
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn login_device_api_rechecks_sessions_and_cannot_logout_other_accounts() {
    use relay_types::{AccountSessionInfo, RenewHostConnectionsRequest};
    let f = Fixture::new().await;
    let (secret, _) = f.register_account().await;
    let ctx = f.context(f.owner, f.owner_session).await;
    let app = super::host_connections::router()
        .merge(super::hosts::router())
        .layer(axum::middleware::from_fn_with_state(
            f.pool.clone(),
            super::host_connections::audit_denied,
        ))
        .layer(Extension(ctx))
        .with_state(f.pool.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = reqwest::Client::new();
    let list = client
        .get(format!("{base}/account/sessions"))
        .header("user-agent", "Fixture browser on test OS")
        .send()
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::OK);
    let rows: Vec<AccountSessionInfo> = list.json().await.unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].current);
    assert_eq!(
        rows[0].device_label.as_deref(),
        Some("Fixture browser on test OS")
    );
    assert_eq!(
        client
            .delete(format!("{base}/account/sessions/{}", f.member_session))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert!(
        AuthSessionRepository::new(&f.pool)
            .get(f.member_session)
            .await
            .unwrap()
            .revoked_at
            .is_none()
    );
    assert_eq!(
        client
            .patch(format!("{base}/hosts/{}", f.other_host))
            .json(&serde_json::json!({"name":"forbidden"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let denied: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM host_access_audit WHERE host_id=$1 AND actor_id=$2 AND result='404'",
    )
    .bind(f.other_host)
    .bind(f.owner)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(denied, 1);
    assert!(
        client
            .delete(format!("{base}/account/sessions"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    assert_eq!(
        client
            .patch(format!("{base}/hosts/{}", f.host))
            .json(&serde_json::json!({"name":"stale login"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(
        crate::db::host_connections::renew(
            &f.pool,
            &secret,
            RenewHostConnectionsRequest {
                connections: vec![]
            }
        )
        .await
        .is_ok()
    );
    assert!(
        AuthSessionRepository::new(&f.pool)
            .get(f.member_session)
            .await
            .unwrap()
            .revoked_at
            .is_none()
    );
    server.abort();
    f.cleanup().await;
}
