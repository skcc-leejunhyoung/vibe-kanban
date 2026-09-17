//! Persist agent-produced images (base64 tool results, data URLs) into the
//! workspace's `.vibe-attachments/` dir so chat can reference them by a stable
//! workspace-relative path instead of inline base64 or one-off blob URLs.

use std::{fs::OpenOptions, io::Write, path::Path};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use sha2::{Digest, Sha256};
use workspace_utils::path::{VIBE_ATTACHMENTS_DIR, agent_image_cache_dir, make_path_relative};

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
    if data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 + 4 {
        return None;
    }
    let bytes = BASE64.decode(data.trim()).ok()?;
    let file_name = image_file_name(ext, &bytes)?;
    let dir = std::fs::canonicalize(worktree_path)
        .ok()?
        .join(VIBE_ATTACHMENTS_DIR);
    std::fs::create_dir_all(&dir).ok()?;
    // The managed directory is never a link supplied by a workspace file.
    if std::fs::canonicalize(&dir).ok()? != dir {
        return None;
    }
    write_image_file(&dir, &file_name, &bytes)?;
    // Never follow or overwrite a workspace-supplied .gitignore symlink.
    if let Ok(mut file) = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join(".gitignore"))
    {
        let _ = file.write_all(b"*\n");
    }
    Some(format!("{VIBE_ATTACHMENTS_DIR}/{file_name}"))
}

/// Cache an image file the agent viewed from outside the workspace, so chat can
/// serve it without an absolute path. The copy goes to the app cache rather
/// than into the worktree: checkouts stay clean and the copy outlives the
/// worktree. The returned path is virtual — `serve_workspace_image` falls back
/// to the cache when the worktree has no such file.
pub fn import_image_file(path: &str) -> Option<String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .filter(|ext| IMAGE_EXTENSIONS.contains(&ext.as_str()))?;
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES as u64 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    import_image_bytes_into(&agent_image_cache_dir(), &ext, &bytes)
}

/// Workspace-relative path for an image the agent viewed, so chat renders it
/// inline instead of degrading to a plain tool row. Out-of-workspace images are
/// cached outside the worktree; when that fails the caller-visible path is
/// returned unchanged.
///
/// Normalization re-runs from the raw log on every replay of a finished process
/// (results are only cached in memory), and the import re-reads the original
/// file, so an out-of-workspace image deleted after the run stops rendering once
/// that cache goes cold. Persisting normalized patches would settle it.
pub fn viewed_image_path(worktree_path: &str, raw_path: &str) -> String {
    let relative = make_path_relative(raw_path, worktree_path);
    if Path::new(&relative).is_absolute()
        && let Some(imported) = import_image_file(&relative)
    {
        return imported;
    }
    relative
}

/// Split out so tests can direct the cache somewhere hermetic.
fn import_image_bytes_into(dir: &Path, ext: &str, bytes: &[u8]) -> Option<String> {
    let file_name = image_file_name(ext, bytes)?;
    std::fs::create_dir_all(dir).ok()?;
    let dir = std::fs::canonicalize(dir).ok()?;
    write_image_file(&dir, &file_name, bytes)?;
    Some(format!("{VIBE_ATTACHMENTS_DIR}/{file_name}"))
}

/// Content-hash name, so replays and re-normalization are idempotent.
fn image_file_name(ext: &str, bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    Some(format!("agent-{}.{ext}", &digest[..16]))
}

fn write_image_file(dir: &Path, file_name: &str, bytes: &[u8]) -> Option<()> {
    let file_path = dir.join(file_name);
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file_path)
    {
        // A partial write would be served as a valid cache hit forever, so
        // drop the stub and let the next call retry.
        Ok(mut file) => match file.write_all(bytes) {
            Ok(()) => {}
            Err(_) => {
                let _ = std::fs::remove_file(&file_path);
                return None;
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if !std::fs::symlink_metadata(&file_path)
                .ok()?
                .file_type()
                .is_file()
            {
                return None;
            }
        }
        Err(_) => return None,
    }
    (std::fs::canonicalize(&file_path).ok()? == file_path).then_some(())
}

/// Collect `{"type":"image","source":{"type":"base64","media_type":..,"data":..}}`
/// blocks from a tool-result content value (single block or array of blocks).
pub fn extract_base64_image_blocks(content: &serde_json::Value) -> Vec<(String, String)> {
    fn from_block(block: &serde_json::Value) -> Option<(String, String)> {
        if block.get("type")?.as_str()? != "image" {
            return None;
        }
        if let (Some(mime), Some(data)) = (
            block.get("mimeType").and_then(|v| v.as_str()),
            block.get("data").and_then(|v| v.as_str()),
        ) {
            return Some((mime.to_string(), data.to_string()));
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
    fn caches_out_of_workspace_viewed_image_outside_the_worktree() {
        use base64::Engine;

        let worktree = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let png = BASE64.decode(PNG_B64).unwrap();
        std::fs::write(outside.path().join("shot.png"), &png).unwrap();
        let worktree_str = worktree.path().to_str().unwrap();

        // Out-of-workspace image lands in the cache, never in the worktree.
        let rel = import_image_bytes_into(cache.path(), "png", &png).unwrap();
        assert!(rel.starts_with(".vibe-attachments/agent-"), "{rel}");
        let name = rel.strip_prefix(".vibe-attachments/").unwrap();
        assert_eq!(std::fs::read(cache.path().join(name)).unwrap(), png);
        assert!(!worktree.path().join(VIBE_ATTACHMENTS_DIR).exists());

        // Same virtual path via the real entry point, and still no worktree dir.
        let viewed = viewed_image_path(
            worktree_str,
            outside.path().join("shot.png").to_str().unwrap(),
        );
        assert_eq!(viewed, rel);
        assert!(!worktree.path().join(VIBE_ATTACHMENTS_DIR).exists());

        // In-workspace images keep their relative path (no copy).
        std::fs::write(worktree.path().join("in.png"), &png).unwrap();
        let inside = worktree.path().join("in.png");
        assert_eq!(
            viewed_image_path(worktree_str, inside.to_str().unwrap()),
            "in.png"
        );

        // Unservable paths are returned untouched: chat falls back to a text row.
        let missing = outside.path().join("gone.png");
        let missing_str = missing.to_str().unwrap();
        assert_eq!(viewed_image_path(worktree_str, missing_str), missing_str);
    }

    #[test]
    fn rejects_bad_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().to_str().unwrap();
        assert!(store_base64_image(worktree, "image/svg+xml", PNG_B64).is_none());
        assert!(store_base64_image(worktree, "image/png", "!!!notbase64!!!").is_none());
        assert!(store_base64_image("", "image/png", PNG_B64).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_workspace_symlinks_when_storing_tool_images() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let managed = root.path().join(VIBE_ATTACHMENTS_DIR);
        symlink(outside.path(), &managed).unwrap();
        assert!(store_base64_image(root.path().to_str().unwrap(), "image/png", PNG_B64).is_none());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
        std::fs::remove_file(&managed).unwrap();
        std::fs::create_dir(&managed).unwrap();
        let target = outside.path().join("untouched");
        std::fs::write(&target, "original").unwrap();
        symlink(&target, managed.join(".gitignore")).unwrap();
        let path = store_base64_image(root.path().to_str().unwrap(), "image/png", PNG_B64).unwrap();
        std::fs::remove_file(root.path().join(&path)).unwrap();
        symlink(&target, root.path().join(path)).unwrap();
        assert!(store_base64_image(root.path().to_str().unwrap(), "image/png", PNG_B64).is_none());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "original");
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
