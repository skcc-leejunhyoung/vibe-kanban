//! Measures the normalized-patch volume a raw agent log produces when it is
//! replayed through the live normalizer. This is what every WebSocket
//! subscriber of a running process receives, so it is the number the
//! streaming-patch throttling (SKC-4772) is meant to shrink.
//!
//! Ignored by default: point it at a persisted process log and run it with
//!
//! ```text
//! VK_MEASURE_LOG=/path/to/<process>.jsonl VK_MEASURE_EXECUTOR=codex \
//!   cargo test -p executors --test stream_patch_volume -- --ignored --nocapture
//! ```

use std::{path::Path, sync::Arc, time::Instant};

use executors::executors::{StandardCodingAgentExecutor, claude::ClaudeCode, codex::Codex};
use tokio::sync::broadcast::error::RecvError;
use workspace_utils::{log_msg::LogMsg, msg_store::MsgStore};

#[derive(Default, Debug)]
struct Volume {
    patches: usize,
    replaces: usize,
    bytes: usize,
    largest_patch: usize,
    lagged: u64,
}

/// Single-threaded runtime: the normalizer yields every 256 lines, which is
/// when the counting subscriber drains the broadcast channel, so the counter
/// sees every patch exactly as a WebSocket forwarder would (lag is reported).
#[tokio::test(flavor = "current_thread")]
#[ignore = "needs VK_MEASURE_LOG; prints a measurement instead of asserting"]
async fn measure_patch_volume_of_raw_log() {
    let path = std::env::var("VK_MEASURE_LOG").expect("VK_MEASURE_LOG=<raw process log>");
    let executor = std::env::var("VK_MEASURE_EXECUTOR").unwrap_or_else(|_| "codex".to_string());
    let raw = std::fs::read_to_string(&path).expect("readable log");

    let store = Arc::new(MsgStore::new());
    let mut raw_lines = 0usize;
    for line in raw.lines() {
        if let Ok(msg @ (LogMsg::Stdout(_) | LogMsg::Stderr(_))) =
            serde_json::from_str::<LogMsg>(line)
        {
            raw_lines += 1;
            store.push(msg);
        }
    }
    store.push_finished();

    let mut live = store.get_receiver();
    let counter = tokio::spawn(async move {
        let mut volume = Volume::default();
        loop {
            match live.recv().await {
                Ok(LogMsg::JsonPatch(patch)) => {
                    let bytes = serde_json::to_string(&LogMsg::JsonPatch(patch.clone()))
                        .map(|json| json.len())
                        .unwrap_or_default();
                    volume.patches += 1;
                    volume.bytes += bytes;
                    volume.largest_patch = volume.largest_patch.max(bytes);
                    if patch
                        .0
                        .iter()
                        .all(|op| matches!(op, json_patch::PatchOperation::Replace(_)))
                    {
                        volume.replaces += 1;
                    }
                }
                Ok(LogMsg::StorageFinished) | Err(RecvError::Closed) => break,
                Ok(_) => {}
                Err(RecvError::Lagged(n)) => volume.lagged += n,
            }
        }
        volume
    });

    let started = Instant::now();
    let handles = match executor.as_str() {
        "claude" => serde_json::from_value::<ClaudeCode>(serde_json::json!({}))
            .unwrap()
            .normalize_logs(store.clone(), Path::new("/tmp/measure")),
        _ => serde_json::from_value::<Codex>(serde_json::json!({}))
            .unwrap()
            .normalize_logs(store.clone(), Path::new("/tmp/measure")),
    };
    for handle in handles {
        handle.await.unwrap();
    }
    let elapsed = started.elapsed();
    store.push(LogMsg::StorageFinished);
    let volume = counter.await.unwrap();

    let history_patches = store
        .get_history()
        .iter()
        .filter(|msg| matches!(msg, LogMsg::JsonPatch(_)))
        .count();
    println!(
        "log={path} executor={executor} raw_lines={raw_lines} raw_bytes={} elapsed_ms={}",
        raw.len(),
        elapsed.as_millis()
    );
    println!(
        "patches={} replaces={} patch_bytes={} largest_patch={} lagged={} history_patches={history_patches}",
        volume.patches, volume.replaces, volume.bytes, volume.largest_patch, volume.lagged
    );
}
