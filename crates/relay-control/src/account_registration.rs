//! Private installation state. The presence of this file permanently disables
//! legacy pairing, even when an interrupted registration cannot yet be resumed.
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
};

use relay_types::{
    AccountHostRegistration, RegisterAccountHostRequest, RotateHostCredentialRequest,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct AccountRegistrationFile {
    pub api_base: String,
    pub relay_base: String,
    pub request: RegisterAccountHostRequest,
    pub registration: Option<AccountHostRegistration>,
    pub rotated_at: i64,
    pub pending_rotation: Option<RotateHostCredentialRequest>,
}

pub fn read(path: &Path) -> io::Result<Option<AccountRegistrationFile>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn write(path: &Path, state: &AccountRegistrationFile) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Missing registration directory"))?;
    fs::create_dir_all(parent)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec(state).map_err(io::Error::other)?)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        #[cfg(unix)]
        {
            fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_registration_roundtrips_and_corruption_does_not_unlock_legacy() {
        let directory =
            std::env::temp_dir().join(format!("vk-registration-test-{}", uuid::Uuid::new_v4()));
        let path = directory.join("registration.json");
        let state = AccountRegistrationFile {
            api_base: "https://central.test".into(),
            relay_base: "https://relay.test".into(),
            request: RegisterAccountHostRequest {
                request_id: uuid::Uuid::new_v4(),
                expected_generation: None,
                machine_id: "machine".into(),
                name: "Host".into(),
                credential: crate::account::new_credential(),
                capabilities: vec!["account-v1".into()],
            },
            registration: None,
            rotated_at: 100,
            pending_rotation: None,
        };
        write(&path, &state).unwrap();
        assert_eq!(
            read(&path).unwrap().unwrap().request.credential,
            state.request.credential
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::write(&path, b"broken").unwrap();
        assert!(path.exists());
        assert!(read(&path).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
