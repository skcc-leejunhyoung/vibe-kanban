//! Fully-automated workflow for issues carrying the `vibe` tag.
//!
//! This module is split into a **functional core** (pure decision logic, this
//! file) and an **imperative shell** (the `LocalContainerService` methods that
//! fetch state and perform side effects). Keeping the decision logic pure makes
//! every branch of the five workflow rules exhaustively unit-testable without a
//! database, remote client, or git worktree.
//!
//! The workflow, driven entirely off a per-workspace [`VibePhase`] plus a
//! per-turn agent self-report ([`VibeResult`], parsed from a `VIBE_RESULT:`
//! sentinel line in the agent's final message):
//!
//! ```text
//! CODING  ──done──►  REVIEW  ──approve──►  MERGING ──success──► (issue → In review)
//!   │ continue ↺        │ continue ↺          │ conflict ↺ (resolve in session)
//!   │ blocked           │ blocked             │ exceeded
//!   └──────────────► BLOCKED ◄────────────────┘
//! ```
//!
//! Script failures are handled independently of phase: a failed **cleanup**
//! script asks the same session to fix it (with the failure log pasted in); a
//! failed **setup** script does nothing and leaves the issue In progress.

use db::models::execution_process::{ExecutionProcessRunReason, ExecutionProcessStatus};
use utils::log_msg::LogMsg;

/// The four cloud tags this workflow keys off of. `vibe` is applied by the
/// external orchestrator to opt an issue into the workflow; the other three are
/// applied by the backend to mirror [`VibePhase`] for human visibility.
pub const TAG_VIBE: &str = "vibe";
pub const TAG_DONE: &str = "vibe-done";
pub const TAG_BLOCK: &str = "vibe-block";
pub const TAG_APPROVE: &str = "vibe-approve";

/// The marker line the coding/review agent is instructed to emit as the last
/// line of its turn so the backend can drive the state machine.
pub const SENTINEL: &str = "VIBE_RESULT:";

/// Instruction appended to every **coding** turn (initial + continue + cleanup
/// fix). Tells the agent to self-drive and emit the `VIBE_RESULT:` sentinel.
pub const PREAMBLE_CODING: &str = "\n\n---\n[자동 워크플로우 지침]\n\
- 진행 중 사용자에게 선택지를 묻지 말고, 항상 가장 합리적인 추천 방향으로 스스로 결정해 진행해라.\n\
- 이 턴의 마지막 메시지는 그대로 git 커밋 메시지로 사용된다. 그러니 마지막 메시지는 `type(scope): 요약` 한 줄 제목 + (필요하면) 빈 줄 뒤 짧은 본문 형태의 커밋 메시지로 작성해라. 마크다운 헤더(##)·체크리스트·이모지·파일 나열·장문 보고는 넣지 마라. 사용자에게 길게 설명할 내용이 있으면 이 마지막 턴이 아니라 그 전 턴에 남겨라.\n\
- 이 턴을 마칠 때 반드시 위 커밋 메시지 다음, 메시지의 마지막 줄에 다음 중 하나만 정확히 출력해라:\n\
  - 이 이슈의 모든 작업을 완결적으로 끝냈으면: `VIBE_RESULT: done`\n\
  - 추천대로 모두 진행해도 더 이상 불가능하면: `VIBE_RESULT: blocked`\n\
  - 아직 끝나지 않은 작업이 남았으면: `VIBE_RESULT: continue`";

/// Instruction appended to every **review** turn (review A/B + conflict + a
/// cleanup fix that happens during review).
pub const PREAMBLE_REVIEW: &str = "\n\n---\n[자동 리뷰 지침]\n\
- 진행 중 사용자에게 선택지를 묻지 말고, 항상 가장 합리적인 추천 방향으로 스스로 결정해 진행해라.\n\
- 이 턴을 마칠 때 반드시 메시지의 마지막 줄에 다음 중 하나만 정확히 출력해라:\n\
  - 머지 전 반드시 고쳐야 할 이슈가 없으면(승인): `VIBE_RESULT: approve`\n\
  - 자동으로 해결할 수 없는 문제가 있으면: `VIBE_RESULT: blocked`\n\
  - 아직 리뷰하거나 수정할 것이 남았으면: `VIBE_RESULT: continue`";

/// Rule 3 — nudge the coding agent to keep going.
pub const PROMPT_CONTINUE: &str = "아직 끝나지 않은 작업이 남아 있어. 남은 작업을 계속 진행해줘.";

/// Rule 4 — the first prompt sent to the dedicated review session.
pub const PROMPT_REVIEW_A: &str =
    "지금 이 워크트리의 작업 내용 전체 코드 리뷰해줘. 제대로 동작할지도 함께 검증해줘.";

/// Rule 4 — the follow-up prompt after the first review turn.
pub const PROMPT_REVIEW_B: &str = "머지 전 반드시 해결해야 하는 이슈가 있으면 해결 후 다시 \
전체 리뷰 해줘. 이슈가 없으면 승인해줘.";

/// Rule 5 — ask the session to resolve a merge conflict, then we retry.
pub const PROMPT_CONFLICT: &str =
    "base 브랜치와 머지 충돌이 발생했어. base 브랜치로 rebase 해서 충돌을 모두 해결해줘.";

/// Rule 1a — paste the failed cleanup script log and ask the agent to fix it.
pub fn cleanup_fix_prompt(log: &str) -> String {
    let log = if log.trim().is_empty() {
        "(로그가 비어 있음)"
    } else {
        log
    };
    format!(
        "cleanup 스크립트가 실패했어. 아래 실패 로그를 보고 원인을 해결해줘:\n\n```\n{log}\n```"
    )
}

/// Concatenate the stdout/stderr text from a process's log messages, tail-capped
/// to `max_bytes` on a UTF-8 char boundary. Non-text messages (JsonPatch,
/// SessionId, Ready/Finished, …) are ignored. Pure — unit-testable without the
/// MsgStore/DB the shell reads the messages from.
pub fn cleanup_failure_log_text(msgs: &[LogMsg], max_bytes: usize) -> String {
    let mut out = String::new();
    for msg in msgs {
        if let LogMsg::Stdout(s) | LogMsg::Stderr(s) = msg {
            // Append chunks verbatim. These are byte slices off the stdout/
            // stderr ReaderStream, NOT whole lines, so injecting a newline here
            // would split a logical line that happened to span two read chunks.
            out.push_str(s);
        }
    }
    if out.len() > max_bytes {
        let mut start = out.len() - max_bytes;
        while start < out.len() && !out.is_char_boundary(start) {
            start += 1;
        }
        format!("...(생략)...\n{}", &out[start..])
    } else {
        out
    }
}

/// Append the coding self-report instruction to a prompt body.
pub fn with_coding_preamble(body: &str) -> String {
    format!("{body}{PREAMBLE_CODING}")
}

/// Append the review self-report instruction to a prompt body.
pub fn with_review_preamble(body: &str) -> String {
    format!("{body}{PREAMBLE_REVIEW}")
}

/// The per-turn self-report parsed from the agent's final message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VibeResult {
    /// All work for the issue is complete.
    Done,
    /// Impossible to proceed even after taking every recommended path.
    Blocked,
    /// More work remains; keep going.
    Continue,
    /// (Review phase) No must-fix issues remain; ready to merge.
    Approve,
    /// No recognizable sentinel found.
    None,
}

impl VibeResult {
    /// Canonical token persisted in `vibe_runs.last_result`. `None` (no
    /// sentinel) maps to `None` so nothing is stored.
    pub fn as_token(self) -> Option<&'static str> {
        match self {
            VibeResult::Done => Some("done"),
            VibeResult::Blocked => Some("blocked"),
            VibeResult::Continue => Some("continue"),
            VibeResult::Approve => Some("approve"),
            VibeResult::None => Option::None,
        }
    }

    /// Inverse of [`as_token`]: map a stored token back to a result.
    pub fn from_token(s: &str) -> VibeResult {
        match s {
            "done" => VibeResult::Done,
            "blocked" => VibeResult::Blocked,
            "continue" => VibeResult::Continue,
            "approve" => VibeResult::Approve,
            _ => VibeResult::None,
        }
    }
}

/// The orchestration phase of a single vibe workspace run. Authoritative state,
/// persisted in the `vibe_runs` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VibePhase {
    /// The coding agent is producing the change.
    Coding,
    /// A dedicated review session is auditing the change.
    Review,
    /// The change is approved; merging into the base (with conflict retries).
    Merging,
    /// Terminal: needs human intervention.
    Blocked,
    /// Terminal: merged and handed to In review.
    Done,
}

impl VibePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            VibePhase::Coding => "coding",
            VibePhase::Review => "review",
            VibePhase::Merging => "merging",
            VibePhase::Blocked => "blocked",
            VibePhase::Done => "done",
        }
    }

    pub fn from_db_str(s: &str) -> Option<Self> {
        match s {
            "coding" => Some(VibePhase::Coding),
            "review" => Some(VibePhase::Review),
            "merging" => Some(VibePhase::Merging),
            "blocked" => Some(VibePhase::Blocked),
            "done" => Some(VibePhase::Done),
            _ => None,
        }
    }
}

/// Safety bounds that escalate a stuck run to `Blocked` instead of looping
/// forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VibeBounds {
    pub max_coding_turns: u32,
    pub max_review_turns: u32,
    pub max_merge_retries: u32,
}

impl Default for VibeBounds {
    fn default() -> Self {
        Self {
            max_coding_turns: 10,
            max_review_turns: 5,
            max_merge_retries: 3,
        }
    }
}

/// Why a run is being moved to `Blocked` (for the human-facing note / logs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockReason {
    /// The agent itself reported it could not proceed.
    AgentReported,
    MaxCodingTurns,
    MaxReviewTurns,
    MaxMergeRetries,
}

/// The action the imperative shell must perform after a turn finalizes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VibeAction {
    /// Leave everything as-is.
    Nothing,
    /// Rule 1a: a cleanup script failed — paste its log into the failing
    /// session and ask the agent to fix it.
    CleanupFix,
    /// Rule 3: more coding work remains — send a "continue" follow-up. `turn`
    /// is the new value the `coding_turns` counter should be set to.
    ContinueCoding { turn: u32 },
    /// Rule 4: coding is done — tag `vibe-done`, open a fresh review session,
    /// and send the review prompt.
    StartReview,
    /// Rule 4: the review session finished a turn without approving — send the
    /// "fix-or-approve" follow-up. `turn` is the new `review_turns` value.
    ReviewFollowup { turn: u32 },
    /// Tag `vibe-block` and stop; needs human attention.
    Block { reason: BlockReason },
    /// Rule 5: approved — attempt the merge. `retry` is the current
    /// `merge_retries` value (0 on the first attempt).
    AttemptMerge { retry: u32 },
}

/// Everything the pure decision needs, fetched by the shell before deciding.
#[derive(Debug, Clone)]
pub struct FinalizeInput {
    pub run_reason: ExecutionProcessRunReason,
    pub status: ExecutionProcessStatus,
    pub phase: VibePhase,
    /// Whether the session that just finalized is the dedicated review session.
    pub session_is_review: bool,
    /// The sentinel parsed from the agent's final message (only meaningful for
    /// coding-agent completions; ignored on script-failure paths).
    pub result: VibeResult,
    pub coding_turns: u32,
    pub review_turns: u32,
    pub merge_retries: u32,
    pub bounds: VibeBounds,
}

/// The outcome of a merge attempt, fed to [`decide_after_merge`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeOutcome {
    /// At least one repo merged and none failed.
    Success,
    /// A repo could not be fast-forward merged because the base diverged, or a
    /// rebase reported conflicts — resolvable by the agent.
    Conflict,
    /// A non-conflict failure (missing repo, git error, container failure) —
    /// not something the agent can rebase away.
    OtherFailure,
}

/// What to do once a merge attempt returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostMergeAction {
    /// Merge landed — move the issue to In review (phase → Done).
    MarkInReview,
    /// Conflict — ask the session to rebase/resolve, then retry. `retry` is the
    /// new `merge_retries` value.
    ResolveConflict { retry: u32 },
    /// Give up on auto-merge — mark the issue for human review and block.
    Escalate,
}

/// Parse the `VIBE_RESULT:` sentinel from an agent's final message.
///
/// Scans bottom-up so the *last* status line wins (the agent may quote the
/// instruction earlier in its reasoning). Tolerant of markdown wrapping
/// (`**VIBE_RESULT: done**`, `` `VIBE_RESULT: done` ``) and case.
pub fn parse_vibe_result(text: &str) -> VibeResult {
    let needle = "vibe_result";
    for line in text.lines().rev() {
        let lower = line.to_ascii_lowercase();
        let Some(idx) = lower.find(needle) else {
            continue;
        };
        // Look only at the FIRST word after the sentinel. Scanning the rest of
        // the line for a substring would let trailing prose flip the result —
        // e.g. "VIBE_RESULT: blocked (cannot approve)" must parse as Blocked,
        // not Approve. Strip the leading colon / markdown wrappers / spaces,
        // then read a single alphabetic token.
        let token = lower[idx + needle.len()..]
            .trim_start_matches(|c: char| {
                c.is_whitespace() || matches!(c, ':' | '*' | '`' | '_' | '"' | '\'')
            })
            .split(|c: char| !c.is_ascii_alphabetic())
            .next()
            .unwrap_or("");
        // Prefix match so inflections work ("approve" ⊂ "approved",
        // "block" ⊂ "blocked"); a single token matches at most one keyword.
        for (kw, res) in [
            ("approve", VibeResult::Approve),
            ("block", VibeResult::Blocked),
            ("continue", VibeResult::Continue),
            ("done", VibeResult::Done),
        ] {
            if token.starts_with(kw) {
                return res;
            }
        }
        // This line mentions the marker but carries no recognized status — e.g. a
        // recap line like "Note: emitted VIBE_RESULT above". Keep scanning upward
        // instead of giving up, so a genuine sentinel printed earlier still wins
        // rather than being shadowed by a later bare mention.
        continue;
    }
    VibeResult::None
}

/// Strip any `VIBE_RESULT:` sentinel line(s) from an agent message so the
/// orchestration marker never leaks into user-facing text — most importantly the
/// auto-commit message, which is built verbatim from the turn summary (the
/// agent's final message). Mirrors the tolerant matching in [`parse_vibe_result`]:
/// any line mentioning the marker (case-insensitive, markdown-wrapped) is
/// dropped, and trailing blank lines left behind are trimmed.
pub fn strip_result_sentinel(text: &str) -> String {
    let needle = "vibe_result";
    text.lines()
        .filter(|line| !line.to_ascii_lowercase().contains(needle))
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

/// The functional core: given a finalized turn, decide the single next action.
pub fn decide_finalize_action(input: &FinalizeInput) -> VibeAction {
    use ExecutionProcessRunReason as RR;
    use ExecutionProcessStatus as St;

    // Terminal phases never act again.
    if matches!(input.phase, VibePhase::Blocked | VibePhase::Done) {
        return VibeAction::Nothing;
    }

    // Rule 1b: a failed setup script means the coding agent never ran — do
    // nothing and leave the issue In progress for manual intervention.
    if matches!(input.run_reason, RR::SetupScript) && matches!(input.status, St::Failed) {
        return VibeAction::Nothing;
    }

    // Rule 1a: a failed cleanup script — ask the failing session to fix it,
    // bounded by the active phase's turn budget.
    if matches!(input.run_reason, RR::CleanupScript) && matches!(input.status, St::Failed) {
        return match input.phase {
            VibePhase::Review | VibePhase::Merging => {
                if input.session_is_review {
                    bounded_review(input, VibeAction::CleanupFix)
                } else {
                    VibeAction::Nothing
                }
            }
            _ => bounded_coding(input, VibeAction::CleanupFix),
        };
    }

    // Everything below is a state-machine transition that only fires on a
    // successful terminal completion of a coding-agent or cleanup turn. Failed
    // / killed coding turns, dev-server, and archive-script completions are
    // left untouched (conservative: a human decides).
    let terminal_success = matches!(input.status, St::Completed)
        && matches!(input.run_reason, RR::CodingAgent | RR::CleanupScript);
    if !terminal_success {
        return VibeAction::Nothing;
    }

    match input.phase {
        VibePhase::Coding => match input.result {
            // The coding agent's verb is "done"; tolerate a stray "approve" as
            // a request to move into review.
            VibeResult::Done | VibeResult::Approve => VibeAction::StartReview,
            VibeResult::Blocked => VibeAction::Block {
                reason: BlockReason::AgentReported,
            },
            VibeResult::Continue | VibeResult::None => bounded_coding(
                input,
                VibeAction::ContinueCoding {
                    turn: input.coding_turns + 1,
                },
            ),
        },
        VibePhase::Review => {
            // Only the review session advances the review; ignore late
            // completions from the original coding session.
            if !input.session_is_review {
                return VibeAction::Nothing;
            }
            match input.result {
                VibeResult::Approve => VibeAction::AttemptMerge { retry: 0 },
                VibeResult::Blocked => VibeAction::Block {
                    reason: BlockReason::AgentReported,
                },
                VibeResult::Done | VibeResult::Continue | VibeResult::None => bounded_review(
                    input,
                    VibeAction::ReviewFollowup {
                        turn: input.review_turns + 1,
                    },
                ),
            }
        }
        VibePhase::Merging => {
            // A conflict-resolution turn finished in the review session; retry
            // the merge with the current retry count — unless the agent reports
            // it could not resolve the conflict, in which case honor that
            // immediately instead of burning the remaining merge retries on a
            // conflict it already gave up on.
            if !input.session_is_review {
                return VibeAction::Nothing;
            }
            if matches!(input.result, VibeResult::Blocked) {
                return VibeAction::Block {
                    reason: BlockReason::AgentReported,
                };
            }
            VibeAction::AttemptMerge {
                retry: input.merge_retries,
            }
        }
        VibePhase::Blocked | VibePhase::Done => VibeAction::Nothing,
    }
}

/// Decide what to do once a merge attempt returns (rule 5).
pub fn decide_after_merge(
    outcome: MergeOutcome,
    merge_retries: u32,
    bounds: &VibeBounds,
) -> PostMergeAction {
    match outcome {
        MergeOutcome::Success => PostMergeAction::MarkInReview,
        MergeOutcome::Conflict => {
            let next = merge_retries + 1;
            if next <= bounds.max_merge_retries {
                PostMergeAction::ResolveConflict { retry: next }
            } else {
                PostMergeAction::Escalate
            }
        }
        MergeOutcome::OtherFailure => PostMergeAction::Escalate,
    }
}

/// Gate a coding-phase action on the coding-turn budget.
fn bounded_coding(input: &FinalizeInput, action: VibeAction) -> VibeAction {
    if input.coding_turns < input.bounds.max_coding_turns {
        action
    } else {
        VibeAction::Block {
            reason: BlockReason::MaxCodingTurns,
        }
    }
}

/// Gate a review-phase action on the review-turn budget.
fn bounded_review(input: &FinalizeInput, action: VibeAction) -> VibeAction {
    if input.review_turns < input.bounds.max_review_turns {
        action
    } else {
        VibeAction::Block {
            reason: BlockReason::MaxReviewTurns,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- parse_vibe_result -------------------------------------------------

    #[test]
    fn parses_each_token() {
        assert_eq!(parse_vibe_result("VIBE_RESULT: done"), VibeResult::Done);
        assert_eq!(
            parse_vibe_result("VIBE_RESULT: blocked"),
            VibeResult::Blocked
        );
        assert_eq!(
            parse_vibe_result("VIBE_RESULT: continue"),
            VibeResult::Continue
        );
        assert_eq!(
            parse_vibe_result("VIBE_RESULT: approve"),
            VibeResult::Approve
        );
    }

    #[test]
    fn parses_inflections_and_case() {
        assert_eq!(parse_vibe_result("vibe_result: DONE"), VibeResult::Done);
        assert_eq!(
            parse_vibe_result("VIBE_RESULT: Approved"),
            VibeResult::Approve
        );
        assert_eq!(parse_vibe_result("Vibe_Result: BLOCK"), VibeResult::Blocked);
    }

    #[test]
    fn tolerates_markdown_wrapping() {
        assert_eq!(parse_vibe_result("**VIBE_RESULT: done**"), VibeResult::Done);
        assert_eq!(
            parse_vibe_result("`VIBE_RESULT: approve`"),
            VibeResult::Approve
        );
    }

    #[test]
    fn takes_last_occurrence() {
        let msg = "First I considered VIBE_RESULT: continue\n\
                   ...but actually everything is finished.\n\
                   VIBE_RESULT: done";
        assert_eq!(parse_vibe_result(msg), VibeResult::Done);
    }

    #[test]
    fn bare_marker_mention_below_does_not_shadow_real_sentinel() {
        // The bottom-most marker match is a recap line with no recognized status
        // ("...VIBE_RESULT above"); it must NOT shadow the genuine sentinel
        // printed earlier. The parser keeps scanning upward rather than giving
        // up at the first match.
        let msg = "VIBE_RESULT: done\n\
                   Note: emitted VIBE_RESULT above as instructed.";
        assert_eq!(parse_vibe_result(msg), VibeResult::Done);
    }

    #[test]
    fn missing_sentinel_is_none() {
        assert_eq!(
            parse_vibe_result("I finished the work and it looks great."),
            VibeResult::None
        );
        assert_eq!(parse_vibe_result(""), VibeResult::None);
    }

    #[test]
    fn strip_removes_trailing_sentinel_and_blank_lines() {
        let msg = "feat(x): 요약\n\n본문 설명.\n\nVIBE_RESULT: done";
        assert_eq!(strip_result_sentinel(msg), "feat(x): 요약\n\n본문 설명.");
    }

    #[test]
    fn strip_handles_markdown_wrapped_sentinel() {
        let msg = "fix(y): 정리\n\n`VIBE_RESULT: continue`";
        assert_eq!(strip_result_sentinel(msg), "fix(y): 정리");
    }

    #[test]
    fn strip_drops_every_sentinel_mention() {
        let msg = "chore: z\nVIBE_RESULT: done\nNote: emitted VIBE_RESULT above.";
        assert_eq!(strip_result_sentinel(msg), "chore: z");
    }

    #[test]
    fn strip_leaves_ordinary_message_untouched() {
        let msg = "feat(a): b\n\nbody line";
        assert_eq!(strip_result_sentinel(msg), msg);
    }

    #[test]
    fn sentinel_without_known_token_is_none() {
        assert_eq!(parse_vibe_result("VIBE_RESULT: maybe?"), VibeResult::None);
    }

    #[test]
    fn trailing_prose_on_sentinel_line_does_not_flip_result() {
        // The keyword scan must look only at the first token after the sentinel,
        // not anywhere on the line — otherwise an "approve" mentioned in an aside
        // would hijack a "blocked"/"continue" verdict (→ a wrongful merge).
        assert_eq!(
            parse_vibe_result("VIBE_RESULT: blocked (cannot approve, conflicts remain)"),
            VibeResult::Blocked
        );
        assert_eq!(
            parse_vibe_result("VIBE_RESULT: continue — still need to approve the plan"),
            VibeResult::Continue
        );
        assert_eq!(
            parse_vibe_result("VIBE_RESULT: done. 이제 리뷰로 넘어갑니다"),
            VibeResult::Done
        );
    }

    #[test]
    fn result_token_round_trips() {
        for r in [
            VibeResult::Done,
            VibeResult::Blocked,
            VibeResult::Continue,
            VibeResult::Approve,
        ] {
            let token = r.as_token().expect("non-None has a token");
            assert_eq!(VibeResult::from_token(token), r);
        }
        assert_eq!(VibeResult::None.as_token(), None);
        assert_eq!(VibeResult::from_token("garbage"), VibeResult::None);
    }

    // ---- decide_finalize_action: helpers -----------------------------------

    fn input() -> FinalizeInput {
        FinalizeInput {
            run_reason: ExecutionProcessRunReason::CodingAgent,
            status: ExecutionProcessStatus::Completed,
            phase: VibePhase::Coding,
            session_is_review: false,
            result: VibeResult::None,
            coding_turns: 0,
            review_turns: 0,
            merge_retries: 0,
            bounds: VibeBounds::default(),
        }
    }

    // ---- terminal phases ---------------------------------------------------

    #[test]
    fn blocked_and_done_never_act() {
        for phase in [VibePhase::Blocked, VibePhase::Done] {
            let i = FinalizeInput {
                phase,
                result: VibeResult::Done,
                ..input()
            };
            assert_eq!(decide_finalize_action(&i), VibeAction::Nothing);
        }
    }

    // ---- rule 1: script failures -------------------------------------------

    #[test]
    fn setup_failure_does_nothing() {
        let i = FinalizeInput {
            run_reason: ExecutionProcessRunReason::SetupScript,
            status: ExecutionProcessStatus::Failed,
            ..input()
        };
        assert_eq!(decide_finalize_action(&i), VibeAction::Nothing);
    }

    #[test]
    fn cleanup_failure_in_coding_asks_for_fix() {
        let i = FinalizeInput {
            run_reason: ExecutionProcessRunReason::CleanupScript,
            status: ExecutionProcessStatus::Failed,
            phase: VibePhase::Coding,
            ..input()
        };
        assert_eq!(decide_finalize_action(&i), VibeAction::CleanupFix);
    }

    #[test]
    fn cleanup_failure_in_review_session_asks_for_fix() {
        let i = FinalizeInput {
            run_reason: ExecutionProcessRunReason::CleanupScript,
            status: ExecutionProcessStatus::Failed,
            phase: VibePhase::Review,
            session_is_review: true,
            ..input()
        };
        assert_eq!(decide_finalize_action(&i), VibeAction::CleanupFix);
    }

    #[test]
    fn cleanup_failure_outside_review_session_is_ignored_in_review() {
        let i = FinalizeInput {
            run_reason: ExecutionProcessRunReason::CleanupScript,
            status: ExecutionProcessStatus::Failed,
            phase: VibePhase::Review,
            session_is_review: false,
            ..input()
        };
        assert_eq!(decide_finalize_action(&i), VibeAction::Nothing);
    }

    #[test]
    fn cleanup_failure_blocks_when_coding_budget_exhausted() {
        let i = FinalizeInput {
            run_reason: ExecutionProcessRunReason::CleanupScript,
            status: ExecutionProcessStatus::Failed,
            phase: VibePhase::Coding,
            coding_turns: 10,
            ..input()
        };
        assert_eq!(
            decide_finalize_action(&i),
            VibeAction::Block {
                reason: BlockReason::MaxCodingTurns
            }
        );
    }

    // ---- non-driving completions -------------------------------------------

    #[test]
    fn failed_coding_turn_does_nothing() {
        for status in [
            ExecutionProcessStatus::Failed,
            ExecutionProcessStatus::Killed,
        ] {
            let i = FinalizeInput {
                run_reason: ExecutionProcessRunReason::CodingAgent,
                status,
                result: VibeResult::Done,
                ..input()
            };
            assert_eq!(decide_finalize_action(&i), VibeAction::Nothing);
        }
    }

    #[test]
    fn dev_server_and_archive_completion_do_nothing() {
        for rr in [
            ExecutionProcessRunReason::DevServer,
            ExecutionProcessRunReason::ArchiveScript,
        ] {
            let i = FinalizeInput {
                run_reason: rr,
                status: ExecutionProcessStatus::Completed,
                result: VibeResult::Done,
                ..input()
            };
            assert_eq!(decide_finalize_action(&i), VibeAction::Nothing);
        }
    }

    // ---- rule 3: coding phase ----------------------------------------------

    #[test]
    fn coding_done_starts_review() {
        let i = FinalizeInput {
            result: VibeResult::Done,
            ..input()
        };
        assert_eq!(decide_finalize_action(&i), VibeAction::StartReview);
    }

    #[test]
    fn coding_blocked_blocks_with_agent_reason() {
        let i = FinalizeInput {
            result: VibeResult::Blocked,
            ..input()
        };
        assert_eq!(
            decide_finalize_action(&i),
            VibeAction::Block {
                reason: BlockReason::AgentReported
            }
        );
    }

    #[test]
    fn coding_continue_sends_next_turn() {
        let i = FinalizeInput {
            result: VibeResult::Continue,
            coding_turns: 2,
            ..input()
        };
        assert_eq!(
            decide_finalize_action(&i),
            VibeAction::ContinueCoding { turn: 3 }
        );
    }

    #[test]
    fn coding_no_sentinel_keeps_going() {
        let i = FinalizeInput {
            result: VibeResult::None,
            coding_turns: 0,
            ..input()
        };
        assert_eq!(
            decide_finalize_action(&i),
            VibeAction::ContinueCoding { turn: 1 }
        );
    }

    #[test]
    fn coding_continue_blocks_at_budget() {
        let i = FinalizeInput {
            result: VibeResult::Continue,
            coding_turns: 10,
            ..input()
        };
        assert_eq!(
            decide_finalize_action(&i),
            VibeAction::Block {
                reason: BlockReason::MaxCodingTurns
            }
        );
    }

    #[test]
    fn coding_completes_via_cleanup_success() {
        // When a cleanup script is configured, the terminal completion arrives
        // as a CleanupScript/Completed event — the agent's sentinel still drives.
        let i = FinalizeInput {
            run_reason: ExecutionProcessRunReason::CleanupScript,
            status: ExecutionProcessStatus::Completed,
            result: VibeResult::Done,
            ..input()
        };
        assert_eq!(decide_finalize_action(&i), VibeAction::StartReview);
    }

    // ---- rule 4: review phase ----------------------------------------------

    #[test]
    fn review_approve_attempts_merge() {
        let i = FinalizeInput {
            phase: VibePhase::Review,
            session_is_review: true,
            result: VibeResult::Approve,
            ..input()
        };
        assert_eq!(
            decide_finalize_action(&i),
            VibeAction::AttemptMerge { retry: 0 }
        );
    }

    #[test]
    fn review_not_approved_sends_followup() {
        for result in [VibeResult::None, VibeResult::Continue, VibeResult::Done] {
            let i = FinalizeInput {
                phase: VibePhase::Review,
                session_is_review: true,
                result,
                review_turns: 1,
                ..input()
            };
            assert_eq!(
                decide_finalize_action(&i),
                VibeAction::ReviewFollowup { turn: 2 }
            );
        }
    }

    #[test]
    fn review_blocked_blocks() {
        let i = FinalizeInput {
            phase: VibePhase::Review,
            session_is_review: true,
            result: VibeResult::Blocked,
            ..input()
        };
        assert_eq!(
            decide_finalize_action(&i),
            VibeAction::Block {
                reason: BlockReason::AgentReported
            }
        );
    }

    #[test]
    fn review_followup_blocks_at_budget() {
        let i = FinalizeInput {
            phase: VibePhase::Review,
            session_is_review: true,
            result: VibeResult::None,
            review_turns: 5,
            ..input()
        };
        assert_eq!(
            decide_finalize_action(&i),
            VibeAction::Block {
                reason: BlockReason::MaxReviewTurns
            }
        );
    }

    #[test]
    fn review_ignores_non_review_session_completion() {
        let i = FinalizeInput {
            phase: VibePhase::Review,
            session_is_review: false,
            result: VibeResult::Approve,
            ..input()
        };
        assert_eq!(decide_finalize_action(&i), VibeAction::Nothing);
    }

    // ---- rule 5: merging phase ---------------------------------------------

    #[test]
    fn merging_retries_merge_after_resolution_turn() {
        let i = FinalizeInput {
            phase: VibePhase::Merging,
            session_is_review: true,
            merge_retries: 1,
            ..input()
        };
        assert_eq!(
            decide_finalize_action(&i),
            VibeAction::AttemptMerge { retry: 1 }
        );
    }

    #[test]
    fn merging_ignores_non_review_session() {
        let i = FinalizeInput {
            phase: VibePhase::Merging,
            session_is_review: false,
            ..input()
        };
        assert_eq!(decide_finalize_action(&i), VibeAction::Nothing);
    }

    #[test]
    fn merging_blocked_honors_agent_instead_of_retrying() {
        // The agent gave up on the conflict mid-retry; we must block now rather
        // than re-attempt the merge until max_merge_retries is exhausted.
        let i = FinalizeInput {
            phase: VibePhase::Merging,
            session_is_review: true,
            result: VibeResult::Blocked,
            merge_retries: 1,
            ..input()
        };
        assert_eq!(
            decide_finalize_action(&i),
            VibeAction::Block {
                reason: BlockReason::AgentReported
            }
        );
    }

    // ---- decide_after_merge ------------------------------------------------

    #[test]
    fn merge_success_marks_in_review() {
        assert_eq!(
            decide_after_merge(MergeOutcome::Success, 0, &VibeBounds::default()),
            PostMergeAction::MarkInReview
        );
    }

    #[test]
    fn merge_conflict_asks_to_resolve_then_escalates() {
        let b = VibeBounds::default();
        assert_eq!(
            decide_after_merge(MergeOutcome::Conflict, 0, &b),
            PostMergeAction::ResolveConflict { retry: 1 }
        );
        assert_eq!(
            decide_after_merge(MergeOutcome::Conflict, 2, &b),
            PostMergeAction::ResolveConflict { retry: 3 }
        );
        // 4th attempt exceeds max_merge_retries (3).
        assert_eq!(
            decide_after_merge(MergeOutcome::Conflict, 3, &b),
            PostMergeAction::Escalate
        );
    }

    #[test]
    fn merge_other_failure_escalates_immediately() {
        assert_eq!(
            decide_after_merge(MergeOutcome::OtherFailure, 0, &VibeBounds::default()),
            PostMergeAction::Escalate
        );
    }

    // ---- prompt helpers ----------------------------------------------------

    #[test]
    fn coding_preamble_is_appended_and_self_describes_tokens() {
        let p = with_coding_preamble(PROMPT_CONTINUE);
        assert!(p.starts_with(PROMPT_CONTINUE));
        assert!(p.contains("VIBE_RESULT: done"));
        assert!(p.contains("VIBE_RESULT: continue"));
    }

    #[test]
    fn review_preamble_mentions_approve() {
        let p = with_review_preamble(PROMPT_REVIEW_B);
        assert!(p.starts_with(PROMPT_REVIEW_B));
        assert!(p.contains("VIBE_RESULT: approve"));
    }

    #[test]
    fn cleanup_fix_prompt_embeds_log() {
        let p = cleanup_fix_prompt("npm ERR! boom");
        assert!(p.contains("npm ERR! boom"));
        assert!(p.contains("cleanup"));
    }

    #[test]
    fn cleanup_fix_prompt_handles_empty_log() {
        let p = cleanup_fix_prompt("   ");
        assert!(p.contains("로그가 비어 있음"));
    }

    // ---- cleanup_failure_log_text ------------------------------------------

    #[test]
    fn cleanup_log_concatenates_stdout_and_stderr() {
        let msgs = vec![
            LogMsg::Stdout("building...\n".into()),
            LogMsg::Stderr("error: boom".into()),
        ];
        // Chunks are concatenated verbatim; no synthetic newline is injected.
        assert_eq!(
            cleanup_failure_log_text(&msgs, 4000),
            "building...\nerror: boom"
        );
    }

    #[test]
    fn cleanup_log_ignores_non_text_messages() {
        // Only stdout/stderr count; control / structured messages are skipped.
        let msgs = vec![
            LogMsg::Ready,
            LogMsg::SessionId("abc".into()),
            LogMsg::Stdout("hello".into()),
            LogMsg::Finished,
        ];
        assert_eq!(cleanup_failure_log_text(&msgs, 4000), "hello");
    }

    #[test]
    fn cleanup_log_empty_when_no_text() {
        assert_eq!(cleanup_failure_log_text(&[], 4000), "");
        assert_eq!(
            cleanup_failure_log_text(&[LogMsg::Ready, LogMsg::Finished], 4000),
            ""
        );
    }

    #[test]
    fn cleanup_log_tail_caps_on_char_boundary() {
        // "가나다라마" = 15 bytes (no synthetic newline). Capping to 11 lands at
        // byte 4, mid-character; it must advance to the next boundary (byte 6)
        // so the slice is valid UTF-8 — tail "다라마", never a split codepoint.
        let msgs = vec![LogMsg::Stdout("가나다라마".into())];
        assert_eq!(cleanup_failure_log_text(&msgs, 11), "...(생략)...\n다라마");
    }

    // ---- phase round-trip --------------------------------------------------

    #[test]
    fn phase_string_round_trips() {
        for p in [
            VibePhase::Coding,
            VibePhase::Review,
            VibePhase::Merging,
            VibePhase::Blocked,
            VibePhase::Done,
        ] {
            assert_eq!(VibePhase::from_db_str(p.as_str()), Some(p));
        }
        assert_eq!(VibePhase::from_db_str("nonsense"), None);
    }
}
