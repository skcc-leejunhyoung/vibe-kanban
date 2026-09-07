use std::{
    path::PathBuf,
    sync::{Arc, Weak},
    time::{Duration, Instant},
};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use utils::jwt::extract_subject;
use uuid::Uuid;

/// OAuth credentials containing the JWT tokens issued by the remote OAuth service.
/// The `access_token` is short-lived; `refresh_token` allows minting a new pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub access_token: Option<String>,
    pub refresh_token: String,
    pub expires_at: Option<DateTime<Utc>>,
}

impl Credentials {
    pub fn expires_soon(&self, leeway: ChronoDuration) -> bool {
        match (self.access_token.as_ref(), self.expires_at.as_ref()) {
            (Some(_), Some(exp)) => Utc::now() + leeway >= *exp,
            _ => true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredCredentials {
    refresh_token: String,
}

impl From<StoredCredentials> for Credentials {
    fn from(value: StoredCredentials) -> Self {
        Self {
            access_token: None,
            refresh_token: value.refresh_token,
            expires_at: None,
        }
    }
}

/// Service for managing OAuth credentials (JWT tokens) in memory and persistent storage.
/// The token is loaded into memory on startup and persisted to disk on save.
pub struct OAuthCredentials {
    path: PathBuf,
    inner: RwLock<CredentialState>,
}

#[derive(Default)]
struct CredentialState {
    credentials: Option<Credentials>,
    reconnects: Vec<Weak<ReconnectGuard>>,
}

impl CredentialState {
    fn is_reconnecting(&self) -> bool {
        self.reconnects
            .iter()
            .filter_map(Weak::upgrade)
            .any(|guard| guard.expires_at > Instant::now())
    }
}

/// Owned by a pending OAuth handoff. Dropping it releases protection on every
/// failure/cancellation path; abandoned popups cannot suspend refresh forever.
#[derive(Debug)]
pub struct ReconnectGuard {
    expires_at: Instant,
}

impl OAuthCredentials {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            inner: RwLock::new(CredentialState::default()),
        }
    }

    pub async fn load(&self) -> std::io::Result<()> {
        let creds = self.load_from_file().await?.map(Credentials::from);
        *self.inner.write().await = CredentialState {
            credentials: creds,
            reconnects: Vec::new(),
        };
        Ok(())
    }

    pub async fn save(&self, creds: &Credentials) -> std::io::Result<()> {
        let mut current = self.inner.write().await;
        self.write_credentials(&mut current.credentials, Some(creds))
            .await?;
        current.reconnects.clear();
        Ok(())
    }

    pub async fn clear(&self) -> std::io::Result<()> {
        let mut current = self.inner.write().await;
        self.write_credentials(&mut current.credentials, None)
            .await?;
        current.reconnects.clear();
        Ok(())
    }

    pub async fn begin_reconnect(&self) -> Option<(Credentials, Arc<ReconnectGuard>)> {
        let mut current = self.inner.write().await;
        let creds = current.credentials.clone()?;
        // Same lifetime as the remote OAuth handoff; no timer/task is needed.
        let guard = Arc::new(ReconnectGuard {
            expires_at: Instant::now() + Duration::from_secs(10 * 60),
        });
        current.reconnects.retain(|weak| {
            weak.upgrade()
                .is_some_and(|guard| guard.expires_at > Instant::now())
        });
        current.reconnects.push(Arc::downgrade(&guard));
        Some((creds, guard))
    }

    pub async fn is_reconnecting(&self) -> bool {
        self.inner.read().await.is_reconnecting()
    }

    /// Compare and replace under the same lock as login/logout. A stale refresh
    /// response must neither overwrite nor clear a newly reconnected session.
    /// Returns false also when automatic clearing is deferred by a pending
    /// reconnect. Explicit logout still goes through `clear` unconditionally.
    pub async fn replace_if_current(
        &self,
        expected_refresh_token: &str,
        creds: Option<&Credentials>,
    ) -> std::io::Result<bool> {
        let mut current = self.inner.write().await;
        if current
            .credentials
            .as_ref()
            .map(|c| c.refresh_token.as_str())
            != Some(expected_refresh_token)
            || (creds.is_none() && current.is_reconnecting())
        {
            return Ok(false);
        }
        self.write_credentials(&mut current.credentials, creds)
            .await?;
        Ok(true)
    }

    /// The remote server verifies these JWTs. Locally compare their subjects to
    /// prevent a callback from switching the account that initiated reconnect.
    pub async fn save_for_user(&self, creds: &Credentials, user_id: Uuid) -> std::io::Result<bool> {
        let mut current = self.inner.write().await;
        let current_user = current
            .credentials
            .as_ref()
            .and_then(|c| extract_subject(&c.refresh_token).ok());
        let access_user = creds
            .access_token
            .as_deref()
            .and_then(|token| extract_subject(token).ok());
        if current_user != Some(user_id)
            || access_user != Some(user_id)
            || extract_subject(&creds.refresh_token).ok() != Some(user_id)
        {
            return Ok(false);
        }
        self.write_credentials(&mut current.credentials, Some(creds))
            .await?;
        current.reconnects.clear();
        Ok(true)
    }

    async fn write_credentials(
        &self,
        current: &mut Option<Credentials>,
        creds: Option<&Credentials>,
    ) -> std::io::Result<()> {
        if let Some(creds) = creds {
            self.save_to_file(&StoredCredentials {
                refresh_token: creds.refresh_token.clone(),
            })
            .await?;
        } else if let Err(error) = std::fs::remove_file(&self.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error);
        }
        *current = creds.cloned();
        Ok(())
    }

    pub async fn get(&self) -> Option<Credentials> {
        self.inner.read().await.credentials.clone()
    }

    async fn load_from_file(&self) -> std::io::Result<Option<StoredCredentials>> {
        if !self.path.exists() {
            return Ok(None);
        }

        let bytes = std::fs::read(&self.path)?;
        match serde_json::from_slice::<StoredCredentials>(&bytes) {
            Ok(creds) => Ok(Some(creds)),
            Err(e) => {
                tracing::warn!(?e, "failed to parse credentials file, renaming to .bad");
                let bad = self.path.with_extension("bad");
                let _ = std::fs::rename(&self.path, bad);
                Ok(None)
            }
        }
    }

    async fn save_to_file(&self, creds: &StoredCredentials) -> std::io::Result<()> {
        let tmp = self.path.with_extension("tmp");

        let file = {
            let mut opts = std::fs::OpenOptions::new();
            opts.create(true).truncate(true).write(true);

            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }

            opts.open(&tmp)?
        };

        serde_json::to_writer_pretty(&file, creds)?;
        file.sync_all()?;
        drop(file);

        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reconnect_protection_is_scoped_bounded_and_never_blocks_explicit_logout() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credentials.json");
        let storage = OAuthCredentials::new(path.clone());
        let old = Credentials {
            access_token: None,
            refresh_token: "old".into(),
            expires_at: None,
        };
        let rotated = Credentials {
            refresh_token: "rotated".into(),
            ..old.clone()
        };
        storage.save(&old).await.unwrap();
        let before = std::fs::read(&path).unwrap();
        let (_, first) = storage.begin_reconnect().await.unwrap();
        assert!(!storage.replace_if_current("old", None).await.unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), before);

        // Dropping one failed/cancelled attempt must not unprotect another.
        let (_, second) = storage.begin_reconnect().await.unwrap();
        drop(first);
        assert!(storage.is_reconnecting().await);
        // A refresh already in flight can rotate credentials without ending reconnect.
        assert!(
            storage
                .replace_if_current("old", Some(&rotated))
                .await
                .unwrap()
        );
        assert!(!storage.replace_if_current("rotated", None).await.unwrap());
        drop(second);
        assert!(!storage.is_reconnecting().await);
        assert!(storage.replace_if_current("rotated", None).await.unwrap());
        assert!(!path.exists());

        storage.save(&old).await.unwrap();
        let (_, pending) = storage.begin_reconnect().await.unwrap();
        storage.clear().await.unwrap();
        assert!(!storage.is_reconnecting().await);
        assert!(storage.get().await.is_none());
        assert!(!path.exists());
        storage.save(&old).await.unwrap();
        assert!(
            !storage.is_reconnecting().await,
            "logout/login must not restore old protection"
        );
        drop(pending);
        let (_, pending) = storage.begin_reconnect().await.unwrap();
        storage.save(&rotated).await.unwrap();
        assert!(
            !storage.is_reconnecting().await,
            "account changes must end protection"
        );
        drop(pending);

        // Exercise expiration without waiting ten minutes or adding a timer dependency.
        let expired = Arc::new(ReconnectGuard {
            expires_at: Instant::now() - Duration::from_secs(1),
        });
        storage
            .inner
            .write()
            .await
            .reconnects
            .push(Arc::downgrade(&expired));
        assert!(!storage.is_reconnecting().await);
        assert!(storage.replace_if_current("rotated", None).await.unwrap());
    }
}
