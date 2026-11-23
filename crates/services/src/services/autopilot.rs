//! Read-only Autopilot facts. This never changes a task, review, or workspace status.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

/// Typed scheduling facts only; no prompts, logs, or message content leave the host.
pub async fn reconciliation_snapshot(pool: &SqlitePool) -> Result<Value, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let rows = sqlx::query("SELECT id,archived,updated_at FROM workspaces WHERE autopilot=0 AND ephemeral=0 ORDER BY id").fetch_all(&mut *tx).await?;
    let mut workspaces = Vec::new();
    for row in rows {
        let workspace: Uuid = row.get("id");
        let sessions = sqlx::query("SELECT id FROM sessions WHERE workspace_id=? ORDER BY id")
            .bind(workspace)
            .fetch_all(&mut *tx)
            .await?;
        let mut facts = Vec::new();
        for session in sessions {
            let id: Uuid = session.get("id");
            let queue: Option<String> = sqlx::query_scalar(
                "SELECT messages FROM session_queued_messages WHERE session_id=?",
            )
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
            let executions = sqlx::query("SELECT id,status,dropped,updated_at FROM execution_processes WHERE session_id=? AND run_reason!='devserver' AND (status='running' OR created_at=(SELECT MAX(created_at) FROM execution_processes WHERE session_id=? AND run_reason!='devserver')) ORDER BY id")
                .bind(id).bind(id).fetch_all(&mut *tx).await?;
            let rows = sqlx::query("SELECT id,'rate_limit' AS kind,execution_process_id,resume_at AS due_at,resume_prompt AS prompt,NULL AS schedule,0 AS recurring FROM pending_rate_limit_resumes WHERE session_id=? UNION ALL SELECT id,'scheduled',NULL,next_fire_at,prompt,schedule,recurring FROM scheduled_resumes WHERE session_id=? AND status='pending' ORDER BY kind,id")
                .bind(id).bind(id).fetch_all(&mut *tx).await?;
            let mut resumes = Vec::new();
            for resume in rows {
                let content = json!([
                    resume.get::<String, _>("prompt"),
                    resume.get::<Option<String>, _>("schedule"),
                    resume.get::<bool, _>("recurring")
                ]);
                resumes.push(json!({"id":resume.get::<Uuid,_>("id"),"kind":resume.get::<String,_>("kind"),
                    "execution_id":resume.get::<Option<Uuid>,_>("execution_process_id"),
                    "due_at":resume.try_get::<chrono::DateTime<chrono::Utc>,_>("due_at")?.to_rfc3339(),
                    "content_hash":format!("{:x}",Sha256::digest(content.to_string().as_bytes()))}));
            }
            facts.push(json!({"id":id,"queue_hash":format!("{:x}",Sha256::digest(queue.unwrap_or_else(|| "[]".into()).as_bytes())),"pending_resumes":resumes.len(),"resumes":resumes,
                "executions":executions.into_iter().map(|e| json!({"id":e.get::<Uuid,_>("id"),"status":e.get::<String,_>("status"),"dropped":e.get::<bool,_>("dropped"),"updated_at":e.get::<String,_>("updated_at")})).collect::<Vec<_>>() }));
        }
        let pending: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pending_execution_starts WHERE workspace_id=?",
        )
        .bind(workspace)
        .fetch_one(&mut *tx)
        .await?;
        workspaces.push(json!({"id":workspace,"archived":row.get::<bool,_>("archived"),"updated_at":row.get::<String,_>("updated_at"),"pending_starts":pending,"sessions":facts}));
    }
    tx.commit().await?;
    Ok(json!({"complete":true,"workspaces":workspaces}))
}

/// Migration that started recording agent origins; older executions have none.
const ORIGIN_TRACKING_MIGRATION: i64 = 20261120120000;

/// Remembers which agent session asked for `execution`. The first record wins.
pub async fn record_agent_origin(
    pool: &SqlitePool,
    execution: Uuid,
    agent_session: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT OR IGNORE INTO execution_agent_origins(execution_id,agent_session_id) VALUES(?,?)",
    )
    .bind(execution)
    .bind(agent_session)
    .execute(pool)
    .await?;
    Ok(())
}

/// Sessions of this host's Autopilot workspaces, including archived ones.
pub async fn autopilot_sessions(pool: &SqlitePool) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT s.id FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE w.autopilot=1 ORDER BY s.id")
        .fetch_all(pool)
        .await
}

/// Typed facts triage uses to tell the Autopilot's work from the user's own.
/// A workspace belongs to every agent that started any execution in it, so a
/// resumed, chained or setup step stays with whoever dispatched the work.
/// No prompt or log content.
pub async fn triage_facts(pool: &SqlitePool, execution: Uuid) -> Result<Value, sqlx::Error> {
    let row = sqlx::query(
        "SELECT e.session_id,s.workspace_id,e.run_reason, \
        (SELECT o.agent_session_id FROM execution_agent_origins o WHERE o.execution_id=e.id) AS execution_agent_session, \
        (w.autopilot=1) AS autopilot,(w.archived=1) AS archived, \
        (COALESCE(w.branch,'') LIKE 'review/%') AS review_branch, \
        EXISTS(SELECT 1 FROM pull_requests p WHERE p.workspace_id=w.id) AS has_pr, \
        EXISTS(SELECT 1 FROM vibe_runs v WHERE v.workspace_id=w.id) AS vibe_run, \
        COALESCE(julianday(e.created_at)<julianday(m.installed_on),1) AS execution_before_tracking, \
        COALESCE(julianday(f.created_at)<julianday(m.installed_on),1) AS workspace_before_tracking \
        FROM execution_processes e JOIN sessions s ON s.id=e.session_id JOIN workspaces w ON w.id=s.workspace_id \
        JOIN execution_processes f ON f.id=(SELECT x.id FROM execution_processes x JOIN sessions xs ON xs.id=x.session_id \
            WHERE xs.workspace_id=w.id ORDER BY julianday(x.created_at),x.id LIMIT 1) \
        LEFT JOIN _sqlx_migrations m ON m.version=? \
        WHERE e.id=?",
    )
    .bind(ORIGIN_TRACKING_MIGRATION)
    .bind(execution)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(json!({"execution_id":execution,"missing":true}));
    };
    let workspace: Uuid = row.get("workspace_id");
    let workspace_agents: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT o.agent_session_id FROM execution_agent_origins o \
         JOIN execution_processes x ON x.id=o.execution_id JOIN sessions xs ON xs.id=x.session_id \
         WHERE xs.workspace_id=? ORDER BY o.agent_session_id",
    )
    .bind(workspace)
    .fetch_all(pool)
    .await?;
    let flag = |key: &str| row.get::<bool, _>(key);
    Ok(json!({
        "execution_id": execution,
        "session_id": row.get::<Uuid, _>("session_id"),
        "workspace_id": row.get::<Uuid, _>("workspace_id"),
        "run_reason": row.get::<String, _>("run_reason"),
        "execution_agent_session": row.get::<Option<Uuid>, _>("execution_agent_session"),
        "workspace_agent_sessions": workspace_agents,
        "autopilot": flag("autopilot"),
        "archived": flag("archived"),
        "review_branch": flag("review_branch"),
        "has_pr": flag("has_pr"),
        "vibe_run": flag("vibe_run"),
        "execution_before_tracking": flag("execution_before_tracking"),
        "workspace_before_tracking": flag("workspace_before_tracking"),
    }))
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    async fn fixture() -> (SqlitePool, Uuid, Uuid, Uuid) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let workspace = Uuid::new_v4();
        let session = Uuid::new_v4();
        let execution = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces(id,branch) VALUES(?,'synthetic-branch')")
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions(id,workspace_id) VALUES(?,?)")
            .bind(session)
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        let action = json!({"typ":{"type":"CodingAgentInitialRequest"},"next_action":null,"automation_origin":{"routine_id":"synthetic-routine","routine_chain":[]}});
        sqlx::query("INSERT INTO execution_processes(id,session_id,run_reason,executor_action,status,exit_code) VALUES(?,?,'codingagent',?,'completed',0)")
            .bind(execution).bind(session).bind(action.to_string()).execute(&pool).await.unwrap();
        (pool, workspace, session, execution)
    }

    #[tokio::test]
    async fn triage_facts_tell_agent_dispatched_work_from_user_work() {
        let (pool, workspace, session, execution) = fixture().await;
        let facts = triage_facts(&pool, execution).await.unwrap();
        assert_eq!(facts["workspace_id"], workspace.to_string());
        assert!(facts["execution_agent_session"].is_null());
        assert_eq!(facts["workspace_agent_sessions"], json!([]));
        assert_eq!(facts["execution_before_tracking"], false);
        assert_eq!(facts["has_pr"], false);
        assert_eq!(facts["review_branch"], false);

        let agent = Uuid::new_v4();
        record_agent_origin(&pool, execution, agent).await.unwrap();
        // The first record wins; a replayed request cannot rewrite it.
        record_agent_origin(&pool, execution, Uuid::new_v4())
            .await
            .unwrap();
        let later = Uuid::new_v4();
        sqlx::query("INSERT INTO execution_processes(id,session_id,run_reason,executor_action,status,exit_code,created_at) VALUES(?,?,'codingagent','{}','completed',0,'2999-01-01T00:00:00.000000+00:00')")
            .bind(later).bind(session).execute(&pool).await.unwrap();
        let first = triage_facts(&pool, execution).await.unwrap();
        assert_eq!(first["execution_agent_session"], agent.to_string());
        let user_turn = triage_facts(&pool, later).await.unwrap();
        assert!(user_turn["execution_agent_session"].is_null());
        assert_eq!(user_turn["workspace_agent_sessions"], json!([agent]));

        // A setup step or resume without its own origin still belongs to the
        // agent that started any work in the workspace.
        let setup = Uuid::new_v4();
        sqlx::query("INSERT INTO execution_processes(id,session_id,run_reason,executor_action,status,exit_code,created_at) VALUES(?,?,'setupscript','{}','completed',0,'1999-01-01T00:00:00.000000+00:00')")
            .bind(setup).bind(session).execute(&pool).await.unwrap();
        let earlier_setup = triage_facts(&pool, setup).await.unwrap();
        assert_eq!(earlier_setup["workspace_agent_sessions"], json!([agent]));
        sqlx::query("DELETE FROM execution_processes WHERE id=?")
            .bind(setup)
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query("UPDATE workspaces SET branch='review/synthetic' WHERE id=?")
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE execution_processes SET created_at='2001-01-01 00:00:00' WHERE id=?")
            .bind(execution)
            .execute(&pool)
            .await
            .unwrap();
        let old = triage_facts(&pool, execution).await.unwrap();
        assert_eq!(old["review_branch"], true);
        assert_eq!(old["execution_before_tracking"], true);
        assert_eq!(old["workspace_before_tracking"], true);
        assert_eq!(
            triage_facts(&pool, Uuid::new_v4()).await.unwrap()["missing"],
            true
        );

        assert!(autopilot_sessions(&pool).await.unwrap().is_empty());
        sqlx::query("UPDATE workspaces SET autopilot=1 WHERE id=?")
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(autopilot_sessions(&pool).await.unwrap(), vec![session]);
    }

    #[tokio::test]
    async fn reconciliation_reads_all_sessions_without_message_content() {
        let (pool, workspace, session, _) = fixture().await;
        let other = Uuid::new_v4();
        sqlx::query("INSERT INTO sessions(id,workspace_id) VALUES(?,?)")
            .bind(other)
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        let before = reconciliation_snapshot(&pool).await.unwrap();
        assert_eq!(
            before["workspaces"][0]["sessions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        sqlx::query("INSERT INTO session_queued_messages(session_id,messages) VALUES(?,?)")
            .bind(session)
            .bind(r#"[{"id":"synthetic-message","data":{"message":"synthetic private text"}}]"#)
            .execute(&pool)
            .await
            .unwrap();
        let after = reconciliation_snapshot(&pool).await.unwrap();
        assert_ne!(before, after);
        assert!(!after.to_string().contains("synthetic private text"));
        sqlx::query("UPDATE workspaces SET autopilot=1 WHERE id=?")
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            reconciliation_snapshot(&pool).await.unwrap()["workspaces"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn reconciliation_tracks_resume_changes_without_exposing_prompts() {
        let (pool, _, session, execution) = fixture().await;
        let resume = Uuid::new_v4();
        sqlx::query("INSERT INTO scheduled_resumes(id,session_id,cron_id,prompt,schedule,next_fire_at) VALUES(?,?,'synthetic-cron','synthetic scheduled prompt','0 * * * *','2002-03-04T01:00:00Z')")
            .bind(resume).bind(session).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO pending_rate_limit_resumes(id,session_id,execution_process_id,resume_at,resume_prompt) VALUES(?,?,?,'2002-03-04T02:00:00Z','synthetic rate-limit prompt')")
            .bind(Uuid::new_v4()).bind(session).bind(execution).execute(&pool).await.unwrap();
        let mut previous = reconciliation_snapshot(&pool).await.unwrap();
        assert_eq!(
            previous["workspaces"][0]["sessions"][0]["pending_resumes"],
            2
        );
        for change in [
            "UPDATE scheduled_resumes SET next_fire_at='2002-03-05T01:00:00Z'",
            "UPDATE scheduled_resumes SET prompt='changed synthetic scheduled prompt'",
            "UPDATE scheduled_resumes SET schedule='30 * * * *',recurring=1",
            "UPDATE pending_rate_limit_resumes SET resume_at='2002-03-05T02:00:00Z'",
            "UPDATE pending_rate_limit_resumes SET resume_prompt='changed synthetic rate-limit prompt'",
        ] {
            sqlx::query(change).execute(&pool).await.unwrap();
            let current = reconciliation_snapshot(&pool).await.unwrap();
            assert_ne!(previous, current, "{change}");
            assert!(!current.to_string().contains("prompt"));
            previous = current;
        }
        sqlx::query("UPDATE pending_rate_limit_resumes SET last_checked_at='2002-03-06T00:00:00Z'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(previous, reconciliation_snapshot(&pool).await.unwrap());
    }
}
