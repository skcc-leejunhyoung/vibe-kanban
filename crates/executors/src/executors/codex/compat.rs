use codex_app_server_protocol::ThreadItem;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// New item kinds must not make an entire thread or turn unreadable on a CLI upgrade.
/// Keep validation of known items and leave the original wire logs intact.
pub(super) fn decode<T: DeserializeOwned>(mut value: Value) -> serde_json::Result<T> {
    match T::deserialize(&value) {
        Ok(parsed) => return Ok(parsed),
        Err(error) => {
            if !filter_history(&mut value) {
                return Err(error);
            }
        }
    }
    serde_json::from_value(value)
}

fn unknown_item(item: &Value) -> bool {
    let Some(kind) = item.get("type").and_then(Value::as_str) else {
        return false;
    };
    // Probe only the discriminator, so an invalid field on a known kind is never discarded.
    let probe = serde_json::json!({"type": kind});
    serde_json::from_value::<ThreadItem>(probe)
        .is_err_and(|error| error.to_string().starts_with("unknown variant"))
}

fn filter_items(turn: &mut Value) -> bool {
    let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
        return false;
    };
    let before = items.len();
    items.retain(|item| !unknown_item(item));
    before != items.len()
}

fn filter_history(value: &mut Value) -> bool {
    let mut changed = false;
    if let Some(params) = value.get_mut("params") {
        changed |= filter_history(params);
    }
    if let Some(thread) = value.get_mut("thread")
        && let Some(turns) = thread.get_mut("turns").and_then(Value::as_array_mut)
    {
        for turn in turns {
            changed |= filter_items(turn);
        }
    }
    if let Some(turn) = value.get_mut("turn") {
        changed |= filter_items(turn);
    }
    if let Some(data) = value.get_mut("data").and_then(Value::as_array_mut) {
        let before = data.len();
        data.retain(|entry| !entry.get("item").is_some_and(unknown_item));
        changed |= before != data.len();
        for turn in data {
            changed |= filter_items(turn);
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use codex_app_server_protocol::{ThreadItemsListResponse, TurnCompletedNotification};
    use serde_json::json;

    use super::*;

    #[test]
    fn future_items_do_not_hide_completed_turns_or_known_messages() {
        let value = json!({"threadId": "test-thread", "turn": {
            "id": "test-turn", "status": "completed", "error": null,
            "items": [
                {"type": "futureTool", "id": "future-item", "payload": {}},
                {"type": "agentMessage", "id": "answer", "text": "Test answer"}
            ]
        }});
        let result: TurnCompletedNotification = decode(value).unwrap();
        assert_eq!(result.turn.items.len(), 1);
        assert!(
            matches!(&result.turn.items[0], ThreadItem::AgentMessage { text, .. } if text == "Test answer")
        );
    }

    #[test]
    fn paginated_history_skips_only_unknown_item_kinds() {
        let response: ThreadItemsListResponse = decode(json!({
            "data": [
                {"turnId": "test-turn", "item": {"type": "futureTool", "id": "future"}},
                {"turnId": "test-turn", "item": {"type": "agentMessage", "id": "answer", "text": "Retained"}}
            ], "nextCursor": null, "backwardsCursor": null
        })).unwrap();
        assert_eq!(response.data.len(), 1);
    }

    #[test]
    fn malformed_known_items_still_fail_validation() {
        let value = json!({"data": [
            {"turnId": "test-turn", "item": {"type": "futureTool", "id": "future"}},
            {"turnId": "test-turn", "item": {"type": "agentMessage", "id": "broken", "text": 42}}
        ], "nextCursor": null});
        assert!(decode::<ThreadItemsListResponse>(value).is_err());
    }
}
