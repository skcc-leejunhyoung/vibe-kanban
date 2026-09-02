use serde_json::Value;

pub async fn emit_event(event_type: &str, id: impl ToString, data: Value) {
    let url = std::env::var("AUTOMATION_WORKER_INTERNAL_URL")
        .unwrap_or_else(|_| "http://automation-worker:8787".to_string());
    let Ok(token) = std::env::var("ADMIN_TOKEN") else {
        return;
    };
    if token.trim().is_empty() {
        return;
    }
    let mut event = serde_json::json!({
        "id": id.to_string(),
        "type": event_type,
        "source": "vibe",
    });
    if let (Some(event), Some(data)) = (event.as_object_mut(), data.as_object()) {
        event.extend(data.clone());
    }
    if let Err(error) = reqwest::Client::new()
        .post(format!("{}/api/events", url.trim_end_matches('/')))
        .bearer_auth(token)
        .json(&event)
        .send()
        .await
    {
        tracing::warn!(%error, %event_type, "failed to emit automation event");
    }
}
