use serde_json::Value;

pub async fn emit_event(event_type: &str, id: impl ToString, data: Value) {
    let Some((url, token)) = endpoint() else {
        return;
    };
    let mut event = serde_json::json!({
        "id": id.to_string(),
        "type": event_type,
        "source": "vibe",
    });
    if let (Some(event), Some(data)) = (event.as_object_mut(), data.as_object()) {
        event.extend(data.clone());
    }
    let result = reqwest::Client::new()
        .post(format!("{}/api/events", url.trim_end_matches('/')))
        .bearer_auth(token)
        .json(&event)
        .send()
        .await;
    if let Err(error) = result {
        tracing::warn!(%error, %event_type, "failed to emit automation event");
    }
}

fn endpoint() -> Option<(String, String)> {
    let url = std::env::var("AUTOMATION_WORKER_URL").ok()?;
    let token = std::env::var("AUTOMATION_WORKER_TOKEN")
        .or_else(|_| std::env::var("ADMIN_TOKEN"))
        .ok()?;
    (!url.trim().is_empty() && !token.trim().is_empty()).then_some((url, token))
}
