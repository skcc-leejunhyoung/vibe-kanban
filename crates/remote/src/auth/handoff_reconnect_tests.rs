use base64::{Engine as _, engine::general_purpose::STANDARD};
use sqlx::postgres::PgPoolOptions;

use super::*;
use crate::auth::provider::{ProviderTokenDetails, TokenValidationError};

struct TestProvider(&'static str);

#[async_trait::async_trait]
impl AuthorizationProvider for TestProvider {
    fn name(&self) -> &'static str {
        self.0
    }
    fn scopes(&self) -> &[&str] {
        &["repo"]
    }
    fn authorize_url(&self, _: &str, _: &str) -> anyhow::Result<Url> {
        Ok(Url::parse("https://github.example/authorize")?)
    }
    async fn exchange_code(&self, code: &str, _: &str) -> anyhow::Result<AuthorizationGrant> {
        Ok(AuthorizationGrant {
            access_token: SecretString::new(code.to_owned().into()),
            token_type: "bearer".into(),
            scopes: vec![],
            refresh_token: None,
            expires_in: None,
            id_token: None,
        })
    }
    async fn fetch_user(&self, token: &SecretString) -> anyhow::Result<ProviderUser> {
        Ok(ProviderUser {
            id: token.expose_secret().into(),
            login: Some("github-name".into()),
            email: Some("same@example.test".into()),
            name: None,
            avatar_url: None,
        })
    }
    async fn validate_token(
        &self,
        token: &ProviderTokenDetails,
        _: u32,
    ) -> Result<Option<ProviderTokenDetails>, TokenValidationError> {
        if self.0 == "google" && token.access_token != "revoked" {
            Ok(None)
        } else {
            Err(TokenValidationError::InvalidOrRevoked)
        }
    }
}

async fn authorize(service: &OAuthHandoffService, user: Uuid, github_id: &str) -> (Uuid, String) {
    let login_provider = if OAuthAccountRepository::new(&service.pool)
        .get_by_user_provider(user, "github")
        .await
        .unwrap()
        .is_some()
    {
        "github"
    } else {
        "local"
    };
    let token_id = Uuid::new_v4();
    let session = AuthSessionRepository::new(&service.pool)
        .create(user, Some(token_id))
        .await
        .unwrap();
    let tokens = service
        .jwt
        .generate_tokens_for_refresh_token_id(&session, user, login_provider, token_id, Utc::now())
        .unwrap();
    let init = service
        .initiate_reconnect(
            "github",
            "https://vibe.example/account/complete",
            &hash_sha256_hex("verifier"),
            &tokens.refresh_token,
        )
        .await
        .unwrap();
    let record = OAuthHandoffRepository::new(&service.pool)
        .get(init.handoff_id)
        .await
        .unwrap();
    match service
        .handle_callback("github", Some(&record.state), Some(github_id), None)
        .await
        .unwrap()
    {
        CallbackResult::Success {
            handoff_id,
            app_code,
            ..
        } => (handoff_id, app_code),
        _ => panic!("expected authorization"),
    }
}

// Each run uses a unique schema in an explicitly supplied disposable database.
async fn test_pool() -> (PgPool, PgPool, String) {
    let url =
        std::env::var("OAUTH_TEST_DATABASE_URL").expect("provide a disposable PostgreSQL database");
    let schema = format!("oauth_test_{}", Uuid::new_v4().simple());
    let admin = PgPool::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let schema_for_pool = schema.clone();
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .after_connect(move |connection, _| {
            let query = format!("SET search_path TO {schema_for_pool}, public");
            Box::pin(async move {
                sqlx::query(&query).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    for migration in [
        include_str!("../../migrations/20251001000000_shared_tasks_activity.sql"),
        include_str!("../../migrations/20251117000000_jwt_refresh_tokens.sql"),
        include_str!("../../migrations/20251120121307_oauth_handoff_tokens.sql"),
        include_str!(
            "../../migrations/20260226000000_add_encrypted_provider_tokens_to_oauth_accounts.sql"
        ),
        include_str!("../../migrations/20260311120000_refresh_token_overlap.sql"),
        include_str!("../../migrations/20260907000000_bind_oauth_reconnections.sql"),
    ] {
        sqlx::raw_sql(migration).execute(&pool).await.unwrap();
    }
    (pool, admin, schema)
}

// Runs real migrations/SQL and the complete handoff service, mocking only GitHub.
#[tokio::test]
#[ignore = "requires OAUTH_TEST_DATABASE_URL pointing to disposable PostgreSQL"]
async fn reconnect_preserves_identity_and_commits_credentials_only_once() {
    let (pool, admin, schema) = test_pool().await;
    let user = Uuid::new_v4();
    let other = Uuid::new_v4();
    for (id, email) in [(user, "same@example.test"), (other, "other@example.test")] {
        UserRepository::new(&pool)
            .upsert_user(UpsertUser {
                id,
                email,
                username: Some("original-name"),
                first_name: None,
                last_name: None,
            })
            .await
            .unwrap();
    }
    let mut providers = ProviderRegistry::new();
    providers.register(TestProvider("github"));
    providers.register(TestProvider("google"));
    let jwt = Arc::new(JwtService::new(SecretString::new(
        STANDARD.encode(b"reconnect-test-secret").into(),
    )));
    let service = OAuthHandoffService::new(
        pool.clone(),
        Arc::new(providers),
        jwt.clone(),
        "https://vibe.example".into(),
    );
    let handoffs = OAuthHandoffRepository::new(&pool);
    let accounts = OAuthAccountRepository::new(&pool);

    // Recovery must work with the invalid provider above, but never with an
    // invalid app refresh credential. Exercise real signatures and DB lineage.
    let sessions = AuthSessionRepository::new(&pool);
    let current_id = Uuid::new_v4();
    let session = sessions.create(user, Some(current_id)).await.unwrap();
    let make_tokens = |subject, token_id, issued_at| {
        jwt.generate_tokens_for_refresh_token_id(&session, subject, "local", token_id, issued_at)
            .unwrap()
    };
    let current = make_tokens(user, current_id, Utc::now());
    let expired = make_tokens(user, current_id, Utc::now() - Duration::days(366));
    let challenge = hash_sha256_hex("verifier");
    let begin_reconnect = |credential| {
        service.initiate_reconnect(
            "github",
            "https://vibe.example/account/complete",
            &challenge,
            credential,
        )
    };
    let invalid_tokens = [
        "not-a-jwt".to_owned(),
        format!("{}tampered", current.refresh_token),
        current.access_token.clone(),
        expired.refresh_token,
        make_tokens(other, current_id, Utc::now()).refresh_token,
        make_tokens(user, Uuid::new_v4(), Utc::now()).refresh_token,
        // No existing GitHub identity: its old session must not link a replacement.
        jwt.generate_tokens_for_refresh_token_id(&session, user, "github", current_id, Utc::now())
            .unwrap()
            .refresh_token,
    ];
    for invalid in &invalid_tokens {
        assert!(matches!(
            begin_reconnect(invalid).await,
            Err(HandoffError::InvalidReconnectSession)
        ));
    }
    for _ in 0..2 {
        let init = begin_reconnect(&current.refresh_token).await.unwrap();
        assert_eq!(
            handoffs.reconnect_user(init.handoff_id).await.unwrap(),
            Some(user)
        );
    }
    let unchanged = sessions.get(session.id).await.unwrap();
    assert_eq!(unchanged.refresh_token_id, Some(current_id));
    assert!(unchanged.revoked_at.is_none());
    assert!(
        accounts
            .get_by_user_provider(user, "github")
            .await
            .unwrap()
            .is_none()
    );

    let next_id = Uuid::new_v4();
    sessions
        .rotate_tokens(session.id, current_id, next_id, 60)
        .await
        .unwrap();
    // Rotation writes the old token to revoked_refresh_tokens; its explicit
    // overlap is still valid until expiry, exactly as in ordinary refresh.
    assert!(begin_reconnect(&current.refresh_token).await.is_ok());
    sqlx::query("UPDATE auth_sessions SET previous_refresh_token_grace_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1")
        .bind(session.id).execute(&pool).await.unwrap();
    assert!(matches!(
        begin_reconnect(&current.refresh_token).await,
        Err(HandoffError::InvalidReconnectSession)
    ));
    let next = make_tokens(user, next_id, Utc::now());
    assert!(begin_reconnect(&next.refresh_token).await.is_ok());
    sqlx::query("INSERT INTO revoked_refresh_tokens (token_id, user_id, revoked_reason) VALUES ($1, $2, 'test')")
        .bind(next_id).bind(user).execute(&pool).await.unwrap();
    assert!(matches!(
        begin_reconnect(&next.refresh_token).await,
        Err(HandoffError::InvalidReconnectSession)
    ));
    sqlx::query("UPDATE auth_sessions SET previous_refresh_token_grace_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $1")
        .bind(session.id).execute(&pool).await.unwrap();
    sessions.revoke(session.id).await.unwrap();
    assert!(matches!(
        begin_reconnect(&current.refresh_token).await,
        Err(HandoffError::InvalidReconnectSession)
    ));

    let inactive_id = Uuid::new_v4();
    // UPDATE refreshes last_used_at through a real DB trigger, so seed an old
    // session at INSERT instead of trying to backdate its last activity.
    let inactive_session_id: Uuid = sqlx::query_scalar(
        "INSERT INTO auth_sessions (user_id, refresh_token_id, created_at)
         VALUES ($1, $2, NOW() - INTERVAL '366 days') RETURNING id",
    )
    .bind(user)
    .bind(inactive_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let inactive = sessions.get(inactive_session_id).await.unwrap();
    let inactive_tokens = jwt
        .generate_tokens_for_refresh_token_id(&inactive, user, "github", inactive_id, Utc::now())
        .unwrap();
    assert!(matches!(
        begin_reconnect(&inactive_tokens.refresh_token).await,
        Err(HandoffError::InvalidReconnectSession)
    ));

    let login = service
        .initiate(
            "github",
            "https://vibe.example/account/complete",
            &hash_sha256_hex("verifier"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        handoffs.reconnect_user(login.handoff_id).await.unwrap(),
        None
    );
    let (id, code) = authorize(&service, user, "github-a").await;
    assert_eq!(handoffs.reconnect_user(id).await.unwrap(), Some(user));
    assert!(
        accounts
            .get_by_user_provider(user, "github")
            .await
            .unwrap()
            .is_none()
    );
    assert!(service.redeem(id, &code, "wrong-verifier").await.is_err());
    assert!(service.redeem(id, "wrong-code", "verifier").await.is_err());
    assert!(
        accounts
            .get_by_user_provider(user, "github")
            .await
            .unwrap()
            .is_none()
    );

    let redeemed = service.redeem(id, &code, "verifier").await.unwrap();
    assert_eq!(redeemed.user_id, user);
    assert_eq!(
        jwt.decode_access_token(&redeemed.access_token)
            .unwrap()
            .user_id,
        user
    );
    let identity = UserRepository::new(&pool).fetch_user(user).await.unwrap();
    assert_eq!(identity.email, "same@example.test");
    assert_eq!(identity.username.as_deref(), Some("original-name"));
    let original = accounts
        .get_by_user_provider(user, "github")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original.provider_user_id, "github-a");

    // Neither another GitHub identity nor an identity owned by another Vibe user is replaceable.
    for (target, github) in [(user, "github-b"), (other, "github-a")] {
        let (id, code) = authorize(&service, target, github).await;
        assert!(matches!(
            service.redeem(id, &code, "verifier").await,
            Err(HandoffError::Reconnect(
                OAuthReconnectError::AccountMismatch
            ))
        ));
        assert_eq!(
            handoffs.get(id).await.unwrap().status(),
            Some(AuthorizationStatus::Authorized)
        );
        assert_eq!(
            accounts
                .get_by_user_provider(user, "github")
                .await
                .unwrap()
                .unwrap()
                .encrypted_provider_tokens,
            original.encrypted_provider_tokens
        );
        assert!(
            accounts
                .get_by_user_provider(other, "github")
                .await
                .unwrap()
                .is_none()
        );
    }

    // Duplicate redemption must not rotate the winning response's refresh token away.
    let (id, code) = authorize(&service, user, "github-a").await;
    let (left, right) = tokio::join!(
        service.redeem(id, &code, "verifier"),
        service.redeem(id, &code, "verifier")
    );
    assert_ne!(left.is_ok(), right.is_ok());
    let winner = left.or(right).unwrap();
    let refresh = jwt.decode_refresh_token(&winner.refresh_token).unwrap();
    assert_eq!(
        AuthSessionRepository::new(&pool)
            .get(refresh.session_id)
            .await
            .unwrap()
            .refresh_token_id,
        Some(refresh.refresh_token_id)
    );

    // Concurrent first links to different GitHub identities serialize on the Vibe user.
    let (left_id, left_code) = authorize(&service, other, "github-b").await;
    let (right_id, right_code) = authorize(&service, other, "github-c").await;
    let (left, right) = tokio::join!(
        service.redeem(left_id, &left_code, "verifier"),
        service.redeem(right_id, &right_code, "verifier")
    );
    assert_ne!(left.is_ok(), right.is_ok());
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM oauth_accounts WHERE user_id = $1 AND provider = 'github'",
    )
    .bind(other)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);

    // A late revoked-session failure rolls back both consumption and credentials.
    let (id, _) = authorize(&service, user, "github-a").await;
    let session_id = handoffs.get(id).await.unwrap().session_id.unwrap();
    AuthSessionRepository::new(&pool)
        .revoke(session_id)
        .await
        .unwrap();
    let before = accounts
        .get_by_user_provider(user, "github")
        .await
        .unwrap()
        .unwrap();
    let result = accounts
        .reconnect_and_redeem(
            id,
            OAuthAccountInsert {
                user_id: user,
                provider: "github",
                provider_user_id: "github-a",
                email: None,
                username: None,
                display_name: None,
                avatar_url: None,
                encrypted_provider_tokens: Some("must-not-save"),
            },
            Uuid::new_v4(),
        )
        .await;
    assert!(matches!(result, Err(OAuthReconnectError::InvalidHandoff)));
    assert_eq!(
        handoffs.get(id).await.unwrap().status(),
        Some(AuthorizationStatus::Authorized)
    );
    assert_eq!(
        accounts
            .get_by_user_provider(user, "github")
            .await
            .unwrap()
            .unwrap()
            .encrypted_provider_tokens,
        before.encrypted_provider_tokens
    );

    // Linking GitHub from a different login provider still validates that
    // provider; recovery must not turn a revoked Google login into an account link.
    for credential in ["valid", "revoked"] {
        let google_user = Uuid::new_v4();
        UserRepository::new(&pool)
            .upsert_user(UpsertUser {
                id: google_user,
                email: &format!("{credential}@example.test"),
                username: None,
                first_name: None,
                last_name: None,
            })
            .await
            .unwrap();
        let encrypted = jwt
            .encrypt_provider_tokens(&ProviderTokenDetails {
                provider: "google".into(),
                access_token: credential.into(),
                refresh_token: None,
                expires_at: None,
            })
            .unwrap();
        accounts
            .upsert(OAuthAccountInsert {
                user_id: google_user,
                provider: "google",
                provider_user_id: credential,
                email: None,
                username: None,
                display_name: None,
                avatar_url: None,
                encrypted_provider_tokens: Some(&encrypted),
            })
            .await
            .unwrap();
        let token_id = Uuid::new_v4();
        let session = sessions.create(google_user, Some(token_id)).await.unwrap();
        let tokens = jwt
            .generate_tokens_for_refresh_token_id(
                &session,
                google_user,
                "google",
                token_id,
                Utc::now(),
            )
            .unwrap();
        let result = service
            .initiate_reconnect(
                "github",
                "https://vibe.example/account/complete",
                &challenge,
                &tokens.refresh_token,
            )
            .await;
        if credential == "valid" {
            assert_eq!(
                handoffs
                    .reconnect_user(result.unwrap().handoff_id)
                    .await
                    .unwrap(),
                Some(google_user)
            );
        } else {
            assert!(matches!(
                result,
                Err(HandoffError::ReconnectAuthentication(_))
            ));
            assert!(sessions.get(session.id).await.unwrap().revoked_at.is_some());
        }
        assert!(
            accounts
                .get_by_user_provider(google_user, "github")
                .await
                .unwrap()
                .is_none()
        );
    }

    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

struct DelayedValidationProvider {
    started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    refresh_succeeds: bool,
}

#[tokio::test]
#[ignore = "requires OAUTH_TEST_DATABASE_URL pointing to disposable PostgreSQL"]
async fn provider_account_read_failure_does_not_revoke_sessions() {
    let (pool, admin, schema) = test_pool().await;
    let user = Uuid::new_v4();
    UserRepository::new(&pool)
        .upsert_user(UpsertUser {
            id: user,
            email: "read-failure@example.test",
            username: None,
            first_name: None,
            last_name: None,
        })
        .await
        .unwrap();
    let sessions = AuthSessionRepository::new(&pool);
    let session = sessions.create(user, Some(Uuid::new_v4())).await.unwrap();
    // Break only the OAuth account read; session writes still work. The old
    // failure path would revoke this session despite having no revocation proof.
    sqlx::query(
        "ALTER TABLE oauth_accounts RENAME COLUMN encrypted_provider_tokens TO unavailable_tokens",
    )
    .execute(&pool)
    .await
    .unwrap();
    let jwt = Arc::new(JwtService::new(SecretString::new(
        STANDARD.encode(b"read-failure-secret").into(),
    )));
    let validator =
        crate::auth::OAuthTokenValidator::new(pool.clone(), Arc::new(ProviderRegistry::new()), jwt);
    assert!(matches!(
        validator.validate("github", user, session.id).await,
        Err(crate::auth::OAuthTokenValidationError::FetchAccountsFailed(
            _
        ))
    ));
    assert!(sessions.get(session.id).await.unwrap().revoked_at.is_none());
    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[async_trait::async_trait]
impl AuthorizationProvider for DelayedValidationProvider {
    fn name(&self) -> &'static str {
        "github"
    }
    fn scopes(&self) -> &[&str] {
        &["repo"]
    }
    fn authorize_url(&self, state: &str, redirect: &str) -> anyhow::Result<Url> {
        TestProvider("github").authorize_url(state, redirect)
    }
    async fn exchange_code(
        &self,
        code: &str,
        redirect: &str,
    ) -> anyhow::Result<AuthorizationGrant> {
        TestProvider("github").exchange_code(code, redirect).await
    }
    async fn fetch_user(&self, _: &SecretString) -> anyhow::Result<ProviderUser> {
        TestProvider("github")
            .fetch_user(&SecretString::new("race-user".into()))
            .await
    }
    async fn validate_token(
        &self,
        token: &ProviderTokenDetails,
        _: u32,
    ) -> Result<Option<ProviderTokenDetails>, TokenValidationError> {
        assert_eq!(token.access_token, "old-provider-token");
        self.started.notify_one();
        self.release.notified().await;
        if self.refresh_succeeds {
            Ok(Some(ProviderTokenDetails {
                provider: "github".into(),
                access_token: "late-provider-token".into(),
                refresh_token: None,
                expires_at: None,
            }))
        } else {
            Err(TokenValidationError::InvalidOrRevoked)
        }
    }
}

#[tokio::test]
#[ignore = "requires OAUTH_TEST_DATABASE_URL pointing to disposable PostgreSQL"]
async fn reconnect_survives_old_validation_before_and_after_redemption() {
    let (pool, admin, schema) = test_pool().await;
    let jwt = Arc::new(JwtService::new(SecretString::new(
        STANDARD.encode(b"reconnect-race-secret").into(),
    )));
    for (failure_before_redeem, refresh_succeeds) in [(true, false), (false, false), (false, true)]
    {
        let user = Uuid::new_v4();
        UserRepository::new(&pool)
            .upsert_user(UpsertUser {
                id: user,
                email: &format!("{user}@example.test"),
                username: None,
                first_name: None,
                last_name: None,
            })
            .await
            .unwrap();
        let accounts = OAuthAccountRepository::new(&pool);
        let encrypted = jwt
            .encrypt_provider_tokens(&ProviderTokenDetails {
                provider: "github".into(),
                access_token: "old-provider-token".into(),
                refresh_token: None,
                expires_at: None,
            })
            .unwrap();
        // Each case removes its own account before reusing this provider identity.
        accounts
            .upsert(OAuthAccountInsert {
                user_id: user,
                provider: "github",
                provider_user_id: "race-user",
                email: None,
                username: None,
                display_name: None,
                avatar_url: None,
                encrypted_provider_tokens: Some(&encrypted),
            })
            .await
            .unwrap();
        let sessions = AuthSessionRepository::new(&pool);
        let original = sessions.create(user, Some(Uuid::new_v4())).await.unwrap();
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let mut providers = ProviderRegistry::new();
        providers.register(DelayedValidationProvider {
            started: started.clone(),
            release: release.clone(),
            refresh_succeeds,
        });
        let providers = Arc::new(providers);
        let validator =
            crate::auth::OAuthTokenValidator::new(pool.clone(), providers.clone(), jwt.clone());
        let validation =
            tokio::spawn(async move { validator.validate("github", user, original.id).await });
        started.notified().await;
        let service = OAuthHandoffService::new(
            pool.clone(),
            providers,
            jwt.clone(),
            "https://vibe.example".into(),
        );
        let (id, code) = authorize(&service, user, "renewed-provider-token").await;
        let staged_session = OAuthHandoffRepository::new(&pool)
            .get(id)
            .await
            .unwrap()
            .session_id
            .unwrap();
        let validation = if failure_before_redeem {
            release.notify_one();
            assert!(matches!(
                validation.await.unwrap(),
                Err(crate::auth::OAuthTokenValidationError::ProviderTokenValidationFailed)
            ));
            assert!(
                sessions
                    .get(original.id)
                    .await
                    .unwrap()
                    .revoked_at
                    .is_some()
            );
            assert!(
                sessions
                    .get(staged_session)
                    .await
                    .unwrap()
                    .revoked_at
                    .is_none()
            );
            None
        } else {
            Some(validation)
        };
        let renewed = service.redeem(id, &code, "verifier").await.unwrap();
        if let Some(validation) = validation {
            release.notify_one();
            assert!(matches!(
                validation.await.unwrap(),
                Err(crate::auth::OAuthTokenValidationError::ValidationUnavailable(_))
            ));
            assert!(
                sessions
                    .get(original.id)
                    .await
                    .unwrap()
                    .revoked_at
                    .is_none()
            );
        }
        let new_session = jwt
            .decode_access_token(&renewed.access_token)
            .unwrap()
            .session_id;
        assert!(
            sessions
                .get(new_session)
                .await
                .unwrap()
                .revoked_at
                .is_none()
        );
        // A legacy request which observed NULL before redemption must not put
        // its old provider credential back after the reconnect commits.
        accounts
            .backfill_encrypted_provider_tokens(user, "github", &encrypted)
            .await
            .unwrap();
        let account = accounts
            .get_by_user_provider(user, "github")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            jwt.decrypt_provider_tokens(account.encrypted_provider_tokens.as_deref().unwrap())
                .unwrap()
                .access_token,
            "renewed-provider-token"
        );
        sqlx::query("DELETE FROM oauth_accounts WHERE user_id = $1")
            .bind(user)
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
