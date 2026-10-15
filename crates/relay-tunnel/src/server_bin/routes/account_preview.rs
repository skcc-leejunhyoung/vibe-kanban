use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use relay_control::account::{credential_hash, new_credential};
use relay_tunnel_core::server::{RelayCancellation, proxy_request_over_control};
use uuid::Uuid;

use super::super::state::RelayAppState;

const COOKIE: &str = "__Host-vk-preview";

pub fn parse_target(host: &str, suffix: &str) -> Option<(Uuid, u16)> {
    let label = host
        .strip_suffix(&format!(".{suffix}"))?
        .strip_prefix("p-")?;
    let (port, id) = label.split_once("--")?;
    let port = port.parse::<u16>().ok()?;
    if port < 1024 {
        return None;
    }
    Some((id.parse().ok()?, port))
}

pub fn matches(request: &Request, suffix: Option<&str>) -> bool {
    suffix
        .zip(
            request
                .headers()
                .get(header::HOST)
                .and_then(|v| v.to_str().ok()),
        )
        .is_some_and(|(suffix, host)| parse_target(host, suffix).is_some())
}

pub async fn handle(State(state): State<RelayAppState>, mut request: Request) -> Response {
    let Some(suffix) = state.config.preview_host_suffix.as_deref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let Some((host_id, port)) = parse_target(&host, suffix) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let expected_origin = format!("https://{host}");
    if request.uri().path() == "/__vk/authorize" {
        return exchange(&state, host_id, port, request).await;
    }
    let has_origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    let requires_origin = (!matches!(*request.method(), Method::GET | Method::HEAD))
        || request.headers().contains_key(header::UPGRADE);
    if (requires_origin && has_origin != Some(expected_origin.as_str()))
        || has_origin.is_some_and(|v| v != expected_origin)
    {
        return (StatusCode::FORBIDDEN, "Preview origin rejected").into_response();
    }
    let cookie = request
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|cookies| {
            cookies
                .split(';')
                .filter_map(|c| c.trim().split_once('='))
                .find(|(name, _)| *name == COOKIE)
                .map(|(_, value)| value)
        });
    let Some(hash) = cookie.and_then(|value| credential_hash(value).ok()) else {
        return (
            StatusCode::UNAUTHORIZED,
            "앱에서 보호된 미리보기를 다시 열어 주세요.",
        )
            .into_response();
    };
    let row:Option<(Uuid,Uuid)>=match sqlx::query_as("SELECT p.id,p.connection_id FROM host_preview_sessions p JOIN hosts h ON h.id=p.host_id WHERE p.host_id=$1 AND p.port=$2 AND p.cookie_hash=$3 AND p.consumed_at IS NOT NULL AND p.expires_at>clock_timestamp() AND $2=ANY(h.preview_ports) AND h.preview_ports_updated_at>clock_timestamp()-INTERVAL '40 seconds' AND host_connection_allowed(p.connection_id,p.host_id)")
        .bind(host_id).bind(i32::from(port)).bind(hash).fetch_optional(&state.pool).await {Ok(row)=>row,Err(_)=>return StatusCode::SERVICE_UNAVAILABLE.into_response()};
    let Some((preview_id, connection_id)) = row else {
        return (
            StatusCode::FORBIDDEN,
            "미리보기 접근 권한이 해제되었거나 개발 서버가 종료되었습니다.",
        )
            .into_response();
    };
    let Some(relay) = state.relay_registry.get(&host_id).await else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Host is offline").into_response();
    };
    strip_private_headers(request.headers_mut());
    request.headers_mut().insert(
        header::HOST,
        HeaderValue::from_str(&format!("{port}.{suffix}")).unwrap(),
    );
    request.headers_mut().insert(
        "x-vk-preview-session",
        HeaderValue::from_str(&preview_id.to_string()).unwrap(),
    );
    request.headers_mut().insert(
        "x-vk-preview-origin",
        HeaderValue::from_str(&expected_origin).unwrap(),
    );
    let cancellation = state
        .connection_guards
        .watch(state.pool.clone(), host_id, connection_id)
        .await;
    request
        .extensions_mut()
        .insert(RelayCancellation(cancellation));
    let mut response = proxy_request_over_control(relay.control.as_ref(), request, "").await;
    let cookies = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter(|v| {
            v.to_str().is_ok_and(|s| {
                !s.split_once('=')
                    .is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case(COOKIE))
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    response.headers_mut().remove(header::SET_COOKIE);
    for cookie in cookies {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
        .headers_mut()
        .insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response.headers_mut().append(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("frame-ancestors 'none'"),
    );
    response
}

pub fn strip_private_headers(headers: &mut axum::http::HeaderMap) {
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .filter(|part| {
                    !part
                        .split_once('=')
                        .is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case(COOKIE))
                })
                .collect::<Vec<_>>()
                .join(";")
        });
    headers.remove(header::COOKIE);
    if let Some(cookie) = cookie.filter(|s| !s.trim().is_empty())
        && let Ok(value) = HeaderValue::from_str(&cookie)
    {
        headers.insert(header::COOKIE, value);
    }
    let private = headers
        .keys()
        .filter(|name| {
            name.as_str().starts_with("x-vk-")
                || name.as_str().starts_with("x-forwarded-")
                || *name == header::AUTHORIZATION
                || *name == header::PROXY_AUTHORIZATION
                || name.as_str() == "forwarded"
        })
        .cloned()
        .collect::<Vec<_>>();
    for name in private {
        headers.remove(name);
    }
}

async fn exchange(state: &RelayAppState, host: Uuid, port: u16, request: Request) -> Response {
    if request.method() != Method::POST {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let Ok(body) = to_bytes(request.into_body(), 2048).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let form = url::form_urlencoded::parse(&body).collect::<Vec<_>>();
    let Some(code) = form
        .iter()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.as_ref())
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Ok(hash) = credential_hash(code) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let cookie = new_credential();
    let cookie_hash = credential_hash(&cookie).unwrap();
    let result=sqlx::query_scalar::<_,Uuid>("UPDATE host_preview_sessions p SET consumed_at=clock_timestamp(),cookie_hash=$5 WHERE p.host_id=$1 AND p.port=$2 AND p.exchange_hash=$3 AND p.app_origin=$4 AND p.consumed_at IS NULL AND p.exchange_expires_at>clock_timestamp() AND host_connection_allowed(p.connection_id,p.host_id) RETURNING p.id")
        .bind(host).bind(i32::from(port)).bind(hash).bind(origin).bind(cookie_hash).fetch_optional(&state.pool).await;
    match result {
        Ok(Some(_)) => {
            let mut response = StatusCode::SEE_OTHER.into_response();
            response
                .headers_mut()
                .insert(header::LOCATION, HeaderValue::from_static("/"));
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response.headers_mut().insert(
                header::REFERRER_POLICY,
                HeaderValue::from_static("no-referrer"),
            );
            response.headers_mut().insert(
                header::SET_COOKIE,
                HeaderValue::from_str(&format!(
                    "{COOKIE}={cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200"
                ))
                .unwrap(),
            );
            response
        }
        Ok(None) => (
            StatusCode::UNAUTHORIZED,
            "미리보기 코드가 만료되었거나 이미 사용되었습니다. 앱에서 다시 열어 주세요.",
        )
            .into_response(),
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

#[cfg(test)]
mod host_access_tests {
    use std::sync::Arc;

    use super::*;
    use crate::server_bin::{auth::JwtService, config::RelayServerConfig};
    #[test]
    fn protected_origin_and_private_headers_are_not_forwarded_to_dev_servers() {
        let id = Uuid::new_v4();
        let target = format!("p-5173--{id}.preview.test");
        assert_eq!(parse_target(&target, "preview.test"), Some((id, 5173)));
        assert!(parse_target(&format!("{target}.attacker.test"), "preview.test").is_none());
        assert!(parse_target(&format!("p-80--{id}.preview.test"), "preview.test").is_none());
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "app=one; __Host-vk-preview=secret; theme=dark"
                .parse()
                .unwrap(),
        );
        headers.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        headers.insert("x-vk-session", "private".parse().unwrap());
        headers.insert("x-forwarded-host", "evil".parse().unwrap());
        strip_private_headers(&mut headers);
        assert_eq!(headers[header::COOKIE], "app=one; theme=dark");
        assert!(!headers.contains_key(header::AUTHORIZATION));
        assert!(!headers.contains_key("x-vk-session"));
        assert!(!headers.contains_key("x-forwarded-host"));
    }
    #[tokio::test]
    #[ignore = "requires HOST_ACCESS_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
    async fn preview_code_exchange_is_single_use_origin_bound_and_revocable() {
        let pool = sqlx::PgPool::connect(&std::env::var("HOST_ACCESS_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        let owner = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id,email) VALUES ($1,$2)")
            .bind(owner)
            .bind(format!("{owner}@example.test"))
            .execute(&pool)
            .await
            .unwrap();
        let session: Uuid =
            sqlx::query_scalar("INSERT INTO auth_sessions (user_id) VALUES ($1) RETURNING id")
                .bind(owner)
                .fetch_one(&pool)
                .await
                .unwrap();
        let host:Uuid=sqlx::query_scalar("INSERT INTO hosts(owner_user_id,machine_id,name,auth_mode,preview_ports,preview_ports_updated_at) VALUES ($1,'preview','Preview','account',ARRAY[5173],clock_timestamp()) RETURNING id").bind(owner).fetch_one(&pool).await.unwrap();
        let connection = Uuid::new_v4();
        sqlx::query("INSERT INTO relay_browser_sessions(id,host_id,user_id,auth_session_id,public_key_b64,host_generation,grant_version,expires_at) SELECT $1,id,$3,$4,'',auth_generation,0,clock_timestamp()+INTERVAL '5 minutes' FROM hosts WHERE id=$2").bind(connection).bind(host).bind(owner).bind(session).execute(&pool).await.unwrap();
        let preview = Uuid::new_v4();
        let code = new_credential();
        sqlx::query("INSERT INTO host_preview_sessions(id,host_id,connection_id,port,app_origin,exchange_hash,exchange_expires_at,expires_at) VALUES ($1,$2,$3,5173,'https://app.test',$4,clock_timestamp()+INTERVAL '30 seconds',clock_timestamp()+INTERVAL '5 minutes')").bind(preview).bind(host).bind(connection).bind(credential_hash(&code).unwrap()).execute(&pool).await.unwrap();
        let secret = secrecy::SecretString::new("test-secret".into());
        let state = RelayAppState::new(
            pool.clone(),
            RelayServerConfig {
                database_url: String::new(),
                listen_addr: String::new(),
                jwt_secret: secret.clone(),
                preview_host_suffix: Some("preview.test".into()),
            },
            Arc::new(JwtService::new(secret)),
        );
        let target = format!("p-5173--{host}.preview.test");
        let request = |origin: &str| {
            Request::builder()
                .method("POST")
                .uri("/__vk/authorize")
                .header("host", &target)
                .header("origin", origin)
                .body(axum::body::Body::from(format!("code={code}")))
                .unwrap()
        };
        assert_eq!(
            handle(State(state.clone()), request("https://attacker.test"))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let first = handle(State(state.clone()), request("https://app.test")).await;
        assert_eq!(first.status(), StatusCode::SEE_OTHER);
        assert_eq!(first.headers()[header::LOCATION], "/");
        let cookie = first.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_owned();
        for required in ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"] {
            assert!(cookie.contains(required));
        }
        assert_eq!(
            handle(State(state.clone()), request("https://app.test"))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let ordinary = |method: &str, origin: &str| {
            Request::builder()
                .method(method)
                .uri("/api")
                .header("host", &target)
                .header("cookie", cookie.split(';').next().unwrap())
                .header("origin", origin)
                .body(axum::body::Body::empty())
                .unwrap()
        };
        assert_eq!(
            handle(
                State(state.clone()),
                ordinary("POST", "https://attacker.test")
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            handle(
                State(state.clone()),
                ordinary("GET", &format!("https://{target}"))
            )
            .await
            .status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "valid cookie proceeds to host lookup"
        );
        let cancelled = state
            .connection_guards
            .watch(pool.clone(), host, connection)
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        sqlx::query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1")
            .bind(session)
            .execute(&pool)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), cancelled.cancelled())
            .await
            .expect("active preview stream must close within five seconds");
        assert_eq!(
            handle(State(state), ordinary("GET", &format!("https://{target}")))
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        sqlx::query("DELETE FROM users WHERE id=$1")
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }
}
