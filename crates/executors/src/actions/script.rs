use std::{path::Path, sync::Arc};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use ts_rs::TS;
use workspace_utils::{command_ext::GroupSpawnNoWindowExt, shell::get_shell_command};

use crate::{
    actions::Executable,
    approvals::ExecutorApprovalService,
    env::ExecutionEnv,
    executors::{ExecutorError, SpawnedChild},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub enum ScriptRequestLanguage {
    Bash,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub enum ScriptContext {
    SetupScript,
    CleanupScript,
    ArchiveScript,
    DevServer,
    ToolInstallScript,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct ScriptRequest {
    pub script: String,
    pub language: ScriptRequestLanguage,
    pub context: ScriptContext,
    /// Optional relative path to execute the script in (relative to container_ref).
    /// If None, uses the container_ref directory directly.
    #[serde(default)]
    pub working_dir: Option<String>,
}

#[async_trait]
impl Executable for ScriptRequest {
    async fn spawn(
        &self,
        current_dir: &Path,
        _approvals: Arc<dyn ExecutorApprovalService>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        // Use working_dir if specified, otherwise use current_dir
        let effective_dir = match &self.working_dir {
            Some(rel_path) => current_dir.join(rel_path),
            None => current_dir.to_path_buf(),
        };

        let (shell_cmd, shell_arg) = get_shell_command();
        let mut command = self.command_with_resource_policy(&shell_cmd);
        command
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .arg(shell_arg)
            .arg(&self.script)
            .current_dir(&effective_dir);

        // Apply environment variables
        env.apply_to_command(&mut command);

        let child = command.group_spawn_no_window()?;

        Ok(child.into())
    }
}

impl ScriptRequest {
    fn command_with_resource_policy(&self, shell_cmd: &str) -> Command {
        if !matches!(
            self.context,
            ScriptContext::SetupScript | ScriptContext::CleanupScript
        ) {
            return Command::new(shell_cmd);
        }

        #[cfg(target_os = "macos")]
        {
            let mut command = Command::new("/usr/bin/nice");
            command
                .args(["-n", "19", "/usr/sbin/taskpolicy", "-b"])
                .arg(shell_cmd);
            command
        }

        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let mut command = Command::new("nice");
            command.args(["-n", "19"]).arg(shell_cmd);
            command
        }

        #[cfg(windows)]
        Command::new(shell_cmd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(context: ScriptContext) -> ScriptRequest {
        ScriptRequest {
            script: "true".to_string(),
            language: ScriptRequestLanguage::Bash,
            context,
            working_dir: None,
        }
    }

    #[test]
    fn dev_server_uses_shell_directly() {
        let command = request(ScriptContext::DevServer).command_with_resource_policy("test-shell");

        assert_eq!(command.as_std().get_program(), "test-shell");
        assert_eq!(command.as_std().get_args().count(), 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn setup_and_cleanup_use_macos_background_policy() {
        for context in [ScriptContext::SetupScript, ScriptContext::CleanupScript] {
            let command = request(context).command_with_resource_policy("test-shell");
            let args: Vec<_> = command.as_std().get_args().collect();

            assert_eq!(command.as_std().get_program(), "/usr/bin/nice");
            assert_eq!(
                args,
                ["-n", "19", "/usr/sbin/taskpolicy", "-b", "test-shell"]
            );
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn setup_and_cleanup_use_unix_nice() {
        for context in [ScriptContext::SetupScript, ScriptContext::CleanupScript] {
            let command = request(context).command_with_resource_policy("test-shell");
            let args: Vec<_> = command.as_std().get_args().collect();

            assert_eq!(command.as_std().get_program(), "nice");
            assert_eq!(args, ["-n", "19", "test-shell"]);
        }
    }
}
