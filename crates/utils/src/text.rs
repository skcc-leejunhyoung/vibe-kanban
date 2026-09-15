use regex::Regex;
use uuid::Uuid;

/// Max length (in chars) of the slug derived from a title for a branch name.
/// Not a git limit (git only bounds branch names by the filesystem's ~255-byte
/// filename limit) — just a cap to keep generated names readable. The frontend
/// `gitBranchId` mirrors this so previews match the backend name exactly.
pub const MAX_BRANCH_SLUG_CHARS: usize = 40;

pub fn git_branch_id(input: &str) -> String {
    // 1. lowercase
    let lower = input.to_lowercase();

    // 2. collapse runs of unsupported characters into a single hyphen.
    //    `\p{L}`/`\p{N}` keep all Unicode letters and digits (e.g. Hangul,
    //    Kana, accented Latin) so non-ASCII titles survive instead of being
    //    wiped out. Everything `git check-ref-format` forbids — spaces,
    //    `~^:?*[\`, `/`, `.`, control chars — is non-alphanumeric and so
    //    collapses to a hyphen here.
    let re = Regex::new(r"[^\p{L}\p{N}]+").unwrap();
    let slug = re.replace_all(&lower, "-");

    // 3. trim extra hyphens
    let trimmed = slug.trim_matches('-');

    // 4. take up to MAX_BRANCH_SLUG_CHARS chars, then trim trailing hyphens again
    let cut: String = trimmed.chars().take(MAX_BRANCH_SLUG_CHARS).collect();
    cut.trim_end_matches('-').to_string()
}

pub fn short_uuid(u: &Uuid) -> String {
    // to_simple() gives you a 32-char hex string with no hyphens
    let full = u.simple().to_string();
    full.chars().take(4).collect() // grab the first 4 chars
}

pub fn truncate_to_char_boundary(content: &str, max_len: usize) -> &str {
    if content.len() <= max_len {
        return content;
    }

    let cutoff = content
        .char_indices()
        .map(|(idx, _)| idx)
        .chain(std::iter::once(content.len()))
        .take_while(|&idx| idx <= max_len)
        .last()
        .unwrap_or(0);

    debug_assert!(content.is_char_boundary(cutoff));
    &content[..cutoff]
}

/// Incremental UTF-8 decoder for byte streams that can split anywhere.
///
/// Decoding each chunk on its own with [`String::from_utf8_lossy`] turns a
/// multi-byte character straddling a chunk boundary into U+FFFD permanently —
/// agent stdout is read in arbitrary-sized chunks, so non-ASCII output gets
/// corrupted at every boundary it happens to land on. This holds an incomplete
/// trailing sequence (never more than 3 bytes) back until the next chunk
/// completes it. Bytes that are genuinely invalid UTF-8 are still replaced.
///
/// Bytes still held when the stream ends belong to a truncated character that
/// has no correct rendering, so they are dropped rather than emitted as U+FFFD.
#[derive(Debug, Default)]
pub struct Utf8Decoder {
    carry: Vec<u8>,
}

impl Utf8Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode `chunk`, prefixed by whatever was held back from the last call.
    pub fn push(&mut self, chunk: &[u8]) -> String {
        if self.carry.is_empty() && chunk.is_empty() {
            return String::new();
        }
        self.carry.extend_from_slice(chunk);
        let buf = std::mem::take(&mut self.carry);

        // Step over complete sequences — valid or not — to find where an
        // incomplete trailing one begins, if there is one at all.
        let mut at = 0;
        let keep = loop {
            match std::str::from_utf8(&buf[at..]) {
                Ok(_) => break buf.len(),
                Err(e) => match e.error_len() {
                    // Complete but invalid: `from_utf8_lossy` replaces it below.
                    Some(n) => at += e.valid_up_to() + n,
                    // Truncated tail: wait for the bytes that finish it.
                    None => break at + e.valid_up_to(),
                },
            }
        };

        self.carry.extend_from_slice(&buf[keep..]);
        String::from_utf8_lossy(&buf[..keep]).into_owned()
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn test_git_branch_id() {
        use super::git_branch_id;

        // ASCII titles behave as before (lowercase, hyphenated), now capped at
        // MAX_BRANCH_SLUG_CHARS so typical titles survive in full.
        assert_eq!(git_branch_id("Fix the login bug"), "fix-the-login-bug");

        // Titles longer than the cap are truncated at the char boundary.
        assert_eq!(
            git_branch_id("Fix the intermittent login bug on the settings page"),
            "fix-the-intermittent-login-bug-on-the-se"
        );

        // Hangul titles are preserved instead of collapsing to an empty slug.
        assert_eq!(git_branch_id("로그인 버그 수정"), "로그인-버그-수정");

        // Mixed scripts keep both, and git-illegal punctuation is stripped.
        assert_eq!(git_branch_id("버그 fix #123!"), "버그-fix-123");

        // Characters git refs forbid collapse to single hyphens.
        assert_eq!(git_branch_id("a~b:c?d*e"), "a-b-c-d-e");

        // Symbol-only titles still yield an empty slug (caller adds a prefix).
        assert_eq!(git_branch_id("!@#$%"), "");
    }

    #[test]
    fn test_truncate_to_char_boundary() {
        use super::truncate_to_char_boundary;

        let input = "a".repeat(10);
        assert_eq!(truncate_to_char_boundary(&input, 7), "a".repeat(7));

        let input = "hello world";
        assert_eq!(truncate_to_char_boundary(input, input.len()), input);

        let input = "🔥🔥🔥"; // each fire emoji is 4 bytes
        assert_eq!(truncate_to_char_boundary(input, 5), "🔥");
        assert_eq!(truncate_to_char_boundary(input, 3), "");
    }
}

#[cfg(test)]
mod utf8_decoder_tests {
    use super::Utf8Decoder;

    /// The real failure: a 3-byte Hangul syllable cut by a read boundary.
    /// Decoding each half on its own yields two U+FFFD instead of the char.
    #[test]
    fn character_split_across_chunks_survives() {
        let bytes = "검증했습니다".as_bytes();
        let (head, tail) = bytes.split_at(4); // mid-way through '증'
        assert!(String::from_utf8_lossy(head).contains('\u{FFFD}'));

        let mut dec = Utf8Decoder::new();
        let out = dec.push(head) + &dec.push(tail);
        assert_eq!(out, "검증했습니다");
    }

    /// Every split position of a mixed-script string must reassemble exactly,
    /// including a byte-at-a-time feed.
    #[test]
    fn all_split_positions_reassemble_exactly() {
        let text = "검증 ok 🎉 한글 mixed ascii ünïcode";
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            let mut dec = Utf8Decoder::new();
            let out = dec.push(&bytes[..cut]) + &dec.push(&bytes[cut..]);
            assert_eq!(out, text, "split at {cut}");
        }

        let mut dec = Utf8Decoder::new();
        let out: String = bytes.iter().map(|b| dec.push(&[*b])).collect();
        assert_eq!(out, text, "byte-at-a-time");
    }

    /// Genuinely invalid bytes are still replaced, and a truncated tail in the
    /// same buffer is still carried rather than swallowed by the first error.
    #[test]
    fn invalid_bytes_replaced_and_trailing_tail_still_carried() {
        let mut dec = Utf8Decoder::new();
        let mut buf = vec![b'a', 0xFF, b'b'];
        buf.extend_from_slice(&"증".as_bytes()[..2]);
        let first = dec.push(&buf);
        assert_eq!(first, "a\u{FFFD}b");
        assert_eq!(dec.push(&"증".as_bytes()[2..]), "증");
    }

    /// The carry is an incomplete sequence, so it can never grow past 3 bytes
    /// no matter how the stream is chopped.
    #[test]
    fn carry_stays_bounded() {
        let mut dec = Utf8Decoder::new();
        for _ in 0..1000 {
            dec.push("🎉한글".as_bytes());
            dec.push(&[0xF0]); // lone lead byte
            assert!(dec.carry.len() <= 3, "carry grew to {}", dec.carry.len());
        }
    }

    /// A stream ending mid-character drops the truncated bytes instead of
    /// rendering them as U+FFFD.
    #[test]
    fn truncated_tail_at_end_of_stream_is_dropped() {
        let mut dec = Utf8Decoder::new();
        let bytes = "ab증".as_bytes();
        assert_eq!(dec.push(&bytes[..3]), "ab");
        assert!(!dec.carry.is_empty());
    }
}
