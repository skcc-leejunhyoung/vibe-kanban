use axum::http::HeaderMap;

/// Scheme used to reach a preview dev server. Dev servers usually speak plain
/// HTTP, but some sit behind nginx/Caddy terminating TLS on the same port; the
/// proxy auto-detects and caches the scheme per port so those still work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UpstreamScheme {
    Http,
    Https,
}

impl UpstreamScheme {
    /// URL scheme for HTTP requests (`http` / `https`).
    pub(crate) fn as_http(self) -> &'static str {
        match self {
            UpstreamScheme::Http => "http",
            UpstreamScheme::Https => "https",
        }
    }
}

/// nginx (and Caddy) reply with `400 Bad Request` containing this phrase when a
/// plaintext HTTP request reaches a TLS listener. We use it to detect an HTTPS
/// dev server and transparently retry the request over TLS.
const PLAIN_HTTP_TO_HTTPS_MARKER: &str = "The plain HTTP request was sent to HTTPS port";

/// Whether a proxied `400` response is the "plaintext sent to a TLS port"
/// signal. The marker lives in a tiny error page, so the scan is bounded.
pub(crate) fn is_plain_http_to_https_response(body: &[u8]) -> bool {
    let scan_len = body.len().min(4096);
    String::from_utf8_lossy(&body[..scan_len]).contains(PLAIN_HTTP_TO_HTTPS_MARKER)
}

pub(crate) const SKIP_REQUEST_HEADERS: &[&str] = &[
    "host",
    "connection",
    "transfer-encoding",
    "upgrade",
    "proxy-connection",
    "keep-alive",
    "te",
    "trailer",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "accept-encoding",
    "origin",
    // Relay signing headers must not leak into preview dev servers. When a VK
    // instance is the preview target, forwarding these causes it to treat the
    // request as a relay request and reject it (the preview's signing service
    // has no knowledge of the session).
    "x-vk-relayed",
    "x-vk-sig-session",
    "x-vk-sig-ts",
    "x-vk-sig-nonce",
    "x-vk-sig-signature",
];

pub(crate) fn normalized_proxy_path(path: &str) -> &str {
    path.trim_start_matches('/')
}

pub(crate) fn should_forward_request_header(name: &str) -> bool {
    let name_lower = name.to_ascii_lowercase();
    !SKIP_REQUEST_HEADERS.contains(&name_lower.as_str())
}

pub(crate) fn build_local_upstream_url(
    scheme: &str,
    target_port: u16,
    path: &str,
    query: &str,
) -> String {
    let normalized_path = normalized_proxy_path(path);
    if normalized_path.is_empty() {
        if query.is_empty() {
            format!("{scheme}://localhost:{target_port}/")
        } else {
            format!("{scheme}://localhost:{target_port}/?{query}")
        }
    } else if query.is_empty() {
        format!("{scheme}://localhost:{target_port}/{normalized_path}")
    } else {
        format!("{scheme}://localhost:{target_port}/{normalized_path}?{query}")
    }
}

pub(crate) fn extract_ws_protocols(headers: &HeaderMap) -> Option<String> {
    headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}
