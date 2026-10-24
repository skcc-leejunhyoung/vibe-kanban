//! Allow-listed passthrough to the cloud API for the agent CLI/MCP: comments,
//! followers, milestones, notifications, attachments, bulk issue edits and the
//! other collaboration data that has no typed local route. The request is
//! forwarded with this host's bearer token; the upstream status and JSON body
//! come back unchanged.

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Path, RawQuery, State},
    http::{HeaderMap, Method, header},
    response::Response,
    routing::any,
};

use crate::{DeploymentImpl, error::ApiError};

/// `(v1 path prefix, allowed methods)`. The prefix matches whole segments, so
/// `issues` covers `/issues`, `/issues/bulk` and `/issues/{id}/attachments`.
const ALLOWED: &[(&str, &[&str])] = &[
    ("notifications", &["GET", "POST", "PATCH", "DELETE"]),
    ("user-notification-preferences", &["GET", "PUT"]),
    ("user-web-settings", &["GET", "PUT"]),
    ("issue_comments", &["GET", "POST", "PATCH", "DELETE"]),
    (
        "issue_comment_reactions",
        &["GET", "POST", "PATCH", "DELETE"],
    ),
    ("issue_followers", &["GET", "POST", "DELETE"]),
    ("project_milestones", &["GET", "POST", "PATCH", "DELETE"]),
    ("issue_milestones", &["GET", "POST", "DELETE"]),
    ("issues", &["GET", "POST", "PATCH", "DELETE"]),
    ("issue_tags", &["GET", "POST", "DELETE"]),
    ("issue_assignees", &["GET", "POST", "DELETE"]),
    ("issue_relationships", &["GET", "POST", "DELETE"]),
    ("tags", &["GET", "POST", "PATCH", "DELETE"]),
    ("attachments", &["GET", "POST", "DELETE"]),
    ("comments", &["GET", "POST"]),
    ("projects", &["GET", "POST", "PATCH"]),
    ("project_statuses", &["GET", "POST", "PATCH"]),
    ("pull_requests", &["GET"]),
    ("pull_request_issues", &["GET", "POST", "DELETE"]),
    ("github_issue_links", &["GET", "POST", "PATCH", "DELETE"]),
    ("github/pull-requests", &["GET"]),
    ("github/pull-requests/tracked/sync", &["POST"]),
    ("github/repositories", &["GET"]),
    ("organizations", &["GET", "PATCH"]),
    ("agent-memory/snapshots", &["GET"]),
    // The Drawer (Autopilot notes). Its notification goes through the local
    // `/notifications/send` route, which tags it itself.
    ("drawer_notes", &["GET", "POST", "PATCH", "DELETE"]),
    ("drawer_comments", &["GET", "POST", "DELETE"]),
];

/// Members and invitations stay with the typed local routes (and their own
/// agent ban); the proxy must not reopen them.
fn is_denied(tail: &str) -> bool {
    let parts: Vec<&str> = tail.split('/').filter(|s| !s.is_empty()).collect();
    matches!(
        parts.as_slice(),
        ["organizations", _, "members", ..] | ["organizations", _, "invitations", ..]
    )
}

/// Plain segments only: the upstream URL join would resolve `.`/`..` (also
/// percent-encoded or with `\`) past the allowlisted prefix.
fn is_plain(tail: &str) -> bool {
    tail.split('/').all(|segment| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    })
}

pub fn is_allowed(method: &Method, tail: &str) -> bool {
    let tail = tail.trim_matches('/');
    if !is_plain(tail) || is_denied(tail) {
        return false;
    }
    ALLOWED.iter().any(|(prefix, methods)| {
        let matches_prefix = tail == *prefix || tail.starts_with(&format!("{prefix}/"));
        matches_prefix && methods.contains(&method.as_str())
    })
}

async fn proxy(
    State(deployment): State<DeploymentImpl>,
    Path(tail): Path<String>,
    RawQuery(query): RawQuery,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let tail = tail.trim_matches('/').to_string();
    if !is_allowed(&method, &tail) {
        return Err(ApiError::Forbidden(format!(
            "cloud path '{tail}' ({method}) is not available through the agent proxy"
        )));
    }
    let client = deployment.remote_client()?;
    let path = match query {
        Some(query) if !query.is_empty() => format!("/v1/{tail}?{query}"),
        _ => format!("/v1/{tail}"),
    };
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json");
    let body = (!body.is_empty()).then_some(body);
    let (status, bytes) = client
        .proxy_raw(method, &path, body, Some(content_type))
        .await?;
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(bytes))
        .map_err(|error| ApiError::BadGateway(error.to_string()))
}

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new().route("/cloud/{*tail}", any(proxy))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_matches_whole_segments_and_methods() {
        assert!(is_allowed(&Method::GET, "notifications"));
        assert!(is_allowed(&Method::POST, "notifications/bulk"));
        assert!(is_allowed(&Method::POST, "issues/bulk"));
        assert!(is_allowed(&Method::POST, "issues/abc/mark_for_review"));
        assert!(is_allowed(&Method::PATCH, "organizations/abc"));
        assert!(!is_allowed(&Method::DELETE, "organizations/abc"));
        assert!(!is_allowed(&Method::GET, "organizations/abc/members"));
        assert!(!is_allowed(&Method::DELETE, "project_statuses/abc"));
        assert!(!is_allowed(&Method::GET, "hosts"));
        assert!(!is_allowed(&Method::POST, "tokens/refresh"));
        assert!(!is_allowed(&Method::GET, "issuesx"));
    }

    #[test]
    fn dot_segments_cannot_leave_the_allowed_prefix() {
        for tail in [
            "issues/../organizations/abc",
            "issue_comments/%2e%2e/organizations/abc/members/u",
            "issues/./x",
            "issues//x",
            "issues/..\\tokens",
            "issues/x?y",
        ] {
            assert!(!is_allowed(&Method::DELETE, tail), "{tail}");
        }
        assert!(is_allowed(&Method::GET, "attachments/abc/file.png"));
    }
}
