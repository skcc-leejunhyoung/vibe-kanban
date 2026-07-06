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
