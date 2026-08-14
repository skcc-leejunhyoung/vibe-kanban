use command_group::AsyncGroupChild;
#[cfg(unix)]
use tokio::time::Duration;

const PROCESS_EXIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

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
            if sig != Signal::SIGKILL {
                tokio::time::sleep(Duration::from_secs(2)).await;
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

#[cfg(all(test, unix))]
mod tests {
    use command_group::AsyncCommandGroup;
    use tokio::process::Command;

    use super::*;

    #[tokio::test]
    async fn process_group_shutdown_is_bounded() {
        let mut child = Command::new("sh")
            .args(["-c", "sleep 60"])
            .group_spawn()
            .unwrap();

        tokio::time::timeout(Duration::from_secs(15), kill_process_group(&mut child))
            .await
            .unwrap()
            .unwrap();
    }
}
