use sqlx::PgPool;
use uuid::Uuid;

use super::{hosts::HostRepository, relay_browser_sessions::RelayBrowserSessionRepository};

#[tokio::test]
#[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
async fn legacy_routes_cannot_enter_account_migrating_disabled_or_deleted_hosts() {
    let pool = PgPool::connect(&std::env::var("HOST_ACCESS_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let owner = Uuid::new_v4();
    let member = Uuid::new_v4();
    for user in [owner, member] {
        sqlx::query("INSERT INTO users (id, email) VALUES ($1, $2)")
            .bind(user)
            .bind(format!("{user}@example.test"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let auth_session: Uuid =
        sqlx::query_scalar("INSERT INTO auth_sessions (user_id) VALUES ($1) RETURNING id")
            .bind(owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    let repo = HostRepository::new(&pool);
    let sessions = RelayBrowserSessionRepository::new(&pool);
    let host = repo
        .upsert_host(owner, "test", "test", None)
        .await
        .unwrap()
        .unwrap();
    assert!(repo.assert_host_access(host, owner).await.is_ok());
    assert!(repo.assert_host_access(host, member).await.is_err());
    assert!(repo.mark_host_online(host, None).await.unwrap());
    let browser_session = sessions
        .create(host, owner, auth_session)
        .await
        .unwrap()
        .unwrap();
    assert!(
        sessions
            .get_for_proxy(browser_session.id, host)
            .await
            .unwrap()
            .unwrap()
            .host_allowed
    );
    assert!(
        !sessions
            .get_for_proxy(browser_session.id, Uuid::new_v4())
            .await
            .unwrap()
            .unwrap()
            .host_allowed
    );
    assert!(
        sessions
            .create(host, member, auth_session)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query(
        "INSERT INTO host_access_grants (host_id, user_id, granted_by) VALUES ($1, $2, $3)",
    )
    .bind(host)
    .bind(member)
    .bind(owner)
    .execute(&pool)
    .await
    .unwrap();

    for mode in ["account", "migrating"] {
        sqlx::query("UPDATE hosts SET auth_mode = $2 WHERE id = $1")
            .bind(host)
            .bind(mode)
            .execute(&pool)
            .await
            .unwrap();
        for user in [owner, member] {
            assert!(repo.assert_host_access(host, user).await.is_err());
        }
        assert!(
            repo.upsert_host(owner, "test", "replacement", None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!repo.mark_host_online(host, None).await.unwrap());
        assert!(
            sessions
                .create(host, owner, auth_session)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            !sessions
                .get_for_proxy(browser_session.id, host)
                .await
                .unwrap()
                .unwrap()
                .host_allowed
        );
    }

    sqlx::query("UPDATE hosts SET auth_mode = 'legacy_pairing', remote_access_enabled = FALSE WHERE id = $1")
        .bind(host).execute(&pool).await.unwrap();
    assert!(
        repo.upsert_host(owner, "test", "replacement", None)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!repo.mark_host_online(host, None).await.unwrap());
    assert!(repo.assert_host_access(host, owner).await.is_err());
    assert!(
        sessions
            .create(host, owner, auth_session)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !sessions
            .get_for_proxy(browser_session.id, host)
            .await
            .unwrap()
            .unwrap()
            .host_allowed
    );

    sqlx::query("UPDATE hosts SET remote_access_enabled = TRUE, deleted_at = NOW() WHERE id = $1")
        .bind(host)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        repo.upsert_host(owner, "test", "replacement", None)
            .await
            .unwrap()
            .is_none()
    );
    assert!(repo.assert_host_access(host, owner).await.is_err());
    assert!(
        sessions
            .create(host, owner, auth_session)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !sessions
            .get_for_proxy(browser_session.id, host)
            .await
            .unwrap()
            .unwrap()
            .host_allowed
    );

    sqlx::query("UPDATE hosts SET deleted_at = NULL WHERE id = $1")
        .bind(host)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1")
        .bind(auth_session)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        sessions
            .create(host, owner, auth_session)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("DELETE FROM users WHERE id = ANY($1)")
        .bind(vec![owner, member])
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}
