//! The agent's live workspace summary: a fenced block tagged `vibe-status`
//! inside an assistant message. The block is stored on the workspace row and
//! hidden from the rendered message, so the parsing rules live here for both
//! the storing observer and the final-message consumers.

use std::sync::LazyLock;

use regex::Regex;

/// Info string that marks a summary fence.
pub const INFO_STRING: &str = "vibe-status";
/// Upper bound on visible characters kept in the stored summary.
pub const MAX_VISIBLE_CHARS: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusBlock {
    pub text: String,
    /// False while the closing fence has not streamed in yet.
    pub closed: bool,
}

// A markdown link; only its label counts towards the visible length.
static LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\[([^\]\n]*)\]\(\s*(?:<[^>\n]*>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)"#).unwrap()
});

struct Fence {
    marker: char,
    count: usize,
    status: bool,
    start: usize,
}

// Markdown allows up to three leading spaces on fence delimiters.
fn delimiter(line: &str) -> &str {
    if line.starts_with("    ") {
        line
    } else {
        line.trim_start_matches(' ')
    }
}

/// Reports every summary fence as `(first_line, end_line_exclusive, text, closed)`.
/// Other fences are tracked too, so a `vibe-status` example quoted inside a
/// code block never counts as a summary.
fn scan(text: &str, mut on_block: impl FnMut(usize, usize, String, bool)) {
    let lines: Vec<&str> = text.lines().collect();
    let mut fence: Option<Fence> = None;
    let mut content: Vec<&str> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let delimiter = delimiter(line);
        if let Some(open) = &fence {
            let run = delimiter
                .chars()
                .take_while(|ch| *ch == open.marker)
                .count();
            // CommonMark: a closing fence may carry trailing whitespace.
            if run >= open.count && delimiter[run..].trim().is_empty() {
                if open.status {
                    on_block(open.start, index + 1, content.join("\n"), true);
                }
                fence = None;
                content.clear();
            } else if open.status {
                content.push(line);
            }
            continue;
        }
        if let Some(marker @ ('`' | '~')) = delimiter.chars().next() {
            let count = delimiter.chars().take_while(|ch| *ch == marker).count();
            if count >= 3 {
                let info = delimiter[count..].trim();
                fence = Some(Fence {
                    marker,
                    count,
                    status: info.eq_ignore_ascii_case(INFO_STRING),
                    start: index,
                });
                content.clear();
            }
        }
    }
    if let Some(open) = fence
        && open.status
    {
        on_block(open.start, lines.len(), content.join("\n"), false);
    }
}

/// The summary the message currently ends with. An earlier block is replaced
/// by a later one, so the agent can refresh it within a single message.
pub fn extract_last_block(text: &str) -> Option<StatusBlock> {
    let mut last = None;
    scan(text, |_, _, text, closed| {
        last = Some(StatusBlock {
            text: text.trim().to_string(),
            closed,
        });
    });
    last
}

/// The message without its summary blocks, for consumers that read the final
/// message as prose (turn summaries, PR text, result sentinels).
pub fn strip_blocks(text: &str) -> String {
    let mut ranges = Vec::new();
    scan(text, |start, end, _, _| ranges.push(start..end));
    if ranges.is_empty() {
        return text.trim().to_string();
    }
    text.lines()
        .enumerate()
        .filter(|(index, _)| !ranges.iter().any(|range| range.contains(index)))
        .map(|(_, line)| line)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Keeps the first `max` visible characters. A link cut by the limit is kept
/// as its (shortened) label only, and a cut summary ends with an ellipsis.
pub fn truncate_visible(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut count = 0;
    let mut last = 0;
    for capture in LINK.captures_iter(text) {
        let whole = capture.get(0).unwrap();
        let label = capture.get(1).unwrap().as_str();
        if !push_visible(&mut out, &mut count, max, &text[last..whole.start()]) {
            return finish(out);
        }
        if count + label.chars().count() <= max {
            out.push_str(whole.as_str());
            count += label.chars().count();
        } else {
            push_visible(&mut out, &mut count, max, label);
            return finish(out);
        }
        last = whole.end();
    }
    if push_visible(&mut out, &mut count, max, &text[last..]) {
        out
    } else {
        finish(out)
    }
}

/// Appends `slice` until `max` visible characters; false once the limit hit.
fn push_visible(out: &mut String, count: &mut usize, max: usize, slice: &str) -> bool {
    for ch in slice.chars() {
        if *count == max {
            return false;
        }
        out.push(ch);
        *count += 1;
    }
    true
}

fn finish(mut out: String) -> String {
    let trimmed = out.trim_end().len();
    out.truncate(trimmed);
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_closed_block_wins_and_open_blocks_are_reported() {
        let text = "intro\n```vibe-status\nfirst\n```\nmore\n~~~vibe-status\nsecond line one\nsecond line two\n~~~\ntail";
        assert_eq!(
            extract_last_block(text),
            Some(StatusBlock {
                text: "second line one\nsecond line two".into(),
                closed: true
            })
        );
        // Trailing whitespace after the closing fence still closes it; an
        // open block would otherwise swallow the rest of the message.
        let spaced = "```vibe-status\nsummary here.\n```  \nVIBE_RESULT: done";
        assert_eq!(
            extract_last_block(spaced),
            Some(StatusBlock {
                text: "summary here.".into(),
                closed: true
            })
        );
        assert_eq!(strip_blocks(spaced), "VIBE_RESULT: done");
        let streaming = "text\n  ```VIBE-STATUS\nstill typ";
        assert_eq!(
            extract_last_block(streaming),
            Some(StatusBlock {
                text: "still typ".into(),
                closed: false
            })
        );
        assert_eq!(extract_last_block("```rust\nlet x = 1;\n```"), None);
    }

    #[test]
    fn quoted_examples_inside_other_fences_are_not_summaries() {
        let text =
            "````markdown\n```vibe-status\nnot a summary\n```\n````\n```vibe-status\nreal\n```";
        assert_eq!(extract_last_block(text).unwrap().text, "real");
        assert_eq!(
            extract_last_block("```md\n```vibe-status\nnested\n```"),
            None
        );
    }

    #[test]
    fn strip_removes_closed_and_open_blocks() {
        let text =
            "Done.\n\n```vibe-status\nsummary\n```\n\nNext steps.\n```vibe-status\nunfinished";
        assert_eq!(strip_blocks(text), "Done.\n\n\nNext steps.");
        assert_eq!(strip_blocks("```vibe-status\nonly\n```"), "");
        assert_eq!(strip_blocks("  plain  "), "plain");
    }

    #[test]
    fn truncation_counts_visible_characters_and_keeps_whole_links() {
        let text = "abc [link](x.html \"vibe-artifact\") def";
        assert_eq!(truncate_visible(text, 100), text);
        assert_eq!(
            truncate_visible(text, 8),
            "abc [link](x.html \"vibe-artifact\")…"
        );
        assert_eq!(truncate_visible(text, 6), "abc li…");
        assert_eq!(truncate_visible("가나다라마", 3), "가나다…");
        assert_eq!(truncate_visible("abc   ", 2), "ab…");
    }
}
