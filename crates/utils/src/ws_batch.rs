//! Batches a `LogMsg` stream into WebSocket frames.
//!
//! Streaming normalizers emit a `replace` per token for the entry being
//! written, so a browser receives thousands of frames per burst and re-renders
//! for each. Patches arriving within one short window are merged into a single
//! op array; a `replace` superseded by a later `replace` on the same path is
//! dropped when only unrelated replaces sit between them. Any other message
//! (`Ready`, `Finished`, session ids) or an error is a barrier: the pending
//! batch is flushed first, then the barrier is forwarded unchanged.

use std::{collections::HashMap, time::Duration};

use axum::extract::ws::Message;
use futures::{Stream, StreamExt, stream::BoxStream};
use json_patch::{Patch, PatchOperation};

use crate::log_msg::LogMsg;

/// Upper bound of source messages merged into one frame.
pub const MAX_BATCH: usize = 64;
/// How long a partial batch waits for more messages before being sent.
pub const BATCH_WINDOW: Duration = Duration::from_millis(30);

pub fn coalesce_ws_stream<S, E>(stream: S) -> BoxStream<'static, Result<Message, E>>
where
    S: Stream<Item = Result<LogMsg, E>> + Send + 'static,
    E: Send + 'static,
{
    tokio_stream::StreamExt::chunks_timeout(stream, MAX_BATCH, BATCH_WINDOW)
        .flat_map(|chunk| futures::stream::iter(coalesce_chunk(chunk)))
        .boxed()
}

pub fn coalesce_chunk<E>(chunk: Vec<Result<LogMsg, E>>) -> Vec<Result<Message, E>> {
    let mut out = Vec::with_capacity(chunk.len());
    let mut ops: Vec<PatchOperation> = Vec::new();
    for item in chunk {
        match item {
            Ok(LogMsg::JsonPatch(patch)) => ops.extend(patch.0),
            barrier => {
                flush_ops(&mut ops, &mut out);
                out.push(barrier.map(|msg| msg.to_ws_message_unchecked()));
            }
        }
    }
    flush_ops(&mut ops, &mut out);
    out
}

fn flush_ops<E>(ops: &mut Vec<PatchOperation>, out: &mut Vec<Result<Message, E>>) {
    if ops.is_empty() {
        return;
    }
    let patch = Patch(squash_replaces(std::mem::take(ops)));
    out.push(Ok(LogMsg::JsonPatch(patch).to_ws_message_unchecked()));
}

/// Drop a `replace` that a later `replace` on the same path supersedes, when
/// only replaces on unrelated paths sit in between. Everything else commits the
/// ops before it: add/remove/move shift array indices, and a replace on an
/// ancestor or descendant path depends on the intermediate value.
pub fn squash_replaces(ops: Vec<PatchOperation>) -> Vec<PatchOperation> {
    let mut dropped = vec![false; ops.len()];
    let mut pending: HashMap<String, usize> = HashMap::new();
    for (index, op) in ops.iter().enumerate() {
        let PatchOperation::Replace(replace) = op else {
            pending.clear();
            continue;
        };
        let path = replace.path.as_str();
        pending.retain(|other, _| other == path || !related(other, path));
        if let Some(previous) = pending.insert(path.to_string(), index) {
            dropped[previous] = true;
        }
    }
    ops.into_iter()
        .zip(dropped)
        .filter_map(|(op, dropped)| (!dropped).then_some(op))
        .collect()
}

/// Whether one JSON pointer is a strict ancestor of the other.
fn related(a: &str, b: &str) -> bool {
    let is_prefix = |outer: &str, inner: &str| {
        inner
            .strip_prefix(outer)
            .is_some_and(|rest| rest.starts_with('/'))
    };
    is_prefix(a, b) || is_prefix(b, a)
}

#[cfg(test)]
mod tests {
    use json_patch::{AddOperation, Patch, PatchOperation, RemoveOperation, ReplaceOperation};
    use serde_json::json;

    use super::*;

    fn add(path: &str, value: usize) -> PatchOperation {
        PatchOperation::Add(AddOperation {
            path: path.parse().unwrap(),
            value: json!(value),
        })
    }

    fn remove(path: &str) -> PatchOperation {
        PatchOperation::Remove(RemoveOperation {
            path: path.parse().unwrap(),
        })
    }

    fn replace(path: &str, value: usize) -> PatchOperation {
        PatchOperation::Replace(ReplaceOperation {
            path: path.parse().unwrap(),
            value: json!(value),
        })
    }

    fn patch(op: PatchOperation) -> Result<LogMsg, std::io::Error> {
        Ok(LogMsg::JsonPatch(Patch(vec![op])))
    }

    fn text(msg: &Message) -> &str {
        match msg {
            Message::Text(text) => text.as_str(),
            other => panic!("expected text frame, got {other:?}"),
        }
    }

    fn ops(msg: &Message) -> Vec<PatchOperation> {
        match serde_json::from_str::<LogMsg>(text(msg)).unwrap() {
            LogMsg::JsonPatch(patch) => patch.0,
            other => panic!("expected patch frame, got {other:?}"),
        }
    }

    async fn collect(
        items: Vec<Result<LogMsg, std::io::Error>>,
    ) -> Vec<Result<Message, std::io::Error>> {
        coalesce_ws_stream(futures::stream::iter(items))
            .collect()
            .await
    }

    #[tokio::test]
    async fn burst_of_replaces_on_one_path_collapses_to_last_value() {
        const BURST: usize = 1_000;
        let frames = collect(
            (0..BURST)
                .map(|i| patch(replace("/entries/7", i)))
                .collect(),
        )
        .await;

        assert!(frames.len() <= BURST.div_ceil(MAX_BATCH));
        for frame in &frames {
            assert_eq!(ops(frame.as_ref().unwrap()).len(), 1);
        }
        assert_eq!(
            ops(frames.last().unwrap().as_ref().unwrap()),
            vec![replace("/entries/7", BURST - 1)]
        );
        println!(
            "WS frames for a burst of {BURST} replaces: {}",
            frames.len()
        );
    }

    #[tokio::test]
    async fn adds_are_batched_in_order_without_loss() {
        const BURST: usize = 200;
        let frames = collect(
            (0..BURST)
                .map(|i| patch(add(&format!("/entries/{i}"), i)))
                .collect(),
        )
        .await;

        assert!(frames.len() <= BURST.div_ceil(MAX_BATCH));
        let all: Vec<PatchOperation> = frames
            .iter()
            .flat_map(|frame| ops(frame.as_ref().unwrap()))
            .collect();
        let expected: Vec<PatchOperation> = (0..BURST)
            .map(|i| add(&format!("/entries/{i}"), i))
            .collect();
        assert_eq!(all, expected);
    }

    #[tokio::test]
    async fn barriers_flush_pending_ops_and_keep_their_place() {
        let frames = collect(vec![
            patch(replace("/a", 1)),
            Ok(LogMsg::Finished),
            patch(replace("/a", 2)),
        ])
        .await;

        assert_eq!(frames.len(), 3);
        assert_eq!(ops(frames[0].as_ref().unwrap()), vec![replace("/a", 1)]);
        assert_eq!(text(frames[1].as_ref().unwrap()), r#"{"finished":true}"#);
        assert_eq!(ops(frames[2].as_ref().unwrap()), vec![replace("/a", 2)]);
    }

    #[tokio::test]
    async fn error_flushes_pending_ops_then_propagates() {
        let frames = collect(vec![
            patch(replace("/a", 1)),
            Err(std::io::Error::other("lagged")),
        ])
        .await;

        assert_eq!(frames.len(), 2);
        assert_eq!(ops(frames[0].as_ref().unwrap()), vec![replace("/a", 1)]);
        assert!(frames[1].is_err());
    }

    #[test]
    fn squash_keeps_unrelated_replaces_and_drops_superseded_ones() {
        assert_eq!(
            squash_replaces(vec![replace("/x", 1), replace("/y", 1), replace("/x", 2)]),
            vec![replace("/y", 1), replace("/x", 2)]
        );
    }

    #[test]
    fn squash_never_reorders_across_add_or_remove() {
        let ops = vec![
            replace("/entries/3", 1),
            add("/entries/2", 9),
            replace("/entries/3", 2),
            remove("/entries/0"),
            replace("/entries/3", 3),
        ];
        assert_eq!(squash_replaces(ops.clone()), ops);
    }

    #[test]
    fn squash_commits_replaces_on_ancestor_or_descendant_paths() {
        let ops = vec![
            replace("/a", 1),
            replace("/a/b", 2),
            replace("/a", 3),
            replace("/ab", 4),
            replace("/a/b", 5),
        ];
        assert_eq!(squash_replaces(ops.clone()), ops);
        assert_eq!(
            squash_replaces(vec![replace("/a", 1), replace("/ab", 2), replace("/a", 3)]),
            vec![replace("/ab", 2), replace("/a", 3)]
        );
    }
}
