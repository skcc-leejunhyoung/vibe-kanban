use std::{
    collections::{HashMap, VecDeque},
    io::{self, Write},
    sync::{Arc, RwLock, Weak},
    time::{Duration, Instant},
};

use futures::{StreamExt, future};
use tokio::{
    sync::broadcast::{self, error::RecvError},
    task::JoinHandle,
};

use crate::{log_msg::LogMsg, stream_lines::LinesStreamExt};

// 100 MB Limit
const HISTORY_BYTES: usize = 100000 * 1024;
const BROADCAST_CAPACITY: usize = 1024;
const REPLAY_BROADCAST_CAPACITY: usize = 256;
/// A lagging subscriber logs at most once per this interval.
const LAG_LOG_INTERVAL: Duration = Duration::from_secs(1);
/// Messages re-read from history per step while healing a lagged span. History
/// holds up to `HISTORY_BYTES`, so recovering a whole span at once would clone
/// that much per lagging subscriber; stepping keeps the copy bounded.
const RECOVERY_CHUNK: u64 = 256;
/// Byte ceiling for one recovery step. A count alone is not a bound: 256 large
/// messages still clone far more than 256 log lines, so a chunk stops at
/// whichever limit it hits first (always yielding at least one message).
const RECOVERY_CHUNK_BYTES: usize = 1024 * 1024;

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
    /// Messages evicted from the front of `history`; `evicted + index` is a
    /// message's absolute position, stable for the store's lifetime.
    evicted: u64,
    replay_patches: Option<ReplayPatches>,
}

impl Inner {
    /// Clone up to `count` messages starting at absolute position `start`,
    /// stopping early once `max_bytes` is exceeded (the first message always
    /// comes through). `None` when any of the `count` has already been evicted
    /// (or was never pushed).
    fn range(&self, start: u64, count: u64, max_bytes: usize) -> Option<Vec<LogMsg>> {
        let offset = usize::try_from(start.checked_sub(self.evicted)?).ok()?;
        let end = offset.checked_add(usize::try_from(count).ok()?)?;
        (end <= self.history.len()).then(|| {
            let mut bytes = 0usize;
            self.history
                .range(offset..end)
                .take_while(|s| {
                    let first = bytes == 0;
                    bytes = bytes.saturating_add(s.bytes);
                    first || bytes <= max_bytes
                })
                .map(|s| s.msg.clone())
                .collect()
        })
    }
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

/// Live half of `history_plus_stream`: tracks the absolute position of the next
/// expected message so a broadcast lag can be healed from history.
struct LiveSubscriber {
    rx: broadcast::Receiver<LogMsg>,
    /// Absolute position the broadcast receiver will yield next.
    next: u64,
    /// Not-yet-replayed remainder of a lagged span, `[gap, gap_end)`.
    gap: u64,
    gap_end: u64,
    inner: Weak<RwLock<Inner>>,
    buffered: VecDeque<LogMsg>,
    last_log: Option<Instant>,
    suppressed_logs: u64,
}

impl LiveSubscriber {
    async fn next(&mut self) -> Option<Result<LogMsg, io::Error>> {
        loop {
            if let Some(msg) = self.buffered.pop_front() {
                return Some(Ok(msg));
            }
            if self.gap < self.gap_end {
                return Some(self.replay_gap_chunk());
            }
            match self.rx.recv().await {
                Ok(msg) => {
                    self.next += 1;
                    return Some(Ok(msg));
                }
                Err(RecvError::Closed) => return None,
                Err(RecvError::Lagged(skipped)) => {
                    // The receiver now sits at the oldest retained message, so
                    // the gap is exactly [next, next + skipped). Replaying it
                    // may lag again; the next gap starts where this one ends.
                    self.gap = self.next;
                    self.gap_end = self.next + skipped;
                    self.next += skipped;
                    if self.should_log() {
                        tracing::warn!(
                            skipped,
                            suppressed = self.suppressed_logs,
                            "MsgStore broadcast lagged; replaying {skipped} messages from history"
                        );
                        self.suppressed_logs = 0;
                    }
                }
            }
        }
    }

    /// Buffer the next slice of the pending gap, returning its first message.
    /// A slice the history no longer holds ends the replay with an error, so
    /// the consumer can resynchronize instead of applying a patch stream with
    /// a hole in it.
    fn replay_gap_chunk(&mut self) -> Result<LogMsg, io::Error> {
        let count = RECOVERY_CHUNK.min(self.gap_end - self.gap);
        let replayed = self.inner.upgrade().and_then(|inner| {
            inner
                .read()
                .unwrap()
                .range(self.gap, count, RECOVERY_CHUNK_BYTES)
        });
        match replayed {
            Some(msgs) => {
                // The byte ceiling can cut the chunk short; advance by what was
                // actually replayed so the rest of the gap is retried.
                self.gap += msgs.len() as u64;
                self.buffered.extend(msgs);
                // `range` yields at least one message for `count >= 1`.
                Ok(self.buffered.pop_front().expect("replayed chunk is empty"))
            }
            None => {
                let lost = self.gap_end - self.gap;
                self.gap = self.gap_end;
                if self.should_log() {
                    tracing::error!(
                        lost,
                        suppressed = self.suppressed_logs,
                        "MsgStore broadcast lagged beyond retained history; {lost} messages lost for this subscriber"
                    );
                    self.suppressed_logs = 0;
                }
                Err(io::Error::other(format!(
                    "MsgStore broadcast lagged by {lost} messages beyond retained history"
                )))
            }
        }
    }

    fn should_log(&mut self) -> bool {
        if self
            .last_log
            .is_some_and(|last| last.elapsed() < LAG_LOG_INTERVAL)
        {
            self.suppressed_logs += 1;
            return false;
        }
        self.last_log = Some(Instant::now());
        true
    }
}

pub struct MsgStore {
    inner: Arc<RwLock<Inner>>,
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
            inner: Arc::new(RwLock::new(Inner {
                history: VecDeque::with_capacity(32),
                total_bytes: 0,
                evicted: 0,
                replay_patches: collect_replay_patches.then(ReplayPatches::default),
            })),
            sender,
        }
    }

    pub fn push(&self, msg: LogMsg) {
        let bytes = msg.approx_bytes();

        let mut inner = self.inner.write().unwrap();
        // Broadcast under the lock so history order equals broadcast order and
        // a subscriber snapshotting history sees each message exactly once.
        let _ = self.sender.send(msg.clone()); // live listeners
        if let (Some(replay_patches), LogMsg::JsonPatch(patch)) = (&mut inner.replay_patches, &msg)
        {
            replay_patches.apply(patch);
        }
        while inner.total_bytes.saturating_add(bytes) > HISTORY_BYTES {
            if let Some(front) = inner.history.pop_front() {
                inner.total_bytes = inner.total_bytes.saturating_sub(front.bytes);
                inner.evicted += 1;
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

    /// Read borrowed messages while holding the history read lock. Keep the
    /// callback short; it must not block or call back into this store.
    pub fn with_history<T>(
        &self,
        read: impl FnOnce(&mut dyn DoubleEndedIterator<Item = &LogMsg>) -> T,
    ) -> T {
        let inner = self.inner.read().unwrap();
        read(&mut inner.history.iter().map(|entry| &entry.msg))
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

    /// History then live, as `LogMsg`. Lossless: a subscriber that falls more
    /// than the broadcast capacity behind gets the skipped span re-read from
    /// history instead of a silent gap; only a span already evicted from
    /// history surfaces as an `Err`, so consumers can resynchronize.
    pub fn history_plus_stream(
        &self,
    ) -> futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>> {
        // Subscribe and snapshot under one read lock: `push` broadcasts while
        // holding the write lock, so no message lands in both or neither.
        let (history, live) = {
            let inner = self.inner.read().unwrap();
            let rx = self.sender.subscribe();
            let history: Vec<LogMsg> = inner.history.iter().map(|s| s.msg.clone()).collect();
            let next = inner.evicted + history.len() as u64;
            let live = LiveSubscriber {
                rx,
                next,
                gap: next,
                gap_end: next,
                inner: Arc::downgrade(&self.inner),
                buffered: VecDeque::new(),
                last_log: None,
                suppressed_logs: 0,
            };
            (history, live)
        };

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
        let live = futures::stream::unfold(live, |mut sub| async move {
            sub.next().await.map(|item| (item, sub))
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
    use futures::StreamExt;
    use json_patch::{AddOperation, Patch, PatchOperation, ReplaceOperation};
    use serde_json::json;

    use super::{HISTORY_BYTES, MsgStore};
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

    /// A subscriber parked while the producer bursts far past the broadcast
    /// capacity must still observe every message, in order, without errors.
    #[tokio::test]
    async fn parked_subscriber_recovers_lagged_span_from_history() {
        let store = MsgStore::new();
        let mut stream = store.history_plus_stream();
        const BURST: usize = 5_000;
        for index in 0..BURST {
            store.push_stdout(index.to_string());
        }

        for expected in 0..BURST {
            match stream.next().await {
                Some(Ok(LogMsg::Stdout(content))) => assert_eq!(content, expected.to_string()),
                other => panic!("message {expected}: unexpected {other:?}"),
            }
        }
        // Nothing else is pending; the live half must not have duplicated.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), stream.next())
                .await
                .is_err()
        );
    }

    /// Once the skipped span has been evicted from history the gap is
    /// unrecoverable and must surface as an error, then the stream continues
    /// with the messages the channel still retains.
    #[tokio::test]
    async fn lag_beyond_evicted_history_surfaces_an_error() {
        let store = MsgStore::with_broadcast_capacity(8, false);
        let mut stream = store.history_plus_stream();
        let chunk = "x".repeat(1024 * 1024);
        let pushed = HISTORY_BYTES / chunk.len() + 10;
        for _ in 0..pushed {
            store.push_stdout(chunk.clone());
        }
        assert!(store.inner.read().unwrap().evicted > 0);

        assert!(matches!(stream.next().await, Some(Err(_))));
        for _ in 0..8 {
            assert!(matches!(stream.next().await, Some(Ok(LogMsg::Stdout(_)))));
        }
    }

    /// The subscription snapshot and the live receiver must not overlap or
    /// leave a hole around messages pushed concurrently with subscribing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_subscribe_sees_each_message_exactly_once() {
        let store = std::sync::Arc::new(MsgStore::new());
        const TOTAL: usize = 20_000;
        let producer = {
            let store = store.clone();
            tokio::task::spawn_blocking(move || {
                for index in 0..TOTAL {
                    store.push_stdout(index.to_string());
                }
                store.push_finished();
            })
        };
        let mut streams = Vec::new();
        for _ in 0..16 {
            streams.push(store.history_plus_stream());
            std::thread::sleep(std::time::Duration::from_micros(200));
        }
        producer.await.unwrap();

        for mut stream in streams {
            let mut expected = 0usize;
            while let Some(item) = stream.next().await {
                match item.unwrap() {
                    LogMsg::Stdout(content) => {
                        assert_eq!(content, expected.to_string());
                        expected += 1;
                    }
                    LogMsg::Finished => break,
                    other => panic!("unexpected {other:?}"),
                }
            }
            assert_eq!(expected, TOTAL);
        }
    }
}
