//! Executor-independent candidates. These are untrusted references, never file permissions.
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{ActionType, NormalizedEntry, NormalizedEntryType, ToolStatus};

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

static LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+\"[^\"\n]*\")?\s*\)"#).unwrap()
});
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"https?://[^\s<>\"'`)\]]+"#).unwrap());
static FILE_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?::[0-9]+){1,2}$").unwrap());

/// Only complete top-level fences are candidates. Quoted examples and diff
/// bodies stay source text; no shell-command parsing or recursive JSON search.
pub fn markdown_candidates(text: &str) -> Vec<ArtifactCandidate> {
    let mut candidates = Vec::new();
    let mut fence: Option<(char, usize, String, String)> = None;
    let mut ordinal = 0;
    for line in text.lines() {
        if let Some((marker, count, language, content)) = fence.as_mut() {
            if line.chars().take_while(|ch| ch == marker).count() >= *count
                && line.trim_end_matches(*marker).trim().is_empty()
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
                    "svg" | "xml" if lower.starts_with("<svg") && lower.ends_with("</svg>") => {
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
        if let Some(marker @ ('`' | '~')) = line.chars().next() {
            let count = line.chars().take_while(|ch| *ch == marker).count();
            if count >= 3 {
                fence = Some((
                    marker,
                    count,
                    line[count..].trim().to_ascii_lowercase(),
                    String::new(),
                ));
                continue;
            }
        }
        if line.starts_with('>') || line.starts_with("    ") {
            continue;
        }
        for cap in LINK.captures_iter(line) {
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
        for url in URL.find_iter(line) {
            candidates.push(ArtifactCandidate::Url(
                url.as_str().trim_end_matches(['.', ',', ';']).to_string(),
            ));
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
            "svg" if content.trim_start().starts_with("<svg") => Some("svg"),
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

fn result_candidates(value: &serde_json::Value) -> Vec<ArtifactCandidate> {
    if let Some(text) = value.as_str() {
        return markdown_candidates(text);
    }
    let blocks = value
        .as_array()
        .or_else(|| value.get("content").and_then(|v| v.as_array()));
    let mut candidates = Vec::new();
    if let Some(url) = value.get("url").and_then(|value| value.as_str())
        && (url.starts_with("https://") || url.starts_with("http://"))
    {
        candidates.push(ArtifactCandidate::Url(url.to_string()));
    }
    for (index, block) in blocks.into_iter().flatten().enumerate() {
        match block.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    candidates.extend(markdown_candidates(text));
                }
            }
            Some("resource_link") => {
                if let Some(uri) = block.get("uri").and_then(|v| v.as_str())
                    && (uri.starts_with("https://") || uri.starts_with("http://"))
                {
                    candidates.push(ArtifactCandidate::Url(uri.to_string()));
                }
            }
            Some("resource") => {
                let resource = &block["resource"];
                let extension = match resource.get("mimeType").and_then(|value| value.as_str()) {
                    Some("text/html") => Some("html"),
                    Some("image/svg+xml") => Some("svg"),
                    Some("text/vnd.mermaid") => Some("mmd"),
                    Some("text/markdown") => Some("md"),
                    _ => None,
                };
                if let Some(extension) = extension
                    && let Some(content) = resource.get("text").and_then(|value| value.as_str())
                {
                    candidates.push(ArtifactCandidate::Inline {
                        name: format!("resource-{index}.{extension}"),
                        content: content.to_string(),
                    });
                }
            }
            _ => {}
        }
    }
    candidates
}

pub fn entry_candidates(entry: &NormalizedEntry) -> Vec<ArtifactCandidate> {
    match &entry.entry_type {
        NormalizedEntryType::AssistantMessage => markdown_candidates(&entry.content),
        NormalizedEntryType::ToolUse {
            action_type,
            status,
            ..
        } => {
            if !matches!(status, ToolStatus::Success) {
                return Vec::new();
            }
            match action_type {
                ActionType::FileRead { path }
                | ActionType::FileEdit { path, .. }
                | ActionType::ImageView { path } => vec![ArtifactCandidate::File(path.clone())],
                ActionType::Tool {
                    result: Some(result),
                    ..
                } => result_candidates(&result.value),
                ActionType::CommandRun {
                    result: Some(result),
                    ..
                } => result
                    .output
                    .as_deref()
                    .map(markdown_candidates)
                    .unwrap_or_default(),
                _ => Vec::new(),
            }
        }
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
    fn detects_complete_output_without_executing_examples_or_partial_fences() {
        let output = "[report](reports/a.html)\n```mermaid\ngraph TD\nA-->B\n```\n> [quote](secret.txt)\n```diff\n+ [example](secret.txt)\n```\n```html\n<html>unfinished";
        assert_eq!(
            markdown_candidates(output),
            vec![
                ArtifactCandidate::File("reports/a.html".into()),
                ArtifactCandidate::Inline {
                    name: "block-0.mmd".into(),
                    content: "graph TD\nA-->B".into()
                },
                ArtifactCandidate::PreparingInline {
                    name: "block-2.html".into()
                },
            ]
        );
        assert!(markdown_candidates("[bad](file:///etc/passwd)").is_empty());
        assert_eq!(
            markdown_candidates("[report](reports/a%20b.html#L4) [source](reports/a%20b.html:4:2)"),
            vec![
                ArtifactCandidate::File("reports/a b.html".into()),
                ArtifactCandidate::File("reports/a b.html".into())
            ]
        );
    }
}
