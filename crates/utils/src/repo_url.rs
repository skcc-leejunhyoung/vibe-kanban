//! Repository identity from git remote and PR URLs, so a PR can be matched to
//! the local clone it belongs to (HTTPS, SSH and Azure DevOps forms alike).

/// `host/owner/repo` (lowercase, no `.git`) for a remote or repository URL.
pub fn normalized_repo_key(url: &str) -> String {
    let mut normalized = if let Ok(url) = url::Url::parse(url.trim()) {
        format!(
            "{}/{}",
            url.host_str().unwrap_or_default().to_ascii_lowercase(),
            url.path().trim_matches('/')
        )
    } else if let Some((host, path)) = url.trim().split_once(':') {
        format!(
            "{}/{}",
            host.rsplit('@').next().unwrap_or(host).to_ascii_lowercase(),
            path.trim_matches('/')
        )
    } else {
        url.trim_matches('/').to_string()
    };
    if let Some(path) = normalized.strip_prefix("ssh.dev.azure.com/v3/") {
        let mut parts = path.split('/');
        if let (Some(org), Some(project), Some(repo)) = (parts.next(), parts.next(), parts.next()) {
            normalized = format!("dev.azure.com/{org}/{project}/_git/{repo}");
        }
    } else if let Some(path) = normalized.strip_prefix("vs-ssh.visualstudio.com/v3/") {
        let mut parts = path.split('/');
        if let (Some(org), Some(project), Some(repo)) = (parts.next(), parts.next(), parts.next()) {
            normalized = format!("dev.azure.com/{org}/{project}/_git/{repo}");
        }
    }
    if let Some((org, path)) = normalized.split_once(".visualstudio.com/") {
        normalized = format!("dev.azure.com/{org}/{path}");
    }
    normalized
        .strip_suffix(".git")
        .unwrap_or(&normalized)
        .to_ascii_lowercase()
}

/// The [`normalized_repo_key`] of the repository a PR URL points into.
pub fn pr_repo_key(url: &str) -> Option<String> {
    let normalized = normalized_repo_key(url);
    ["/pull/", "/pullrequest/"].into_iter().find_map(|marker| {
        normalized
            .rsplit_once(marker)
            .map(|(repo, _)| repo.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pr_urls_match_https_and_ssh_repository_remotes() {
        assert_eq!(
            pr_repo_key("https://github.com/Acme/Widgets/pull/42").as_deref(),
            Some(normalized_repo_key("git@github.com:acme/widgets.git").as_str())
        );
        assert_eq!(
            pr_repo_key("https://dev.azure.com/acme/project/_git/widgets/pullrequest/42")
                .as_deref(),
            Some(normalized_repo_key("git@ssh.dev.azure.com:v3/acme/project/widgets").as_str())
        );
        assert_eq!(
            pr_repo_key("https://dev.azure.com/acme/project/_git/widgets/pullrequest/42")
                .as_deref(),
            Some(
                normalized_repo_key("acme@vs-ssh.visualstudio.com:v3/acme/project/widgets")
                    .as_str()
            )
        );
        assert_eq!(
            pr_repo_key("https://acme.visualstudio.com/project/_git/widgets/pullrequest/42")
                .as_deref(),
            Some(normalized_repo_key("https://dev.azure.com/acme/project/_git/widgets").as_str())
        );
        assert_ne!(
            pr_repo_key("https://github.com/acme/other/pull/42").as_deref(),
            Some(normalized_repo_key("https://github.com/acme/widgets").as_str())
        );
    }
}
