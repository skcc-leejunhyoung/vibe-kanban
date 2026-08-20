use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use super::merge::{Merge, MergeStatus, PrMerge, PullRequestInfo};

#[derive(Debug, Clone, FromRow)]
pub struct PullRequest {
    pub id: String,
    pub workspace_id: Option<Uuid>,
    pub repo_id: Option<Uuid>,
    pub pr_url: String,
    pub pr_number: i64,
    pub pr_status: MergeStatus,
    pub target_branch_name: String,
    /// The PR's head (source) branch. `None` means the workspace's work branch
    /// (legacy rows), matching the original behavior where every PR's head was
    /// `workspace.branch`.
    pub head_branch_name: Option<String>,
    pub merged_at: Option<DateTime<Utc>>,
    pub merge_commit_sha: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub synced_at: Option<DateTime<Utc>>,
}

impl PullRequest {
    pub async fn create(
        pool: &SqlitePool,
        workspace_id: Option<Uuid>,
        repo_id: Option<Uuid>,
        pr_url: &str,
        pr_number: i64,
        target_branch_name: &str,
        head_branch_name: Option<&str>,
    ) -> Result<PullRequest, sqlx::Error> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        sqlx::query!(
            "INSERT INTO pull_requests (id, workspace_id, repo_id, pr_url, pr_number, pr_status, target_branch_name, head_branch_name, created_at)
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)
            ON CONFLICT(pr_url) DO UPDATE SET
                workspace_id = COALESCE(pull_requests.workspace_id, excluded.workspace_id),
                repo_id = COALESCE(pull_requests.repo_id, excluded.repo_id),
                head_branch_name = COALESCE(pull_requests.head_branch_name, excluded.head_branch_name),
                updated_at = CURRENT_TIMESTAMP",
            id,
            workspace_id,
            repo_id,
            pr_url,
            pr_number,
            target_branch_name,
            head_branch_name,
            now,
        )
        .execute(pool)
        .await?;

        let pr = Self::find_by_url(pool, pr_url)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        Ok(pr)
    }

    pub async fn create_for_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
        target_branch_name: &str,
        pr_number: i64,
        pr_url: &str,
        head_branch_name: Option<&str>,
    ) -> Result<PullRequest, sqlx::Error> {
        Self::create(
            pool,
            Some(workspace_id),
            Some(repo_id),
            pr_url,
            pr_number,
            target_branch_name,
            head_branch_name,
        )
        .await
    }

    pub async fn get_open(pool: &SqlitePool) -> Result<Vec<PullRequest>, sqlx::Error> {
        sqlx::query_as!(
            PullRequest,
            r#"SELECT
                id,
                workspace_id AS "workspace_id: Uuid",
                repo_id AS "repo_id: Uuid",
                pr_url,
                pr_number,
                pr_status AS "pr_status: MergeStatus",
                target_branch_name,
                head_branch_name,
                merged_at AS "merged_at: DateTime<Utc>",
                merge_commit_sha,
                created_at AS "created_at!: DateTime<Utc>",
                updated_at AS "updated_at!: DateTime<Utc>",
                synced_at AS "synced_at: DateTime<Utc>"
            FROM pull_requests
            WHERE pr_status = 'open'"#,
        )
        .fetch_all(pool)
        .await
    }

    /// PRs whose status is not yet terminal. `merged` is the only terminal
    /// state — a `closed` PR can still be reopened and merged on GitHub, so the
    /// monitor must keep polling it (otherwise a merge after close leaves the
    /// status stuck at `closed`).
    pub async fn get_unresolved(pool: &SqlitePool) -> Result<Vec<PullRequest>, sqlx::Error> {
        sqlx::query_as!(
            PullRequest,
            r#"SELECT
                id,
                workspace_id AS "workspace_id: Uuid",
                repo_id AS "repo_id: Uuid",
                pr_url,
                pr_number,
                pr_status AS "pr_status: MergeStatus",
                target_branch_name,
                head_branch_name,
                merged_at AS "merged_at: DateTime<Utc>",
                merge_commit_sha,
                created_at AS "created_at!: DateTime<Utc>",
                updated_at AS "updated_at!: DateTime<Utc>",
                synced_at AS "synced_at: DateTime<Utc>"
            FROM pull_requests
            WHERE pr_status != 'merged'"#,
        )
        .fetch_all(pool)
        .await
    }

    pub async fn update_status(
        pool: &SqlitePool,
        pr_url: &str,
        status: &MergeStatus,
        merged_at: Option<DateTime<Utc>>,
        merge_commit_sha: Option<String>,
    ) -> Result<(), sqlx::Error> {
        let status_str = match status {
            MergeStatus::Open => "open",
            MergeStatus::Merged => "merged",
            MergeStatus::Closed => "closed",
            MergeStatus::Unknown => "unknown",
        };
        let now = Utc::now();
        sqlx::query!(
            "UPDATE pull_requests SET pr_status = ?, merged_at = ?, merge_commit_sha = ?, updated_at = ?, synced_at = NULL WHERE pr_url = ?",
            status_str,
            merged_at,
            merge_commit_sha,
            now,
            pr_url,
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn find_by_url(
        pool: &SqlitePool,
        pr_url: &str,
    ) -> Result<Option<PullRequest>, sqlx::Error> {
        sqlx::query_as!(
            PullRequest,
            r#"SELECT
                id,
                workspace_id AS "workspace_id: Uuid",
                repo_id AS "repo_id: Uuid",
                pr_url,
                pr_number,
                pr_status AS "pr_status: MergeStatus",
                target_branch_name,
                head_branch_name,
                merged_at AS "merged_at: DateTime<Utc>",
                merge_commit_sha,
                created_at AS "created_at!: DateTime<Utc>",
                updated_at AS "updated_at!: DateTime<Utc>",
                synced_at AS "synced_at: DateTime<Utc>"
            FROM pull_requests
            WHERE pr_url = $1"#,
            pr_url,
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Vec<PullRequest>, sqlx::Error> {
        sqlx::query_as!(
            PullRequest,
            r#"SELECT
                id,
                workspace_id AS "workspace_id: Uuid",
                repo_id AS "repo_id: Uuid",
                pr_url,
                pr_number,
                pr_status AS "pr_status: MergeStatus",
                target_branch_name,
                head_branch_name,
                merged_at AS "merged_at: DateTime<Utc>",
                merge_commit_sha,
                created_at AS "created_at!: DateTime<Utc>",
                updated_at AS "updated_at!: DateTime<Utc>",
                synced_at AS "synced_at: DateTime<Utc>"
            FROM pull_requests
            WHERE workspace_id = $1
            ORDER BY created_at DESC"#,
            workspace_id,
        )
        .fetch_all(pool)
        .await
    }

    pub async fn find_by_workspace_and_repo_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
    ) -> Result<Vec<PullRequest>, sqlx::Error> {
        sqlx::query_as!(
            PullRequest,
            r#"SELECT
                id,
                workspace_id AS "workspace_id: Uuid",
                repo_id AS "repo_id: Uuid",
                pr_url,
                pr_number,
                pr_status AS "pr_status: MergeStatus",
                target_branch_name,
                head_branch_name,
                merged_at AS "merged_at: DateTime<Utc>",
                merge_commit_sha,
                created_at AS "created_at!: DateTime<Utc>",
                updated_at AS "updated_at!: DateTime<Utc>",
                synced_at AS "synced_at: DateTime<Utc>"
            FROM pull_requests
            WHERE workspace_id = $1 AND repo_id = $2
            ORDER BY created_at DESC"#,
            workspace_id,
            repo_id,
        )
        .fetch_all(pool)
        .await
    }

    pub async fn count_open_for_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        let row = sqlx::query!(
            r#"SELECT COUNT(1) AS "count!: i64" FROM pull_requests WHERE workspace_id = ? AND pr_status = 'open'"#,
            workspace_id,
        )
        .fetch_one(pool)
        .await?;
        Ok(row.count)
    }

    pub async fn get_for_workspaces(
        pool: &SqlitePool,
    ) -> Result<HashMap<Uuid, Vec<PullRequest>>, sqlx::Error> {
        let mut rows = Self::find_all_with_workspace(pool).await?;
        rows.reverse();
        let mut by_workspace = HashMap::<Uuid, Vec<PullRequest>>::new();
        for pr in rows {
            if let Some(workspace_id) = pr.workspace_id {
                by_workspace.entry(workspace_id).or_default().push(pr);
            }
        }
        Ok(by_workspace)
    }

    pub async fn find_all_with_workspace(
        pool: &SqlitePool,
    ) -> Result<Vec<PullRequest>, sqlx::Error> {
        sqlx::query_as!(
            PullRequest,
            r#"SELECT
                id,
                workspace_id AS "workspace_id: Uuid",
                repo_id AS "repo_id: Uuid",
                pr_url,
                pr_number,
                pr_status AS "pr_status: MergeStatus",
                target_branch_name,
                head_branch_name,
                merged_at AS "merged_at: DateTime<Utc>",
                merge_commit_sha,
                created_at AS "created_at!: DateTime<Utc>",
                updated_at AS "updated_at!: DateTime<Utc>",
                synced_at AS "synced_at: DateTime<Utc>"
            FROM pull_requests
            WHERE workspace_id IS NOT NULL
            ORDER BY created_at ASC"#,
        )
        .fetch_all(pool)
        .await
    }

    pub async fn get_pending_sync(pool: &SqlitePool) -> Result<Vec<PullRequest>, sqlx::Error> {
        sqlx::query_as!(
            PullRequest,
            r#"SELECT
                id,
                workspace_id AS "workspace_id: Uuid",
                repo_id AS "repo_id: Uuid",
                pr_url,
                pr_number,
                pr_status AS "pr_status: MergeStatus",
                target_branch_name,
                head_branch_name,
                merged_at AS "merged_at: DateTime<Utc>",
                merge_commit_sha,
                created_at AS "created_at!: DateTime<Utc>",
                updated_at AS "updated_at!: DateTime<Utc>",
                synced_at AS "synced_at: DateTime<Utc>"
            FROM pull_requests
            WHERE synced_at IS NULL OR synced_at < updated_at"#,
        )
        .fetch_all(pool)
        .await
    }

    pub async fn mark_synced(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query!(
            "UPDATE pull_requests SET synced_at = ? WHERE id = ?",
            now,
            id,
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub fn to_pr_merge(&self) -> PrMerge {
        PrMerge {
            id: Uuid::parse_str(&self.id).unwrap_or_else(|_| Uuid::nil()),
            workspace_id: self.workspace_id.unwrap_or_else(Uuid::nil),
            repo_id: self.repo_id.unwrap_or_else(Uuid::nil),
            created_at: self.created_at,
            target_branch_name: self.target_branch_name.clone(),
            head_branch_name: self.head_branch_name.clone(),
            head_commits_ahead: None,
            head_commits_behind: None,
            pr_info: PullRequestInfo {
                number: self.pr_number,
                url: self.pr_url.clone(),
                status: self.pr_status.clone(),
                merged_at: self.merged_at,
                merge_commit_sha: self.merge_commit_sha.clone(),
            },
        }
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query!("DELETE FROM pull_requests WHERE id = ?", id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Unlinks every PR tracked for a workspace/repo (user-triggered unlink).
    /// Removes the local link only — the PR on the host is untouched. Returns the
    /// number of links removed.
    pub async fn delete_by_workspace_and_repo(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!(
            "DELETE FROM pull_requests WHERE workspace_id = ? AND repo_id = ?",
            workspace_id,
            repo_id,
        )
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Unlinks a single PR (by its unique URL) from a workspace/repo. Scoped to
    /// both identifiers so one repo cannot unlink another repo's PR row in the
    /// same workspace. Removes the local link only — the PR on the host is
    /// untouched. Returns the number of links removed (0 or 1).
    pub async fn delete_by_workspace_repo_and_url(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
        pr_url: &str,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!(
            "DELETE FROM pull_requests WHERE workspace_id = ? AND repo_id = ? AND pr_url = ?",
            workspace_id,
            repo_id,
            pr_url,
        )
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Unlinks stale PRs from a workspace/repo when its target branch changes.
    ///
    /// Only removes PRs whose head is the workspace's own work branch — a NULL
    /// `head_branch_name` (legacy rows, where head was always the work branch)
    /// or one equal to `workspace_branch`. Those track the work -> target merge
    /// and go stale once the target moves.
    ///
    /// Feature-branch-head PRs (three-branch flow, e.g. `feature -> develop`)
    /// are kept: their base is independent of the workspace's target branch, so
    /// changing the target does not invalidate them.
    ///
    /// Returns the number of PR links removed.
    pub async fn delete_stale_for_target_change(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
        new_target_branch: &str,
        workspace_branch: &str,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!(
            "DELETE FROM pull_requests
             WHERE workspace_id = ? AND repo_id = ? AND target_branch_name != ?
               AND (head_branch_name IS NULL OR head_branch_name = ?)",
            workspace_id,
            repo_id,
            new_target_branch,
            workspace_branch,
        )
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub fn to_merge(&self) -> Merge {
        Merge::Pr(self.to_pr_merge())
    }
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use uuid::Uuid;

    use super::PullRequest;

    #[tokio::test]
    async fn unlinking_a_pr_keeps_links_for_other_repos_in_the_workspace() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE pull_requests (
                id TEXT PRIMARY KEY NOT NULL,
                workspace_id BLOB,
                repo_id BLOB,
                pr_url TEXT NOT NULL UNIQUE,
                pr_number INTEGER NOT NULL,
                pr_status TEXT NOT NULL,
                target_branch_name TEXT NOT NULL,
                head_branch_name TEXT,
                merged_at TEXT,
                merge_commit_sha TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                synced_at DATETIME
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        let workspace_id = Uuid::new_v4();
        let selected_repo_id = Uuid::new_v4();
        let other_repo_id = Uuid::new_v4();
        let selected_url = "https://example.test/selected/1";
        let other_url = "https://example.test/other/2";
        PullRequest::create_for_workspace(
            &pool,
            workspace_id,
            selected_repo_id,
            "main",
            1,
            selected_url,
            None,
        )
        .await
        .unwrap();
        PullRequest::create_for_workspace(
            &pool,
            workspace_id,
            other_repo_id,
            "main",
            2,
            other_url,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            PullRequest::delete_by_workspace_repo_and_url(
                &pool,
                workspace_id,
                selected_repo_id,
                other_url,
            )
            .await
            .unwrap(),
            0
        );
        assert!(
            PullRequest::find_by_url(&pool, other_url)
                .await
                .unwrap()
                .is_some()
        );

        assert_eq!(
            PullRequest::delete_by_workspace_repo_and_url(
                &pool,
                workspace_id,
                selected_repo_id,
                selected_url,
            )
            .await
            .unwrap(),
            1
        );
        assert!(
            PullRequest::find_by_url(&pool, selected_url)
                .await
                .unwrap()
                .is_none()
        );
    }
}
