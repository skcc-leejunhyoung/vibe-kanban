//! Executor-independent candidates. These are untrusted references, never file permissions.
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{NormalizedEntry, NormalizedEntryType};

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactStatus {
    Preparing,
    Ready,
    Missing,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ArtifactReference {
    pub id: String,
    pub execution_id: String,
    pub name: String,
    pub mime: String,
    pub path: Option<String>,
    pub url: Option<String>,
    /// Normalized entry index, scoped to this execution (never a client-supplied path).
    pub source_entry: Option<u32>,
    /// Child transcript namespace. Absent on existing parent-only sidecars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_scope: Option<String>,
    pub source: String,
    pub content_hash: Option<String>,
    pub size_bytes: u32,
    pub status: ArtifactStatus,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ArtifactList {
    pub artifacts: Vec<ArtifactReference>,
    pub complete: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ArtifactResource {
    pub path: String,
    pub mime: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ArtifactBundle {
    pub artifact: ArtifactReference,
    /// Workspace-relative base for inline static dependencies (never a file permission).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_path: Option<String>,
    pub resources: Vec<ArtifactResource>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactCandidate {
    File(String),
    Inline { name: String, content: String },
    PreparingInline { name: String },
    Url(String),
}

// A standalone attachment line avoids treating inline-code examples as output.
static LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^(?:[-+*] |[0-9]+[.)] )?!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))\s+"vibe-artifact"\s*\)$"#).unwrap()
});
static FILE_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?::[0-9]+){1,2}$").unwrap());

fn svg_root(source: &str) -> &str {
    let source = source.trim_start_matches('\u{feff}').trim_start();
    source
        .strip_prefix("<?xml")
        .and_then(|declaration| declaration.split_once("?>"))
        .map_or(source, |(_, document)| document.trim_start())
}

/// Only explicitly attached output is registered. Ordinary links, code blocks,
/// quoted examples and tool output never imply an attachment.
pub fn markdown_candidates(text: &str) -> Vec<ArtifactCandidate> {
    let mut candidates = Vec::new();
    let mut fence: Option<(char, usize, String, String)> = None;
    let mut ordinal = 0;
    for line in text.lines() {
        // Markdown allows up to three leading spaces on fence delimiters.
        let delimiter = if line.starts_with("    ") {
            line
        } else {
            line.trim_start_matches(' ')
        };
        if let Some((marker, count, language, content)) = fence.as_mut() {
            if delimiter.chars().take_while(|ch| ch == marker).count() >= *count
                && delimiter.trim_end_matches(*marker).trim().is_empty()
            {
                let source = content.trim();
                let lower = source.to_ascii_lowercase();
                let extension = match language.as_str() {
                    "mermaid" => Some("mmd"),
                    "html" | "htm"
                        if (lower.starts_with("<!doctype html") || lower.starts_with("<html"))
                            && lower.ends_with("</html>") =>
                    {
                        Some("html")
                    }
                    "svg" | "xml"
                        if svg_root(&lower).starts_with("<svg")
                            && (lower.ends_with("</svg>")
                                || svg_root(&lower)
                                    .strip_suffix("/>")
                                    .is_some_and(|root| !root.contains('>'))) =>
                    {
                        Some("svg")
                    }
                    _ => None,
                };
                if let Some(extension) = extension.filter(|_| !source.is_empty()) {
                    candidates.push(ArtifactCandidate::Inline {
                        name: format!("block-{ordinal}.{extension}"),
                        content: source.to_string(),
                    });
                }
                ordinal += 1;
                fence = None;
            } else {
                content.push_str(line);
                content.push('\n');
            }
            continue;
        }
        if let Some(marker @ ('`' | '~')) = delimiter.chars().next() {
            let count = delimiter.chars().take_while(|ch| *ch == marker).count();
            if count >= 3 {
                fence = Some((
                    marker,
                    count,
                    delimiter[count..]
                        .trim()
                        .strip_suffix(" vibe-artifact")
                        .unwrap_or_default()
                        .to_ascii_lowercase(),
                    String::new(),
                ));
                continue;
            }
        }
        if line.trim_start().starts_with('>') || line.starts_with("    ") || line.starts_with('\t')
        {
            continue;
        }
        for cap in LINK.captures_iter(line.trim()) {
            let target = cap.get(1).or_else(|| cap.get(2)).unwrap().as_str();
            if target.starts_with("https://") || target.starts_with("http://") {
                candidates.push(ArtifactCandidate::Url(target.to_string()));
            } else if !target.contains("://")
                && !target.starts_with('#')
                && !target.starts_with("data:")
            {
                let target = target.split(['#', '?']).next().unwrap_or_default();
                if let Some(path) = decode_file_reference(&FILE_LINE.replace(target, "")) {
                    candidates.push(ArtifactCandidate::File(path));
                }
            }
        }
    }
    if let Some((_, _, language, content)) = fence {
        let extension = match language.as_str() {
            "mermaid" => Some("mmd"),
            "html" | "htm"
                if content
                    .trim_start()
                    .to_ascii_lowercase()
                    .starts_with("<html")
                    || content
                        .trim_start()
                        .to_ascii_lowercase()
                        .starts_with("<!doctype html") =>
            {
                Some("html")
            }
            "svg" | "xml" if svg_root(content.trim_start()).starts_with("<svg") => Some("svg"),
            _ => None,
        };
        if let Some(extension) = extension {
            candidates.push(ArtifactCandidate::PreparingInline {
                name: format!("block-{ordinal}.{extension}"),
            });
        }
    }
    candidates
}

pub fn entry_candidates(entry: &NormalizedEntry) -> Vec<ArtifactCandidate> {
    match &entry.entry_type {
        NormalizedEntryType::AssistantMessage => markdown_candidates(&entry.content),
        _ => Vec::new(),
    }
}

/// Discovery only: browser parsing/rewrite and CSP enforce the preview boundary.
/// Unknown URL syntax is reported by the viewer, never fetched by the server.
pub fn static_references(name: &str, text: &str) -> Vec<String> {
    static HTML: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)\b(?:src|href)\s*=\s*(?:\"([^\"]+)\"|'([^']+)'|([^\s>]+))"#).unwrap()
    });
    static CSS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)(?:url\(\s*|@import\s+)(?:\"([^\"]+)\"|'([^']+)'|([^\s)]+))"#).unwrap()
    });
    let regexes = if name.to_ascii_lowercase().ends_with(".css") {
        vec![&*CSS]
    } else {
        vec![&*HTML, &*CSS]
    };
    regexes
        .into_iter()
        .flat_map(|regex| {
            regex.captures_iter(text).filter_map(|cap| {
                cap.get(1)
                    .or_else(|| cap.get(2))
                    .or_else(|| cap.get(3))
                    .map(|value| value.as_str().to_string())
            })
        })
        .take(128)
        .collect()
}

pub fn decode_file_reference(path: &str) -> Option<String> {
    percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .ok()
        .map(|path| path.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_attachment_lines_are_registered() {
        let text = r#"[source](src/main.rs)
https://example.com/reference
`[example](secret.txt "vibe-artifact")`
> [quote](secret.txt "vibe-artifact")
    [indented](secret.txt "vibe-artifact")
```markdown
[example](secret.txt "vibe-artifact")
```
  ```markdown
[example](secret.txt "vibe-artifact")
  ```
[report](<reports/a b.html> "vibe-artifact")
- [diagram](reports/diagram.mmd "vibe-artifact")
[site](https://example.com/report "vibe-artifact")
"#;
        assert_eq!(
            markdown_candidates(text),
            vec![
                ArtifactCandidate::File("reports/a b.html".into()),
                ArtifactCandidate::File("reports/diagram.mmd".into()),
                ArtifactCandidate::Url("https://example.com/report".into()),
            ]
        );
        assert!(markdown_candidates(r#"[bad](file:///etc/passwd "vibe-artifact")"#).is_empty());
        assert!(markdown_candidates(r#"[partial](report.html "vibe-artifact""#).is_empty());
        assert_eq!(
            markdown_candidates(
                "[report](reports/a%20b.html#L4 \"vibe-artifact\")\n[source](reports/a%20b.html:4:2 \"vibe-artifact\")"
            ),
            vec![ArtifactCandidate::File("reports/a b.html".into()); 2],
        );
    }

    #[test]
    fn inline_outputs_require_an_explicit_fence_marker() {
        let text = "```mermaid\ngraph TD\nX-->Y\n```\n```mermaid vibe-artifact\ngraph TD\nA-->B\n```\n```html vibe-artifact\n<html>unfinished";
        assert_eq!(
            markdown_candidates(text),
            vec![
                ArtifactCandidate::Inline {
                    name: "block-1.mmd".into(),
                    content: "graph TD\nA-->B".into(),
                },
                ArtifactCandidate::PreparingInline {
                    name: "block-2.html".into()
                },
            ]
        );
        for svg in [
            "<svg/>",
            "<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
        ] {
            assert!(markdown_candidates(&format!("```svg\n{svg}\n```")).is_empty());
            assert!(
                matches!(&markdown_candidates(&format!("```svg vibe-artifact\n{svg}\n```"))[0], ArtifactCandidate::Inline { name, .. } if name.ends_with(".svg"))
            );
        }
        assert!(markdown_candidates("```svg vibe-artifact\n<svg><path/>\n```").is_empty());
    }

    #[test]
    fn tools_cannot_publish_even_when_their_output_contains_attachment_markers() {
        use crate::logs::{ActionType, ToolStatus};
        let mut entry = NormalizedEntry {
            timestamp: None,
            metadata: None,
            content: "[report](report.html \"vibe-artifact\")".into(),
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "Read".into(),
                status: ToolStatus::Success,
                action_type: ActionType::FileRead {
                    path: "report.html".into(),
                },
            },
        };
        assert!(entry_candidates(&entry).is_empty());
        entry.entry_type = NormalizedEntryType::AssistantMessage;
        assert_eq!(
            entry_candidates(&entry),
            vec![ArtifactCandidate::File("report.html".into())]
        );
    }
}
