/// Yield each line and whether it is outside a fenced code block.
pub fn lines_outside_fences(markdown: &str) -> impl Iterator<Item = (&str, bool)> {
    let mut fence: Option<(u8, usize)> = None;
    markdown.lines().map(move |line| {
        let outside = fence.is_none();
        let trimmed = line.trim_start_matches(' ');
        if line.len() - trimmed.len() <= 3 {
            let bytes = trimmed.as_bytes();
            if let Some(&marker @ (b'`' | b'~')) = bytes.first() {
                let count = bytes.iter().take_while(|&&b| b == marker).count();
                let rest = &trimmed[count..];
                match fence {
                    Some((open_marker, open_count))
                        if marker == open_marker
                            && count >= open_count
                            && rest.trim().is_empty() =>
                    {
                        fence = None;
                    }
                    None if count >= 3 && (marker != b'`' || !rest.contains('`')) => {
                        fence = Some((marker, count));
                    }
                    _ => {}
                }
            }
        }
        (line, outside)
    })
}

pub fn fences_closed(markdown: &str) -> bool {
    lines_outside_fences(&format!("{markdown}\n\n"))
        .last()
        .is_none_or(|(_, outside)| outside)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_fences_with_matching_marker_and_minimum_length() {
        let input =
            "## One\n ````md\n## inside\n```\n~~~\n ````\n## Two\n~~~sh\n## hidden\n~~~\n## Three";
        let headings = lines_outside_fences(input)
            .filter_map(|(line, outside)| outside.then(|| line.strip_prefix("## ")).flatten())
            .collect::<Vec<_>>();
        assert_eq!(headings, ["One", "Two", "Three"]);
        assert!(fences_closed(input));
        assert!(!fences_closed("## One\n```\n## hidden"));
        assert!(!fences_closed("## One\n```"));
    }
}
