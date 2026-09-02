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
    let client = reqwest::Client::new();
    for attempt in 1..=5 {
        match client
            .post(format!("{}/api/events", url.trim_end_matches('/')))
            .timeout(std::time::Duration::from_secs(10))
            .bearer_auth(&token)
            .json(&event)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return,
            Ok(response) => {
                tracing::warn!(status = %response.status(), %event_type, attempt, "automation event rejected")
            }
            Err(error) => {
                tracing::warn!(%error, %event_type, attempt, "failed to emit automation event")
            }
        }
        if attempt < 5 {
            tokio::time::sleep(std::time::Duration::from_secs(attempt)).await;
        }
    }
}
