use std::sync::Arc;

use codex_app_server_protocol::{ReviewTarget, ThreadStartParams};

use super::{client::AppServerClient, continue_thread};
use crate::executors::ExecutorError;

pub async fn launch_codex_review(
    thread_start_params: ThreadStartParams,
    resume_session: Option<String>,
    discard_from_turn: Option<String>,
    review_target: ReviewTarget,
    client: Arc<AppServerClient>,
) -> Result<(), ExecutorError> {
    let account = client.get_account().await?;
    if account.requires_openai_auth && account.account.is_none() {
        return Err(ExecutorError::AuthRequired(
            "Codex authentication required".to_string(),
        ));
    }

    let thread_id = match resume_session {
        Some(session_id) => {
            continue_thread(&client, session_id, discard_from_turn, thread_start_params)
                .await?
                .0
        }
        None => {
            let response = client.thread_start(thread_start_params).await?;
            response.thread.id
        }
    };

    client.register_session(&thread_id).await?;
    client.start_review(thread_id, review_target).await?;

    Ok(())
}
