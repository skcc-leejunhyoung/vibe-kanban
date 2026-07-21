use std::{
    collections::{HashMap, VecDeque},
    io::{self, Write},
    sync::{Arc, RwLock},
};

use futures::{StreamExt, future};
use tokio::{sync::broadcast, task::JoinHandle};
use tokio_stream::wrappers::{BroadcastStream, errors::BroadcastStreamRecvError};

use crate::{log_msg::LogMsg, stream_lines::LinesStreamExt};

// 100 MB Limit
const HISTORY_BYTES: usize = 100000 * 1024;
const BROADCAST_CAPACITY: usize = 1024;
const REPLAY_BROADCAST_CAPACITY: usize = 256;

pub(crate) struct ByteCounter {
    bytes: usize,
}

impl ByteCounter {
    pub(crate) fn new() -> Self {
        Self { bytes: 0 }
    }

    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }
}

impl Write for ByteCounter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.bytes = self.bytes.saturating_add(buf.len());
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
struct StoredMsg {
    msg: LogMsg,
    bytes: usize,
}

struct Inner {
    history: VecDeque<StoredMsg>,
    total_bytes: usize,
    replay_patches: Option<ReplayPatches>,
}

#[derive(Default)]
struct ReplayPatches {
    order: Vec<String>,
    by_path: HashMap<String, json_patch::Patch>,
}

impl ReplayPatches {
    fn apply(&mut self, patch: &json_patch::Patch) {
        for operation in &patch.0 {
            let path = operation.path().to_string();
            if matches!(operation, json_patch::PatchOperation::Remove(_)) {
                self.by_path.remove(&path);
                self.order.retain(|candidate| candidate != &path);
                continue;
            }

            if !self.by_path.contains_key(&path) {
                self.order.push(path.clone());
            }
            self.by_path
                .insert(path, json_patch::Patch(vec![operation.clone()]));
        }
    }

    fn snapshot(&self) -> Vec<json_patch::Patch> {
        self.order
            .iter()
            .filter_map(|path| self.by_path.get(path).cloned())
            .collect()
    }
}

pub struct MsgStore {
    inner: RwLock<Inner>,
    sender: broadcast::Sender<LogMsg>,
}

impl Default for MsgStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MsgStore {
    pub fn new() -> Self {
        Self::with_broadcast_capacity(BROADCAST_CAPACITY, false)
    }

    /// Historical normalization can produce thousands of cumulative replacement
    /// patches before a remote client can drain them. A small replay queue keeps
    /// those snapshots from retaining gigabytes while preserving recent state.
    pub fn new_for_replay() -> Self {
        Self::with_broadcast_capacity(REPLAY_BROADCAST_CAPACITY, true)
    }

    fn with_broadcast_capacity(capacity: usize, collect_replay_patches: bool) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self {
            inner: RwLock::new(Inner {
                history: VecDeque::with_capacity(32),
                total_bytes: 0,
                replay_patches: collect_replay_patches.then(ReplayPatches::default),
            }),
            sender,
        }
    }

    pub fn push(&self, msg: LogMsg) {
        let _ = self.sender.send(msg.clone()); // live listeners
        let bytes = msg.approx_bytes();

        let mut inner = self.inner.write().unwrap();
        if let (Some(replay_patches), LogMsg::JsonPatch(patch)) = (&mut inner.replay_patches, &msg)
        {
            replay_patches.apply(patch);
        }
        while inner.total_bytes.saturating_add(bytes) > HISTORY_BYTES {
            if let Some(front) = inner.history.pop_front() {
                inner.total_bytes = inner.total_bytes.saturating_sub(front.bytes);
            } else {
                break;
            }
        }
        inner.history.push_back(StoredMsg { msg, bytes });
        inner.total_bytes = inner.total_bytes.saturating_add(bytes);
    }

    // Convenience
    pub fn push_stdout<S: Into<String>>(&self, s: S) {
        self.push(LogMsg::Stdout(s.into()));
    }

    pub fn push_patch(&self, patch: json_patch::Patch) {
        self.push(LogMsg::JsonPatch(patch));
    }

    pub fn push_session_id(&self, session_id: String) {
        self.push(LogMsg::SessionId(session_id));
    }

    pub fn push_message_id(&self, id: String) {
        self.push(LogMsg::MessageId(id));
    }

    pub fn push_scheduled_resume(&self, crons_json: String) {
        self.push(LogMsg::ScheduledResume(crons_json));
    }

    pub fn push_finished(&self) {
        self.push(LogMsg::Finished);
    }

    pub fn get_receiver(&self) -> broadcast::Receiver<LogMsg> {
        self.sender.subscribe()
    }

    pub fn get_history(&self) -> Vec<LogMsg> {
        self.inner
            .read()
            .unwrap()
            .history
            .iter()
            .map(|s| s.msg.clone())
            .collect()
    }

    /// Return the losslessly coalesced final patch for every path produced by
    /// a historical replay. Intermediate replacements are discarded at push
    /// time, so memory is bounded by final conversation size rather than log
    /// volume and cannot lag behind a broadcast receiver.
    pub fn get_replay_patches(&self) -> Option<Vec<json_patch::Patch>> {
        self.inner
            .read()
            .unwrap()
            .replay_patches
            .as_ref()
            .map(ReplayPatches::snapshot)
    }

    /// History then live, as `LogMsg`.
    pub fn history_plus_stream(
        &self,
    ) -> futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>> {
        let (history, rx) = (self.get_history(), self.get_receiver());

        // Replaying buffered history is `Ready`-immediate: a plain
        // `stream::iter` never returns `Pending`, so a consumer that does
        // CPU-bound work per item (e.g. log normalization parsing tens of
        // thousands of lines) runs the whole replay without ever yielding to
        // the tokio scheduler, monopolizing its worker. With several replays in
        // flight the pool starves and the supervisor's `/api/health` probe
        // times out, tripping a restart loop. Cooperatively yield every so
        // often so co-located tasks stay schedulable. This covers every
        // downstream stream (stdout/stderr/lines) and executor uniformly.
        let hist = futures::stream::unfold(
            (history.into_iter(), 0usize),
            |(mut iter, count)| async move {
                let msg = iter.next()?;
                if count % 256 == 255 {
                    tokio::task::yield_now().await;
                }
                Some((Ok::<_, std::io::Error>(msg), (iter, count + 1)))
            },
        );
        let live = BroadcastStream::new(rx).filter_map(|res| async move {
            match res {
                Ok(msg) => Some(Ok(msg)),
                Err(BroadcastStreamRecvError::Lagged(n)) => {
                    tracing::error!(
                        skipped = n,
                        "MsgStore broadcast lagged. {n} messages dropped for this subscriber"
                    );
                    None
                }
            }
        });

        Box::pin(hist.chain(live))
    }

    pub fn stdout_chunked_stream(
        &self,
    ) -> futures::stream::BoxStream<'static, Result<String, std::io::Error>> {
        self.history_plus_stream()
            .take_while(|res| future::ready(!matches!(res, Ok(LogMsg::Finished))))
            .filter_map(|res| async move {
                match res {
                    Ok(LogMsg::Stdout(s)) => Some(Ok(s)),
                    _ => None,
                }
            })
            .boxed()
    }

    pub fn stdout_lines_stream(
        &self,
    ) -> futures::stream::BoxStream<'static, std::io::Result<String>> {
        self.stdout_chunked_stream().lines()
    }

    pub fn stderr_chunked_stream(
        &self,
    ) -> futures::stream::BoxStream<'static, Result<String, std::io::Error>> {
        self.history_plus_stream()
            .take_while(|res| future::ready(!matches!(res, Ok(LogMsg::Finished))))
            .filter_map(|res| async move {
                match res {
                    Ok(LogMsg::Stderr(s)) => Some(Ok(s)),
                    _ => None,
                }
            })
            .boxed()
    }

    /// Forward a stream of typed log messages into this store.
    pub fn spawn_forwarder<S, E>(self: Arc<Self>, stream: S) -> JoinHandle<()>
    where
        S: futures::Stream<Item = Result<LogMsg, E>> + Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        tokio::spawn(async move {
            tokio::pin!(stream);

            while let Some(next) = stream.next().await {
                match next {
                    Ok(msg) => self.push(msg),
                    Err(e) => self.push(LogMsg::Stderr(format!("stream error: {e}"))),
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use json_patch::{AddOperation, Patch, PatchOperation, ReplaceOperation};
    use serde_json::json;

    use super::MsgStore;
    use crate::log_msg::LogMsg;

    fn add(path: &str, value: usize) -> Patch {
        Patch(vec![PatchOperation::Add(AddOperation {
            path: path.parse().unwrap(),
            value: json!(value),
        })])
    }

    fn replace(path: &str, value: usize) -> Patch {
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: path.parse().unwrap(),
            value: json!(value),
        })])
    }

    #[test]
    fn replay_patch_collection_is_lossless_beyond_broadcast_capacity() {
        let store = MsgStore::new_for_replay();

        for index in 0..1_000 {
            store.push(LogMsg::JsonPatch(add(&format!("/entries/{index}"), index)));
        }

        let patches = store.get_replay_patches().unwrap();
        assert_eq!(patches.len(), 1_000);
        assert_eq!(patches.first(), Some(&add("/entries/0", 0)));
        assert_eq!(patches.last(), Some(&add("/entries/999", 999)));
    }

    #[test]
    fn replay_patch_collection_keeps_only_latest_value_per_path() {
        let store = MsgStore::new_for_replay();
        store.push(LogMsg::JsonPatch(add("/entries/7", 1)));

        for value in 2..1_000 {
            store.push(LogMsg::JsonPatch(replace("/entries/7", value)));
        }

        assert_eq!(
            store.get_replay_patches().unwrap(),
            vec![replace("/entries/7", 999)]
        );
    }
}
