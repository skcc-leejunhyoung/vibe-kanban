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
        let mut env = env.clone();
        apply_artifact_instructions(&mut action, &mut env);
        action.spawn(current_dir, approvals, &env).await
    }
}

/// Claude appends these to its system prompt and Codex sends them as developer
/// instructions, so each session holds one copy that survives compaction. The
/// prompt then carries only a one-line reminder: without it Sonnet ignored the
/// system copy in every trial (Opus and Codex followed it either way). Other
/// executors, and Codex reviews (their turns drop developer instructions),
/// receive the full rules at the end of every prompt.
fn apply_artifact_instructions(action: &mut ExecutorActionType, env: &mut ExecutionEnv) {
    let system_channel = match action {
        ExecutorActionType::ReviewRequest(request) => {
            request.base_executor() == BaseCodingAgent::ClaudeCode
        }
        ExecutorActionType::CodingAgentInitialRequest(request) => matches!(
            request.base_executor(),
            BaseCodingAgent::ClaudeCode | BaseCodingAgent::Codex
        ),
        ExecutorActionType::CodingAgentFollowUpRequest(request) => matches!(
            request.base_executor(),
            BaseCodingAgent::ClaudeCode | BaseCodingAgent::Codex
        ),
        ExecutorActionType::ScriptRequest(_) => return,
    };
    let suffix = if system_channel {
        // Native commands still get the rules, so a compaction reinjects them.
        env.system_instructions = Some(ARTIFACT_INSTRUCTIONS.to_string());
        ARTIFACT_REMINDER
    } else {
        ARTIFACT_INSTRUCTIONS
    };
    let prompt = match action {
        ExecutorActionType::CodingAgentInitialRequest(request) => &mut request.prompt,
        ExecutorActionType::CodingAgentFollowUpRequest(request) => &mut request.prompt,
        ExecutorActionType::ReviewRequest(request) => &mut request.prompt,
        ExecutorActionType::ScriptRequest(_) => return,
    };
    append_artifact_instructions(prompt, suffix);
}

fn append_artifact_instructions(prompt: &mut String, suffix: &str) {
    // Native slash commands must keep their exact arguments (for example /fast off).
    if parse_slash_command::<SlashCommandCall<'_>>(prompt).is_some() {
        return;
    }
    prompt.push_str("\n\n");
    prompt.push_str(suffix);
}

const ARTIFACT_REMINDER: &str = "[Artifacts] Attach each deliverable on its own line as \
     [Title](relative/path \"vibe-artifact\"). The full artifact rules are in your instructions.";

const ARTIFACT_INSTRUCTIONS: &str = "[Artifacts]\n\
             Only attach deliverables you intentionally want the user to preview or download. \
             On its own line, use [Title](relative/path \"vibe-artifact\"). \
             Paths are relative to your working directory and must remain inside the workspace. \
             For inline HTML, SVG or Mermaid, add vibe-artifact after the code fence language \
             (for example: ```mermaid vibe-artifact). \
             Vibe renders attached HTML directly in an interactive, sandboxed chat preview, \
             including its CSS and JavaScript. Attached PDF and Office documents (docx, xlsx, pptx) \
             also render as inline previews. The preview appears in place of the attachment line, \
             so attach each deliverable in the message where you present it, as soon as it is complete. \
             When asked to create or render HTML, SVG or Mermaid, \
             attach that deliverable as the primary result. Screenshots can help verify your work; \
             use them as the deliverable when the user requests an image. \
             Save the final HTML inside the workspace, or attach a complete inline HTML document. \
             Prefer self-contained HTML; preview blocks external network requests and cannot run server code. \
             Ordinary file reads, edits, build outputs, links and unmarked code blocks are not attachments. \
             Do not attach source citations or intermediate files unless requested. \
             When delegating deliverables, pass this attachment convention to the subagent.";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::script::{ScriptContext, ScriptRequest, ScriptRequestLanguage};

    #[test]
    fn artifact_instructions_preserve_native_commands_and_explain_explicit_attachments() {
        for command in ["/fast off", "/compact", "/custom argument"] {
            let mut prompt = command.to_string();
            append_artifact_instructions(&mut prompt, ARTIFACT_INSTRUCTIONS);
            assert_eq!(prompt, command);
        }
        let mut prompt = "Create a report".to_string();
        append_artifact_instructions(&mut prompt, ARTIFACT_INSTRUCTIONS);
        assert!(prompt.starts_with("Create a report\n\n[Artifacts]"));
        assert!(prompt.contains("[Title](relative/path \"vibe-artifact\")"));
        assert!(prompt.contains("```mermaid vibe-artifact"));
        assert!(prompt.contains("create or render HTML, SVG or Mermaid"));
    }

    #[test]
    fn artifact_instructions_use_the_system_channel_where_one_survives() {
        use crate::{
            actions::coding_agent_follow_up::CodingAgentFollowUpRequest, profile::ExecutorConfig,
        };
        let initial = |executor| {
            ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
                prompt: "Create a report".into(),
                executor_config: ExecutorConfig::new(executor),
                working_dir: None,
                handoff_from: None,
                handoff_session_id: None,
                handoff_user_prompt: None,
            })
        };
        let review = |executor| {
            ExecutorActionType::ReviewRequest(ReviewRequest {
                executor_config: ExecutorConfig::new(executor),
                context: None,
                prompt: "Review".into(),
                session_id: None,
                working_dir: None,
            })
        };
        let prompt = |action: &ExecutorActionType| match action {
            ExecutorActionType::CodingAgentInitialRequest(r) => r.prompt.clone(),
            ExecutorActionType::CodingAgentFollowUpRequest(r) => r.prompt.clone(),
            ExecutorActionType::ReviewRequest(r) => r.prompt.clone(),
            ExecutorActionType::ScriptRequest(_) => String::new(),
        };
        let apply = |mut action: ExecutorActionType| {
            let mut env = ExecutionEnv::new(Default::default(), false, String::new());
            apply_artifact_instructions(&mut action, &mut env);
            (prompt(&action), env.system_instructions)
        };
        let follow_up = ExecutorActionType::CodingAgentFollowUpRequest(
            serde_json::from_value::<CodingAgentFollowUpRequest>(serde_json::json!({
                "prompt": "/compact",
                "session_id": "s",
                "executor_config": { "executor": "CODEX" },
            }))
            .unwrap(),
        );
        for action in [
            initial(BaseCodingAgent::ClaudeCode),
            initial(BaseCodingAgent::Codex),
            review(BaseCodingAgent::ClaudeCode),
        ] {
            let before = prompt(&action);
            let (after, system) = apply(action);
            assert_eq!(after, format!("{before}\n\n{ARTIFACT_REMINDER}"));
            assert_eq!(system.as_deref(), Some(ARTIFACT_INSTRUCTIONS));
        }
        // Native commands keep their exact text but still carry the rules, so
        // a compaction reinjects them.
        let (after, system) = apply(follow_up);
        assert_eq!(after, "/compact");
        assert_eq!(system.as_deref(), Some(ARTIFACT_INSTRUCTIONS));
        for action in [
            initial(BaseCodingAgent::Gemini),
            review(BaseCodingAgent::Codex),
        ] {
            let (after, system) = apply(action);
            assert!(after.ends_with(ARTIFACT_INSTRUCTIONS));
            assert_eq!(system, None);
        }
    }

    #[test]
    fn system_instructions_follow_the_executor_own() {
        let mut env = ExecutionEnv::new(Default::default(), false, String::new());
        assert_eq!(
            env.with_system_instructions(Some("own")).as_deref(),
            Some("own")
        );
        assert_eq!(env.with_system_instructions(None), None);
        env.system_instructions = Some("rules".into());
        assert_eq!(
            env.with_system_instructions(Some("own")).as_deref(),
            Some("own\n\nrules")
        );
        assert_eq!(
            env.with_system_instructions(Some(" ")).as_deref(),
            Some("rules")
        );
        assert_eq!(env.with_system_instructions(None).as_deref(), Some("rules"));
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
