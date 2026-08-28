//! Persist agent-produced images (base64 tool results, data URLs) into the
//! workspace's `.vibe-attachments/` dir so chat can reference them by a stable
//! workspace-relative path instead of inline base64 or one-off blob URLs.

use std::path::Path;

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use sha2::{Digest, Sha256};
use workspace_utils::path::VIBE_ATTACHMENTS_DIR;

/// Hard cap so a malformed/hostile log line cannot fill the disk.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// Extensions the chat renders inline. Mirrors the server-side safe-inline
/// MIME allowlist (SVG intentionally excluded: scripts).
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff",
];

pub fn is_image_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn extension_for_image_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        _ => None,
    }
}

/// Split a `data:image/png;base64,...` URL into (mime, payload).
pub fn parse_image_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?;
    Some((mime, payload))
}

/// Decode a base64 image and store it under `<worktree>/.vibe-attachments/`.
/// Returns the workspace-relative path (`.vibe-attachments/agent-<hash>.<ext>`).
/// Content-hash naming makes replays and re-normalization idempotent.
pub fn store_base64_image(worktree_path: &str, mime: &str, data: &str) -> Option<String> {
    if worktree_path.is_empty() {
        return None;
    }
    let ext = extension_for_image_mime(mime)?;
    let bytes = BASE64.decode(data.trim()).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }

    let digest = format!("{:x}", Sha256::digest(&bytes));
    let file_name = format!("agent-{}.{ext}", &digest[..16]);
    let dir = Path::new(worktree_path).join(VIBE_ATTACHMENTS_DIR);
    let file_path = dir.join(&file_name);
    if !file_path.exists() {
        std::fs::create_dir_all(&dir).ok()?;
        // Same convention as FileService::copy_files: keep attachments out of git.
        let gitignore = dir.join(".gitignore");
        if !gitignore.exists() {
            let _ = std::fs::write(&gitignore, "*\n");
        }
        std::fs::write(&file_path, &bytes).ok()?;
    }
    Some(format!("{VIBE_ATTACHMENTS_DIR}/{file_name}"))
}

/// Collect `{"type":"image","source":{"type":"base64","media_type":..,"data":..}}`
/// blocks from a tool-result content value (single block or array of blocks).
pub fn extract_base64_image_blocks(content: &serde_json::Value) -> Vec<(String, String)> {
    fn from_block(block: &serde_json::Value) -> Option<(String, String)> {
        if block.get("type")?.as_str()? != "image" {
            return None;
        }
        let source = block.get("source")?;
        if source.get("type")?.as_str()? != "base64" {
            return None;
        }
        Some((
            source.get("media_type")?.as_str()?.to_string(),
            source.get("data")?.as_str()?.to_string(),
        ))
    }

    match content {
        serde_json::Value::Array(items) => items.iter().filter_map(from_block).collect(),
        block => from_block(block).into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 1x1 transparent PNG
    const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    #[test]
    fn image_path_detection() {
        assert!(is_image_path("shots/a.PNG"));
        assert!(is_image_path(".vibe-attachments/agent-abc.webp"));
        assert!(!is_image_path("src/main.rs"));
        assert!(!is_image_path("no_extension"));
    }

    #[test]
    fn parses_data_url() {
        let (mime, data) = parse_image_data_url("data:image/png;base64,AAAA").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(data, "AAAA");
        assert!(parse_image_data_url("https://example.com/x.png").is_none());
        assert!(parse_image_data_url("data:image/png,rawdata").is_none());
    }

    #[test]
    fn stores_base64_image_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().to_str().unwrap();

        let rel = store_base64_image(worktree, "image/png", PNG_B64).unwrap();
        assert!(rel.starts_with(".vibe-attachments/agent-"));
        assert!(rel.ends_with(".png"));
        let stored = dir.path().join(&rel);
        assert!(stored.is_file());
        assert!(dir.path().join(".vibe-attachments/.gitignore").is_file());

        // Same content → same path, no duplicate files.
        let rel2 = store_base64_image(worktree, "image/png", PNG_B64).unwrap();
        assert_eq!(rel, rel2);
        let entries = std::fs::read_dir(dir.path().join(".vibe-attachments"))
            .unwrap()
            .count();
        assert_eq!(entries, 2); // image + .gitignore
    }

    #[test]
    fn rejects_bad_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().to_str().unwrap();
        assert!(store_base64_image(worktree, "image/svg+xml", PNG_B64).is_none());
        assert!(store_base64_image(worktree, "image/png", "!!!notbase64!!!").is_none());
        assert!(store_base64_image("", "image/png", PNG_B64).is_none());
    }

    #[test]
    fn extracts_image_blocks() {
        let content = serde_json::json!([
            {"type": "text", "text": "took a screenshot"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}},
            {"type": "image", "source": {"type": "url", "url": "https://x/y.png"}},
        ]);
        let blocks = extract_base64_image_blocks(&content);
        assert_eq!(blocks, vec![("image/png".to_string(), "AAAA".to_string())]);
        assert!(extract_base64_image_blocks(&serde_json::json!("plain text")).is_empty());
    }
}
