//! Commit messages for changes a coding turn leaves uncommitted.
//!
//! The agent's final reply is written for the user (a work report with test
//! results, status blocks and orchestration markers) and never becomes Git
//! history. The message is drafted separately from the session and checked
//! here; anything that does not look like a commit message is rejected so the
//! caller falls back to its default.

use std::{collections::BTreeSet, sync::LazyLock};

use regex::Regex;

const MAX_SUBJECT_CHARS: usize = 120;
const MAX_BODY_LINES: usize = 12;
const MAX_BODY_CHARS: usize = 1200;

static ISSUE_REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#(\d+)\b").expect("valid regex"));
static PARENTHESIZED_ISSUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*\(\s*#(\d+)\s*\)").expect("valid regex"));
/// The template's own placeholder, echoed back instead of a number.
static ISSUE_PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\s*\(?\s*#\{?\s*(?:issue[_ -]?number|issue[_ -]?id|number)\s*\}?\s*\)?")
        .expect("valid regex")
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\S) {2,}").expect("valid regex"));
static ISSUE_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/(?:issues|pull)/(\d+)\b").expect("valid regex"));
static LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(?:\*\*)?(?:git\s+)?commit(?:\s+message)?\s*:(?:\*\*)?\s*")
        .expect("valid regex")
});

/// Issue numbers the user wrote in these texts, as `#123` or an issue/PR URL.
pub fn explicit_issue_numbers<'a>(texts: impl IntoIterator<Item = &'a str>) -> BTreeSet<String> {
    texts
        .into_iter()
        .flat_map(|text| {
            ISSUE_REFERENCE
                .captures_iter(text)
                .chain(ISSUE_URL.captures_iter(text))
                .map(|capture| capture[1].to_string())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The request sent to the agent's out-of-conversation generation.
pub fn instructions(conventions: &str, changes: &str, issues: &BTreeSet<String>) -> String {
    let issues = if issues.is_empty() {
        "none. Do not reference any issue number.".to_string()
    } else {
        format!(
            "{}. Do not reference any other issue number.",
            issues
                .iter()
                .map(|issue| format!("#{issue}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    format!(
        "Write the Git commit message for the uncommitted changes listed below, which this session made.\n\
         Reply with the commit message only: one subject line, optionally followed by a blank line and a short body. \
         Do not include a work report, test results, review notes, status blocks, Markdown headings or code fences, \
         and do not run any tools.\n\n\
         Follow these commit conventions from the user's settings where they describe the message itself:\n\
         {conventions}\n\n\
         Issue numbers the user explicitly provided: {issues}\n\n\
         Uncommitted changes:\n{changes}\n",
        conventions = conventions.trim(),
        changes = changes.trim(),
    )
}

/// The drafted message as it can be committed, or `None` when it is not a
/// commit message. Issue references the user never gave are removed.
pub fn sanitize(draft: &str, issues: &BTreeSet<String>) -> Option<String> {
    let text = executors::logs::status_note::strip_blocks(draft);
    let text = crate::services::vibe_orchestrator::strip_result_sentinel(&text);
    let text = unfence(&text);
    let mut lines = text.lines().map(str::trim_end);
    let subject = lines.by_ref().find(|line| !line.trim().is_empty())?;
    let subject = LABEL.replace(subject.trim(), "");
    let subject = clean_references(
        subject.trim_matches(|c: char| c == '`' || c == '"' || c == '\''),
        issues,
    );
    if subject.is_empty()
        || subject.chars().count() > MAX_SUBJECT_CHARS
        || subject.starts_with('#')
        || subject.starts_with("```")
    {
        return None;
    }
    let mut body: Vec<String> = Vec::new();
    for line in lines {
        if line.trim().is_empty() && body.last().is_none_or(|last| last.is_empty()) {
            continue;
        }
        body.push(clean_references(line, issues));
    }
    while body.last().is_some_and(|line| line.is_empty()) {
        body.pop();
    }
    let report_like = body.len() > MAX_BODY_LINES
        || body.iter().map(|line| line.chars().count()).sum::<usize>() > MAX_BODY_CHARS
        || body
            .iter()
            .any(|line| line.trim_start().starts_with('#') || line.contains("```"));
    if body.is_empty() || report_like {
        return Some(subject);
    }
    Some(format!("{subject}\n\n{}", body.join("\n")))
}

/// The content of a message the model wrapped in a code fence.
fn unfence(text: &str) -> String {
    let trimmed = text.trim();
    let Some(inner) = trimmed.strip_prefix("```") else {
        return trimmed.to_string();
    };
    let inner = inner.split_once('\n').map_or("", |(_, rest)| rest);
    inner
        .trim_end()
        .strip_suffix("```")
        .unwrap_or(inner)
        .trim()
        .to_string()
}

fn clean_references(line: &str, issues: &BTreeSet<String>) -> String {
    let stripped = ISSUE_PLACEHOLDER.replace_all(line, "");
    let mut removed = stripped.len() != line.len();
    let mut keep = |capture: &regex::Captures| {
        if issues.contains(&capture[1]) {
            capture[0].to_string()
        } else {
            removed = true;
            String::new()
        }
    };
    let line = PARENTHESIZED_ISSUE
        .replace_all(&stripped, &mut keep)
        .into_owned();
    let line = ISSUE_REFERENCE.replace_all(&line, &mut keep).into_owned();
    if !removed {
        return line;
    }
    SPACES.replace_all(&line, "$1 ").trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issues(numbers: &[&str]) -> BTreeSet<String> {
        numbers.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn collects_only_issue_numbers_the_user_wrote() {
        assert_eq!(
            explicit_issue_numbers([
                "Fix #12 and see https://example.test/org/repo/issues/34",
                "no numbers here 56",
            ]),
            issues(&["12", "34"])
        );
    }

    #[test]
    fn removes_the_template_placeholder_when_no_issue_was_given() {
        for echoed in [
            "feat(common): 정책 추가 (#{issue_number})",
            "feat(common): 정책 추가 (#issue_number)",
            "feat(common): 정책 추가 #{issue_number}",
        ] {
            assert_eq!(
                sanitize(echoed, &issues(&[])).as_deref(),
                Some("feat(common): 정책 추가"),
                "{echoed}"
            );
        }
    }

    #[test]
    fn keeps_a_conventional_korean_message() {
        let message =
            "fix(executors): 자동 커밋 메시지 분리 (#12)\n\n최종 답변 대신 전용 메시지를 사용한다.";
        assert_eq!(
            sanitize(message, &issues(&["12"])).as_deref(),
            Some(message)
        );
    }

    #[test]
    fn removes_issue_numbers_that_were_not_provided() {
        assert_eq!(
            sanitize("feat(fixture): 예제 기능 추가 (#123)", &issues(&[])).as_deref(),
            Some("feat(fixture): 예제 기능 추가")
        );
        assert_eq!(
            sanitize("fix: refs #7 and #8", &issues(&["8"])).as_deref(),
            Some("fix: refs and #8")
        );
    }

    #[test]
    fn strips_wrappers_labels_status_blocks_and_sentinels() {
        let draft = "```text\nCommit message: docs: README 추가\n```\n\n```vibe-status\nWork is done.\n```\nVIBE_RESULT: done";
        assert_eq!(
            sanitize(draft, &issues(&[])).as_deref(),
            Some("docs: README 추가")
        );
    }

    #[test]
    fn drops_a_report_body_and_rejects_a_report() {
        let report = format!(
            "fix: 재리뷰 지적 반영\n\n## 테스트\n- cargo test 통과\n{}",
            "- 항목\n".repeat(3)
        );
        assert_eq!(
            sanitize(&report, &issues(&[])).as_deref(),
            Some("fix: 재리뷰 지적 반영")
        );
        assert_eq!(sanitize("## 재리뷰 결과\n모두 통과", &issues(&[])), None);
        assert_eq!(
            sanitize(&"가".repeat(MAX_SUBJECT_CHARS + 1), &issues(&[])),
            None
        );
        assert_eq!(sanitize("  \n ", &issues(&[])), None);
    }

    #[test]
    fn instructions_name_the_allowed_issues_and_changes() {
        let text = instructions("Use Korean.", "\nrepo:\n M src/lib.rs\n", &issues(&["9"]));
        assert!(text.contains("Use Korean."));
        assert!(text.contains("explicitly provided: #9. Do not reference any other"));
        assert!(text.contains("M src/lib.rs"));
        let none = instructions("", "x", &issues(&[]));
        assert!(none.contains("explicitly provided: none."));
    }
}
