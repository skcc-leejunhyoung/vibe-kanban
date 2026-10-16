use command_group::AsyncGroupChild;
#[cfg(unix)]
use tokio::time::Duration;

const PROCESS_EXIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// How long SIGINT, then SIGTERM, get to take effect before escalating.
#[cfg(unix)]
const SIGNAL_GRACE: Duration = Duration::from_secs(2);

pub async fn kill_process_group(child: &mut AsyncGroupChild) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        // Use command_group's UnixChildExt::signal() which calls killpg()
        // with the pgid captured at spawn time. This works even after the
        // group leader has exited, unlike getpgid() which would fail.
        use command_group::{Signal, UnixChildExt};

        for sig in [Signal::SIGINT, Signal::SIGTERM, Signal::SIGKILL] {
            tracing::info!("Sending {:?} to process group", sig);
            if let Err(e) = child.signal(sig) {
                // break if the group does not exist anymore
                if e.raw_os_error() == Some(nix::libc::ESRCH) {
                    break;
                }
                tracing::warn!("Failed to send signal {:?} to process group: {}", sig, e);
            }
            // Escalate only while the leader is still alive: a process that
            // honours the signal is gone in milliseconds, not after a fixed
            // sleep.
            if sig != Signal::SIGKILL && wait_for_exit(child, SIGNAL_GRACE).await {
                break;
            }
        }
    }

    let group_kill_error = child.start_kill().err();
    if group_kill_error.is_some() {
        let _ = child.inner().start_kill();
    }
    match tokio::time::timeout(PROCESS_EXIT_TIMEOUT, child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(group_kill_error.unwrap_or(error)),
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "process group did not exit within 10 seconds",
        )),
    }
}

/// Polls the group leader for up to `grace`; true once it has exited (or can
/// no longer be waited on). `try_wait` caches the status on the child, so the
/// exit watcher and the final `wait` above still observe it.
#[cfg(unix)]
async fn wait_for_exit(child: &mut AsyncGroupChild, grace: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + grace;
    loop {
        if !matches!(child.try_wait(), Ok(None)) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Instant;

    use command_group::AsyncCommandGroup;
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, BufReader},
        process::Command,
    };

    use super::*;

    #[tokio::test]
    async fn cooperative_process_group_exits_without_the_fixed_grace_sleeps() {
        let mut child = Command::new("sh")
            .args(["-c", "sleep 60"])
            .group_spawn()
            .unwrap();

        let started = Instant::now();
        kill_process_group(&mut child).await.unwrap();
        // SIGINT alone ends `sleep`; the fixed grace used to add 2s here.
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "took {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn process_group_shutdown_is_bounded() {
        // Ignores INT and TERM, so only the SIGKILL escalation ends it. The
        // "ready" line makes sure the trap is installed before the signals.
        let mut child = Command::new("sh")
            .args(["-c", "trap '' INT TERM; echo ready; sleep 60"])
            .stdout(std::process::Stdio::piped())
            .group_spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.inner().stdout.take().unwrap())
            .read_line(&mut ready)
            .await
            .unwrap();
        assert_eq!(ready.trim(), "ready");

        let started = Instant::now();
        tokio::time::timeout(Duration::from_secs(15), kill_process_group(&mut child))
            .await
            .unwrap()
            .unwrap();
        // Both grace periods were waited out before SIGKILL.
        assert!(
            started.elapsed() >= SIGNAL_GRACE * 2,
            "took {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn shutdown_kills_descendants_after_the_group_leader_exits() {
        let mut child = Command::new("sh")
            .args([
                "-c",
                "sh -c 'trap \"\" INT TERM; echo ready; exec sleep 60' &",
            ])
            .stdout(std::process::Stdio::piped())
            .group_spawn()
            .unwrap();
        let mut output = BufReader::new(child.inner().stdout.take().unwrap());
        let mut ready = String::new();
        tokio::time::timeout(Duration::from_secs(2), output.read_line(&mut ready))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready.trim(), "ready");
        assert!(wait_for_exit(&mut child, Duration::from_secs(2)).await);

        let started = Instant::now();
        kill_process_group(&mut child).await.unwrap();
        // A surviving descendant would keep the inherited stdout pipe open.
        tokio::time::timeout(Duration::from_secs(2), output.read_to_end(&mut Vec::new()))
            .await
            .unwrap()
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
