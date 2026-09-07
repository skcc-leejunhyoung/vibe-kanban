use std::sync::Arc;

use axum::http::HeaderMap;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use services::services::oauth_credentials::OAuthCredentials;
use tokio::sync::{Mutex, RwLock, oneshot};

use super::*;

fn credentials(user: Uuid, generation: &str, expired: bool) -> Credentials {
    let token = |audience: &str, exp| {
        format!(
            "{}.{}.c2ln",
            URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#),
            URL_SAFE_NO_PAD.encode(
                serde_json::json!({
                    "sub": user, "exp": exp, "aud": audience,
                    "jti": generation,
                })
                .to_string()
            ),
        )
    };
    let access_token = token("vibe-access", if expired { 1 } else { 4_102_444_800_i64 });
    Credentials {
        expires_at: Some(extract_expiration(&access_token).unwrap()),
        access_token: Some(access_token),
        refresh_token: token("vibe-refresh", 4_102_444_800_i64),
    }
}

fn auth_at(path: std::path::PathBuf) -> AuthContext {
    AuthContext::new(
        Arc::new(OAuthCredentials::new(path)),
        Arc::new(RwLock::new(None)),
    )
}

#[tokio::test]
async fn local_reconnect_uses_bound_handoff_and_keeps_credentials_on_failure() {
    let directory = tempfile::tempdir().unwrap();
    let auth = auth_at(directory.path().join("credentials.json"));
    let user = Uuid::new_v4();
    let old = credentials(user, "old", true);
    auth.save_credentials(&old).await.unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let captured = calls.clone();
    let router = Router::new().fallback(move |uri: axum::http::Uri, headers: HeaderMap, Json(body): Json<serde_json::Value>| {
        let captured = captured.clone();
        async move {
            captured.lock().await.push((uri.path().to_string(), headers, body.clone()));
            if body["provider"] == "rejected" {
                return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "invalid_session"})));
            }
            (StatusCode::OK, Json(serde_json::json!({"handoff_id": Uuid::new_v4(), "authorize_url": "https://vibe.test/oauth"})))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = RemoteClient::new(
        &format!("http://{address}"),
        auth.clone(),
        "test-machine".into(),
    )
    .unwrap();
    let payload = |reauthenticate, provider: &str| HandoffInitPayload {
        provider: provider.into(),
        return_to: "http://localhost:3000/api/auth/handoff/complete".into(),
        reauthenticate,
    };

    let (_, bound) = initiate_local_handoff(&client, &auth, payload(true, "github"))
        .await
        .unwrap();
    assert_eq!(bound.reconnect_user_id, Some(user));
    let (_, login) = initiate_local_handoff(&client, &auth, payload(false, "github"))
        .await
        .unwrap();
    assert_eq!(login.reconnect_user_id, None);
    assert!(
        initiate_local_handoff(&client, &auth, payload(true, "rejected"))
            .await
            .is_err()
    );
    assert_eq!(
        auth.get_credentials().await.unwrap().refresh_token,
        old.refresh_token
    );
    let requests = calls.lock().await;
    assert_eq!(
        requests.len(),
        3,
        "must not call token refresh or fall back to ordinary login"
    );
    assert_eq!(requests[0].0, "/v1/oauth/web/reconnect");
    assert_eq!(
        requests[0].1["authorization"],
        format!("Bearer {}", old.refresh_token)
    );
    assert_eq!(
        requests[0].2["app_challenge"],
        hash_sha256_hex(&bound.app_verifier)
    );
    assert_eq!(requests[1].0, "/v1/oauth/web/init");
    assert!(!requests[1].1.contains_key("authorization"));
    drop(requests);
    assert!(
        auth.is_reconnecting().await,
        "failed init must not release the earlier handoff"
    );
    drop(bound);
    assert!(
        !auth.is_reconnecting().await,
        "failed init must release its own protection"
    );
    auth.clear_credentials().await.unwrap();
    assert!(matches!(
        initiate_local_handoff(&client, &auth, payload(true, "github")).await,
        Err(ApiError::Unauthorized)
    ));
    assert_eq!(calls.lock().await.len(), 3);
    server.abort();
}

#[tokio::test]
async fn reconnect_saves_only_the_initiating_account_and_preserves_disk_on_rejection() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("credentials.json");
    let auth = auth_at(path.clone());
    let user = Uuid::new_v4();
    let original = credentials(user, "original", true);
    let renewed = credentials(user, "renewed", false);
    let other = credentials(Uuid::new_v4(), "other", false);
    auth.save_credentials(&original).await.unwrap();
    assert!(
        !auth
            .save_reconnected_credentials(&other, user)
            .await
            .unwrap()
    );
    let mixed = Credentials {
        refresh_token: other.refresh_token.clone(),
        ..renewed.clone()
    };
    assert!(
        !auth
            .save_reconnected_credentials(&mixed, user)
            .await
            .unwrap()
    );
    assert_eq!(
        auth.get_credentials().await.unwrap().refresh_token,
        original.refresh_token
    );

    // Account switch or logout while the provider popup/redeem request is open.
    let (_, _pending) = auth.begin_reconnect().await.unwrap();
    auth.save_credentials(&other).await.unwrap();
    assert!(!auth.is_reconnecting().await);
    let before = std::fs::read(&path).unwrap();
    assert!(
        !auth
            .save_reconnected_credentials(&renewed, user)
            .await
            .unwrap()
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let (_, _pending) = auth.begin_reconnect().await.unwrap();
    auth.clear_credentials().await.unwrap();
    assert!(!auth.is_reconnecting().await);
    assert!(
        !auth
            .save_reconnected_credentials(&renewed, user)
            .await
            .unwrap()
    );
    assert!(!path.exists());

    // Rotation of the SAME account is allowed; access tokens can also be absent after restart.
    auth.save_credentials(&original).await.unwrap();
    let before = std::fs::read(&path).unwrap();
    // Force the temporary-file write to fail without changing the real credential file.
    std::fs::create_dir(path.with_extension("tmp")).unwrap();
    assert!(
        auth.save_reconnected_credentials(&renewed, user)
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        auth.get_credentials().await.unwrap().refresh_token,
        original.refresh_token
    );
    std::fs::remove_dir(path.with_extension("tmp")).unwrap();
    let storage = Arc::new(OAuthCredentials::new(path.clone()));
    storage.load().await.unwrap();
    let reloaded = AuthContext::new(storage, Arc::new(RwLock::new(None)));
    assert!(
        reloaded
            .get_credentials()
            .await
            .unwrap()
            .access_token
            .is_none()
    );
    assert!(
        reloaded
            .save_reconnected_credentials(&renewed, user)
            .await
            .unwrap()
    );
    assert_eq!(
        reloaded.get_credentials().await.unwrap().refresh_token,
        renewed.refresh_token
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(path).unwrap()).unwrap()["refresh_token"],
        renewed.refresh_token
    );
}

#[tokio::test]
async fn stale_refresh_success_or_failure_cannot_overwrite_reconnected_credentials() {
    for success in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let auth = auth_at(directory.path().join("credentials.json"));
        let user = Uuid::new_v4();
        let old = credentials(user, "old", true);
        let stale = credentials(user, "stale-refresh", false);
        let renewed = credentials(user, "reconnect", false);
        auth.save_credentials(&old).await.unwrap();
        let (started_tx, started_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let signals = Arc::new(Mutex::new(Some((started_tx, finish_rx))));
        let router = Router::new().route("/v1/tokens/refresh", post(move || {
            let signals = signals.clone();
            let stale = stale.clone();
            async move {
                let (started, finish) = signals.lock().await.take().unwrap();
                started.send(()).unwrap();
                finish.await.unwrap();
                (if success { StatusCode::OK } else { StatusCode::UNAUTHORIZED }, Json(serde_json::json!({
                    "access_token": stale.access_token.unwrap(), "refresh_token": stale.refresh_token,
                })))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = RemoteClient::new(
            &format!("http://{address}"),
            auth.clone(),
            "test-machine".into(),
        )
        .unwrap();
        let refreshing = tokio::spawn(async move { client.access_token().await });
        tokio::time::timeout(std::time::Duration::from_secs(5), started_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(
            auth.save_reconnected_credentials(&renewed, user)
                .await
                .unwrap()
        );
        finish_tx.send(()).unwrap();
        assert_eq!(
            refreshing.await.unwrap().unwrap(),
            renewed.access_token.unwrap()
        );
        assert_eq!(
            auth.get_credentials().await.unwrap().refresh_token,
            renewed.refresh_token
        );
        server.abort();
    }
}

#[tokio::test]
async fn rejected_background_refresh_before_reconnect_callback_keeps_the_session() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("credentials.json");
    let auth = auth_at(path.clone());
    let user = Uuid::new_v4();
    let old = credentials(user, "old", true);
    let renewed = credentials(user, "reconnect", false);
    auth.save_credentials(&old).await.unwrap();
    let before = std::fs::read(&path).unwrap();
    let (refresh_started, refreshing) = oneshot::channel();
    let (reject_refresh, rejection) = oneshot::channel();
    let refresh_signals = Arc::new(Mutex::new(Some((refresh_started, rejection))));
    let (init_started, initializing) = oneshot::channel();
    let (finish_init, initialization) = oneshot::channel();
    let init_signals = Arc::new(Mutex::new(Some((init_started, initialization))));
    let router = Router::new()
        .route("/v1/tokens/refresh", post(move || {
            let signals = refresh_signals.clone();
            async move {
                let (started, finish) = signals.lock().await.take().expect("must not retry refresh while reconnecting");
                started.send(()).unwrap();
                finish.await.unwrap();
                (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "provider_token_revoked"})))
            }
        }))
        .route("/v1/oauth/web/reconnect", post(move || {
            let signals = init_signals.clone();
            async move {
                let (started, finish) = signals.lock().await.take().unwrap();
                started.send(()).unwrap();
                finish.await.unwrap();
                Json(serde_json::json!({"handoff_id": Uuid::new_v4(), "authorize_url": "https://vibe.test/oauth"}))
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = RemoteClient::new(
        &format!("http://{address}"),
        auth.clone(),
        "test-machine".into(),
    )
    .unwrap();
    let refresh_client = client.clone();
    let refresh = tokio::spawn(async move { refresh_client.access_token().await });
    refreshing.await.unwrap();
    let init_auth = auth.clone();
    let init_client = client.clone();
    let init = tokio::spawn(async move {
        initiate_local_handoff(
            &init_client,
            &init_auth,
            HandoffInitPayload {
                provider: "github".into(),
                return_to: "http://localhost:3000/api/auth/handoff/complete".into(),
                reauthenticate: true,
            },
        )
        .await
    });
    initializing.await.unwrap();
    // The old 401 arrives even before handoff initialization returns.
    reject_refresh.send(()).unwrap();
    let error = tokio::time::timeout(std::time::Duration::from_secs(5), refresh)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    let response = axum::response::IntoResponse::into_response(ApiError::from(error));
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        auth.get_credentials().await.unwrap().refresh_token,
        old.refresh_token
    );
    assert!(client.access_token().await.is_err());
    finish_init.send(()).unwrap();
    let (_, handoff) = init.await.unwrap().unwrap();
    assert_eq!(handoff.reconnect_user_id, Some(user));
    assert!(
        auth.save_reconnected_credentials(&renewed, user)
            .await
            .unwrap()
    );
    assert!(!auth.is_reconnecting().await);
    assert_eq!(
        client.access_token().await.unwrap(),
        renewed.access_token.unwrap()
    );
    server.abort();
}
