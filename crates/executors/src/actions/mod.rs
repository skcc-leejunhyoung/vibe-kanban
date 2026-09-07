use std::{path::Path, sync::Arc};

use async_trait::async_trait;
use enum_dispatch::enum_dispatch;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    actions::{
        coding_agent_follow_up::CodingAgentFollowUpRequest,
        coding_agent_initial::CodingAgentInitialRequest, review::ReviewRequest,
        script::ScriptRequest,
    },
    approvals::ExecutorApprovalService,
    env::ExecutionEnv,
    executors::{
        BaseCodingAgent, ExecutorError, SpawnedChild,
        utils::{SlashCommandCall, parse_slash_command},
    },
};
pub mod coding_agent_follow_up;
pub mod coding_agent_initial;
pub mod review;
pub mod script;

pub use review::RepoReviewContext;

#[enum_dispatch]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "type")]
pub enum ExecutorActionType {
    CodingAgentInitialRequest,
    CodingAgentFollowUpRequest,
    ScriptRequest,
    ReviewRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ExecutorAction {
    pub typ: ExecutorActionType,
    pub next_action: Option<Box<ExecutorAction>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(skip)]
    pub automation_origin: Option<AutomationOrigin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AutomationOrigin {
    pub routine_id: String,
    pub routine_chain: Vec<String>,
}

impl ExecutorAction {
    pub fn new(typ: ExecutorActionType, next_action: Option<Box<ExecutorAction>>) -> Self {
        Self {
            typ,
            next_action,
            automation_origin: None,
        }
    }

    pub fn with_automation_origin(mut self, origin: Option<AutomationOrigin>) -> Self {
        self.automation_origin = origin.clone();
        if let Some(next) = self.next_action {
            self.next_action = Some(Box::new(next.with_automation_origin(origin)));
        }
        self
    }
    pub fn append_action(mut self, action: ExecutorAction) -> Self {
        if let Some(next) = self.next_action {
            self.next_action = Some(Box::new(next.append_action(action)));
        } else {
            self.next_action = Some(Box::new(action));
        }
        self
    }

    pub fn typ(&self) -> &ExecutorActionType {
        &self.typ
    }

    pub fn next_action(&self) -> Option<&ExecutorAction> {
        self.next_action.as_deref()
    }

    pub fn base_executor(&self) -> Option<BaseCodingAgent> {
        match self.typ() {
            ExecutorActionType::CodingAgentInitialRequest(request) => Some(request.base_executor()),
            ExecutorActionType::CodingAgentFollowUpRequest(request) => {
                Some(request.base_executor())
            }
            ExecutorActionType::ReviewRequest(request) => Some(request.base_executor()),
            ExecutorActionType::ScriptRequest(_) => None,
        }
    }
}

#[async_trait]
#[enum_dispatch(ExecutorActionType)]
pub trait Executable {
    async fn spawn(
        &self,
        current_dir: &Path,
        approvals: Arc<dyn ExecutorApprovalService>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError>;
}

#[async_trait]
impl Executable for ExecutorAction {
    async fn spawn(
        &self,
        current_dir: &Path,
        approvals: Arc<dyn ExecutorApprovalService>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        // Keep transport instructions out of the persisted user prompt. Apply
        // them to initial, resumed and review requests through the same path.
        let mut action = self.typ.clone();
        let prompt = match &mut action {
            ExecutorActionType::CodingAgentInitialRequest(request) => &mut request.prompt,
            ExecutorActionType::CodingAgentFollowUpRequest(request) => &mut request.prompt,
            ExecutorActionType::ReviewRequest(request) => &mut request.prompt,
            ExecutorActionType::ScriptRequest(_) => {
                return action.spawn(current_dir, approvals, env).await;
            }
        };
        append_artifact_instructions(prompt);
        action.spawn(current_dir, approvals, env).await
    }
}

fn append_artifact_instructions(prompt: &mut String) {
    // Native slash commands must keep their exact arguments (for example /fast off).
    if parse_slash_command::<SlashCommandCall<'_>>(prompt).is_some() {
        return;
    }
    prompt.push_str(
            "\n\n[Artifacts]\n\
             Only attach deliverables you intentionally want the user to preview or download. \
             On its own line, use [Title](relative/path \"vibe-artifact\"). \
             Paths are relative to your working directory and must remain inside the workspace. \
             For inline HTML, SVG or Mermaid, add vibe-artifact after the code fence language \
             (for example: ```mermaid vibe-artifact). \
             Ordinary file reads, edits, build outputs, links and unmarked code blocks are not attachments. \
             Do not attach source citations or intermediate files unless requested. \
             When delegating deliverables, pass this attachment convention to the subagent.",
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::script::{ScriptContext, ScriptRequest, ScriptRequestLanguage};

    #[test]
    fn artifact_instructions_preserve_native_commands_and_explain_explicit_attachments() {
        for command in ["/fast off", "/compact", "/custom argument"] {
            let mut prompt = command.to_string();
            append_artifact_instructions(&mut prompt);
            assert_eq!(prompt, command);
        }
        let mut prompt = "Create a report".to_string();
        append_artifact_instructions(&mut prompt);
        assert!(prompt.starts_with("Create a report\n\n[Artifacts]"));
        assert!(prompt.contains("[Title](relative/path \"vibe-artifact\")"));
        assert!(prompt.contains("```mermaid vibe-artifact"));
    }

    fn script_action(next_action: Option<Box<ExecutorAction>>) -> ExecutorAction {
        ExecutorAction::new(
            ExecutorActionType::ScriptRequest(ScriptRequest {
                script: "true".to_string(),
                language: ScriptRequestLanguage::Bash,
                context: ScriptContext::SetupScript,
                working_dir: None,
            }),
            next_action,
        )
    }

    #[test]
    fn automation_origin_is_applied_to_the_full_action_chain() {
        let origin = AutomationOrigin {
            routine_id: "routine-child".to_string(),
            routine_chain: vec!["routine-parent".to_string(), "routine-child".to_string()],
        };
        let action = script_action(Some(Box::new(script_action(None))))
            .with_automation_origin(Some(origin.clone()));

        assert_eq!(action.automation_origin, Some(origin.clone()));
        assert_eq!(
            action
                .next_action()
                .and_then(|next| next.automation_origin.clone()),
            Some(origin)
        );
    }
}
