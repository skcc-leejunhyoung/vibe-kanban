use std::{sync::Arc, time::Duration};

use api_types::User;
use axum::{Extension, Router};
use chrono::Utc;
use reqwest::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{
        JwtService, OAuthHandoffService, OAuthTokenValidator, ProviderRegistry, RequestContext,
    },
    config::RemoteServerConfig,
    db::pull_requests::PullRequestRepository,
};

// The rollback test changes FKs on shared tables; keep test-level DDL isolated.
static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Fixture {
    pool: PgPool,
    base: String,
    server: tokio::task::JoinHandle<()>,
    client: reqwest::Client,
    user: Uuid,
    org: Uuid,
    project: Uuid,
    issues: [Uuid; 2],
    hosts: [Uuid; 2],
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("PR_LINKS_TEST_DATABASE_URL")
            .expect("provide a migrated disposable PostgreSQL database");
        let pool = PgPool::connect(&url).await.unwrap();
        let user: User = sqlx::query_as("INSERT INTO users (email) VALUES ($1) RETURNING id, email, first_name, last_name, username, created_at, updated_at")
            .bind(format!("{}@example.test", Uuid::new_v4())).fetch_one(&pool).await.unwrap();
        let org = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Synthetic organization', $2)",
        )
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO organization_member_metadata (organization_id, user_id) VALUES ($1, $2)",
        )
        .bind(org)
        .bind(user.id)
        .execute(&pool)
        .await
        .unwrap();
        let project: Uuid = sqlx::query_scalar("INSERT INTO projects (organization_id, name) VALUES ($1, 'Synthetic project') RETURNING id")
            .bind(org).fetch_one(&pool).await.unwrap();
        let status: Uuid = sqlx::query_scalar("INSERT INTO project_statuses (project_id, name, color) VALUES ($1, 'Todo', '0 0% 0%') RETURNING id")
            .bind(project).fetch_one(&pool).await.unwrap();
        let issues = [Uuid::new_v4(), Uuid::new_v4()];
        for issue in issues {
            sqlx::query("INSERT INTO issues (id, project_id, status_id, title) VALUES ($1, $2, $3, 'Synthetic issue')")
                .bind(issue).bind(project).bind(status).execute(&pool).await.unwrap();
        }
        let hosts = [Uuid::new_v4(), Uuid::new_v4()];
        for host in hosts {
            sqlx::query("INSERT INTO hosts (id, owner_user_id, machine_id, name) VALUES ($1, $2, $3, 'Synthetic host')")
                .bind(host).bind(user.id).bind(host.to_string()).execute(&pool).await.unwrap();
        }
        let config =
            RemoteServerConfig::from_env().expect("provide synthetic remote auth configuration");
        let jwt = Arc::new(JwtService::new(config.auth.jwt_secret().clone()));
        let providers = Arc::new(ProviderRegistry::new());
        let handoff = Arc::new(OAuthHandoffService::new(
            pool.clone(),
            providers.clone(),
            jwt.clone(),
            "http://localhost".into(),
        ));
        let validator = Arc::new(OAuthTokenValidator::new(
            pool.clone(),
            providers,
            jwt.clone(),
        ));
        let state = AppState::new(
            pool.clone(),
            config,
            jwt,
            handoff,
            validator,
            "http://localhost".into(),
            reqwest::Client::new(),
            None,
        );
        let mut router = Router::new()
            .merge(super::workspaces::router())
            .merge(super::pull_requests::router())
            .merge(super::pull_request_issues::router());
        for route in crate::shape_routes::all_shape_routes() {
            router = router.merge(route.router);
        }
        let user_id = user.id;
        let router = router
            .layer(Extension(RequestContext {
                user,
                session_id: Uuid::new_v4(),
                access_token_expires_at: Utc::now() + chrono::Duration::hours(1),
            }))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            pool,
            base,
            server,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
            user: user_id,
            org,
            project,
            issues,
            hosts,
        }
    }

    fn workspace_payload(&self, local: Uuid, issue: Uuid) -> Value {
        json!({"project_id": self.project, "host_id": self.hosts[0], "local_workspace_id": local, "issue_id": issue})
    }

    async fn workspace(&self, local: Uuid, issue: Uuid) -> Value {
        self.ok(self
            .client
            .post(format!("{}/workspaces", self.base))
            .json(&self.workspace_payload(local, issue)))
            .await
    }

    fn pr_payload(&self, local: Uuid) -> Value {
        json!({"local_workspace_id": local, "host_id": self.hosts[0], "url": "https://github.com/synthetic-fixture/repository/pull/17", "number": 17, "status": "open", "target_branch_name": "main"})
    }

    async fn upsert(&self, local: Uuid) -> Value {
        self.ok(self
            .client
            .put(format!("{}/pull_requests", self.base))
            .json(&self.pr_payload(local)))
            .await
    }

    async fn ok(&self, request: reqwest::RequestBuilder) -> Value {
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        assert!(status.is_success(), "{status}: {text}");
        serde_json::from_str(&text).unwrap()
    }

    async fn unlink(&self, local: Uuid) -> StatusCode {
        self.client
            .delete(format!("{}/workspaces", self.base))
            .json(&json!({"local_workspace_id": local, "host_id": self.hosts[0]}))
            .send()
            .await
            .unwrap()
            .status()
    }

    async fn counts(&self) -> (i64, i64, i64, i64) {
        sqlx::query_as("SELECT (SELECT COUNT(*) FROM workspaces WHERE project_id = $1), (SELECT COUNT(*) FROM pull_requests WHERE project_id = $1), (SELECT COUNT(*) FROM pull_request_issues WHERE project_id = $1), (SELECT COUNT(*) FROM pull_request_workspaces WHERE project_id = $1)")
            .bind(self.project).fetch_one(&self.pool).await.unwrap()
    }

    async fn cleanup(self) {
        self.server.abort();
        sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(self.org)
            .execute(&self.pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(self.user)
            .execute(&self.pool)
            .await
            .unwrap();
        self.pool.close().await;
    }
}

#[tokio::test]
#[ignore = "requires PR_LINKS_TEST_DATABASE_URL and synthetic remote auth env"]
async fn shared_pr_survives_either_workspace_unlink_and_last_unlink_cleans_up() {
    let _guard = TEST_LOCK.lock().await;
    for first in [0, 1] {
        let f = Fixture::new().await;
        let local = [Uuid::new_v4(), Uuid::new_v4()];
        let a = f.workspace(local[0], f.issues[0]).await;
        let b = f.workspace(local[1], f.issues[0]).await;
        let (pr_a, pr_b) = tokio::join!(f.upsert(local[0]), f.upsert(local[1]));
        assert_eq!(pr_a["data"]["id"], pr_b["data"]["id"]);
        assert_eq!(f.counts().await, (2, 1, 1, 2));
        for workspace in [&a, &b] {
            let id = Uuid::parse_str(workspace["id"].as_str().unwrap()).unwrap();
            assert_eq!(
                PullRequestRepository::list_by_workspace(&f.pool, id)
                    .await
                    .unwrap()
                    .len(),
                1
            );
        }
        let fallback = f
            .ok(f.client.get(format!(
                "{}/fallback/pull_request_workspaces?project_id={}",
                f.base, f.project
            )))
            .await;
        assert_eq!(
            fallback["pull_request_workspaces"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(f.unlink(local[first]).await, StatusCode::NO_CONTENT);
        assert_eq!(f.counts().await, (1, 1, 1, 1));
        assert_eq!(f.unlink(local[1 - first]).await, StatusCode::NO_CONTENT);
        assert_eq!(f.counts().await, (0, 0, 0, 0));
        f.cleanup().await;
    }
}

#[tokio::test]
#[ignore = "requires PR_LINKS_TEST_DATABASE_URL and synthetic remote auth env"]
async fn retries_are_idempotent_and_cannot_rebind_host_issue_or_project() {
    let _guard = TEST_LOCK.lock().await;
    let f = Fixture::new().await;
    let local = Uuid::new_v4();
    let original = f.workspace(local, f.issues[0]).await;
    f.upsert(local).await;
    assert_eq!(f.workspace(local, f.issues[0]).await["id"], original["id"]);
    f.upsert(local).await;
    assert_eq!(f.counts().await, (1, 1, 1, 1));
    for (field, value, expected) in [
        ("issue_id", f.issues[1], StatusCode::CONFLICT),
        ("host_id", f.hosts[1], StatusCode::CONFLICT),
        ("host_id", Uuid::new_v4(), StatusCode::BAD_REQUEST),
    ] {
        let mut payload = f.workspace_payload(local, f.issues[0]);
        payload[field] = json!(value);
        assert_eq!(
            f.client
                .post(format!("{}/workspaces", f.base))
                .json(&payload)
                .send()
                .await
                .unwrap()
                .status(),
            expected
        );
    }
    let other_project: Uuid = sqlx::query_scalar("INSERT INTO projects (organization_id, name) VALUES ($1, 'Other synthetic project') RETURNING id")
        .bind(f.org).fetch_one(&f.pool).await.unwrap();
    let mut payload = f.workspace_payload(Uuid::new_v4(), f.issues[0]);
    payload["project_id"] = json!(other_project);
    assert_eq!(
        f.client
            .post(format!("{}/workspaces", f.base))
            .json(&payload)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let mut payload = f.pr_payload(local);
    payload["host_id"] = json!(f.hosts[1]);
    assert_eq!(
        f.client
            .put(format!("{}/pull_requests", f.base))
            .json(&payload)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(f.counts().await, (1, 1, 1, 1));
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires PR_LINKS_TEST_DATABASE_URL and synthetic remote auth env"]
async fn separate_issues_and_explicit_links_survive_workspace_cleanup() {
    let _guard = TEST_LOCK.lock().await;
    let f = Fixture::new().await;
    let local = [Uuid::new_v4(), Uuid::new_v4()];
    for (local, issue) in local.into_iter().zip(f.issues) {
        f.workspace(local, issue).await;
        f.upsert(local).await;
    }
    assert_eq!(f.counts().await, (2, 1, 2, 2));
    assert_eq!(f.unlink(local[0]).await, StatusCode::NO_CONTENT);
    assert_eq!(f.counts().await, (1, 1, 1, 1));
    let mut explicit = f.pr_payload(local[1]);
    explicit["issue_id"] = json!(f.issues[1]);
    let link = f
        .ok(f
            .client
            .post(format!("{}/pull_request_issues", f.base))
            .json(&explicit))
        .await;
    assert_eq!(f.unlink(local[1]).await, StatusCode::NO_CONTENT);
    assert_eq!(f.counts().await, (0, 1, 1, 0));
    assert!(
        f.client
            .delete(format!(
                "{}/pull_request_issues/{}",
                f.base,
                link["data"]["id"].as_str().unwrap()
            ))
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    assert_eq!(f.counts().await, (0, 0, 0, 0));
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires PR_LINKS_TEST_DATABASE_URL and synthetic remote auth env"]
async fn simultaneous_unlinks_and_link_unlink_races_preserve_remaining_links() {
    let _guard = TEST_LOCK.lock().await;
    let f = Fixture::new().await;
    for _ in 0..5 {
        let local = [Uuid::new_v4(), Uuid::new_v4()];
        for local in local {
            f.workspace(local, f.issues[0]).await;
        }
        f.upsert(local[0]).await;
        let (deleted, _) = tokio::join!(f.unlink(local[0]), f.upsert(local[1]));
        assert_eq!(deleted, StatusCode::NO_CONTENT);
        assert_eq!(f.counts().await, (1, 1, 1, 1));
        f.workspace(local[0], f.issues[0]).await;
        f.upsert(local[0]).await;
        let (a, b) = tokio::join!(f.unlink(local[0]), f.unlink(local[1]));
        assert_eq!((a, b), (StatusCode::NO_CONTENT, StatusCode::NO_CONTENT));
        assert_eq!(f.counts().await, (0, 0, 0, 0));
    }
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires PR_LINKS_TEST_DATABASE_URL and synthetic remote auth env"]
async fn failed_delete_rolls_back_workspace_and_all_pr_links() {
    let _guard = TEST_LOCK.lock().await;
    let f = Fixture::new().await;
    let local = Uuid::new_v4();
    let workspace = f.workspace(local, f.issues[0]).await;
    f.upsert(local).await;
    // A restrictive dependent row forces failure after PR cleanup has run.
    let table = format!("test_workspace_guard_{}", Uuid::new_v4().simple());
    sqlx::query(&format!(
        "CREATE TABLE {table} (workspace_id UUID REFERENCES workspaces(id) ON DELETE RESTRICT)"
    ))
    .execute(&f.pool)
    .await
    .unwrap();
    sqlx::query(&format!("INSERT INTO {table} VALUES ($1)"))
        .bind(Uuid::parse_str(workspace["id"].as_str().unwrap()).unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(f.unlink(local).await, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(f.counts().await, (1, 1, 1, 1));
    sqlx::query(&format!("DROP TABLE {table}"))
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(f.unlink(local).await, StatusCode::NO_CONTENT);
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires PR_LINKS_TEST_DATABASE_URL and synthetic remote auth env"]
async fn pr_workspace_relations_keep_project_and_owner_access_boundaries() {
    let _guard = TEST_LOCK.lock().await;
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let local = Uuid::new_v4();
    other.workspace(local, other.issues[0]).await;
    other.upsert(local).await;
    for path in [
        format!(
            "/fallback/pull_request_workspaces?project_id={}",
            other.project
        ),
        format!("/shape/project/{}/pull_request_workspaces", other.project),
    ] {
        assert_eq!(
            f.client
                .get(format!("{}{path}", f.base))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        f.client
            .post(format!("{}/workspaces", f.base))
            .json(&f.workspace_payload(local, f.issues[0]))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.client
            .put(format!("{}/pull_requests", f.base))
            .json(&f.pr_payload(local))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(f.counts().await, (0, 0, 0, 0));
    assert_eq!(other.counts().await, (1, 1, 1, 1));
    f.cleanup().await;
    other.cleanup().await;
}
