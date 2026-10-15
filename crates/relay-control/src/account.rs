//! Account grants have a distinct asymmetric trust root from user JWTs.
//! No host ever receives the central signing secret.
use anyhow::{Context, ensure};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use relay_types::{ACCOUNT_GRANT_TTL_SECS, HostGrantClaims, HostGrantKey, HostGrantKeys};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const GRANT_DOMAIN: &str = "vk-host-account-grant-v1";
const PROOF_DOMAIN: &str = "vk-host-account-session-v1";

pub fn decode_public_key(value: &str) -> anyhow::Result<VerifyingKey> {
    let bytes: [u8; 32] = STANDARD
        .decode(value)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid public key length"))?;
    Ok(VerifyingKey::from_bytes(&bytes)?)
}

pub fn thumbprint(public_key_b64: &str) -> anyhow::Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(
        decode_public_key(public_key_b64)?.as_bytes(),
    )))
}

pub fn credential_hash(secret: &str) -> anyhow::Result<String> {
    ensure!(secret.starts_with("vkh_"), "Invalid host credential kind");
    let bytes = URL_SAFE_NO_PAD.decode(&secret[4..])?;
    ensure!(
        bytes.len() == 32,
        "Host credential must contain 256 random bits"
    );
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes())))
}

pub fn new_credential() -> String {
    use rand::RngCore;
    let mut bytes = [0; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!("vkh_{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub struct HostGrantSigner {
    issuer: String,
    kid: String,
    key: SigningKey,
    previous: Vec<HostGrantKey>,
}

impl HostGrantSigner {
    pub fn new(
        issuer: String,
        kid: String,
        seed: [u8; 32],
        previous: Vec<HostGrantKey>,
    ) -> anyhow::Result<Self> {
        ensure!(
            !issuer.is_empty() && !kid.is_empty() && !kid.contains('.'),
            "Invalid grant issuer or key id"
        );
        Ok(Self {
            issuer: issuer.trim_end_matches('/').into(),
            kid,
            key: SigningKey::from_bytes(&seed),
            previous,
        })
    }

    /// Absence is intentional: account registration remains off until the
    /// operator provisions a separate signing key and a canonical issuer.
    pub fn from_env() -> anyhow::Result<Self> {
        let seed = STANDARD.decode(
            std::env::var("HOST_GRANT_SIGNING_KEY")
                .context("Account host registration is not enabled")?,
        )?;
        let seed: [u8; 32] = seed
            .try_into()
            .map_err(|_| anyhow::anyhow!("Invalid grant signing seed"))?;
        let previous = std::env::var("HOST_GRANT_PREVIOUS_PUBLIC_KEYS")
            .ok()
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or_default();
        Self::new(
            std::env::var("HOST_GRANT_ISSUER")?,
            std::env::var("HOST_GRANT_KEY_ID")?,
            seed,
            previous,
        )
    }

    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    pub fn public_keys(&self) -> HostGrantKeys {
        let mut keys = vec![HostGrantKey {
            kid: self.kid.clone(),
            algorithm: "Ed25519".into(),
            public_key_b64: STANDARD.encode(self.key.verifying_key().as_bytes()),
        }];
        keys.extend(self.previous.clone());
        HostGrantKeys {
            issuer: self.issuer.clone(),
            keys,
        }
    }

    pub fn sign(&self, claims: &HostGrantClaims) -> anyhow::Result<String> {
        ensure!(
            claims.issuer == self.issuer && claims.kind == GRANT_DOMAIN,
            "Wrong grant kind or issuer"
        );
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims)?);
        let message = format!("{GRANT_DOMAIN}.{}.{}", self.kid, payload);
        Ok(format!(
            "{message}.{}",
            URL_SAFE_NO_PAD.encode(self.key.sign(message.as_bytes()).to_bytes())
        ))
    }
}

pub fn grant_kind() -> &'static str {
    GRANT_DOMAIN
}

pub fn verify_grant(
    token: &str,
    keys: &HostGrantKeys,
    expected_issuer: &str,
    host_id: Uuid,
    generation: i32,
    now: i64,
) -> anyhow::Result<HostGrantClaims> {
    ensure!(
        token.len() <= 8192 && keys.issuer == expected_issuer,
        "Invalid grant issuer"
    );
    let parts: Vec<_> = token.split('.').collect();
    ensure!(
        parts.len() == 4 && parts[0] == GRANT_DOMAIN,
        "Invalid grant format"
    );
    let key = keys
        .keys
        .iter()
        .find(|k| k.kid == parts[1] && k.algorithm == "Ed25519")
        .context("Unknown signing key")?;
    let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[3])?)?;
    decode_public_key(&key.public_key_b64)?
        .verify_strict(token.rsplit_once('.').unwrap().0.as_bytes(), &signature)?;
    let claims: HostGrantClaims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[2])?)?;
    ensure!(
        claims.kind == GRANT_DOMAIN
            && claims.issuer == expected_issuer
            && claims.audience == host_id
            && claims.host_generation == generation
            && claims.issued_at <= now + 5
            && claims.expires_at > now
            && claims.expires_at > claims.issued_at
            && claims.expires_at - claims.issued_at <= ACCOUNT_GRANT_TTL_SECS
            && claims.public_key_thumbprint == thumbprint(&claims.public_key_b64)?,
        "Invalid host grant claims"
    );
    Ok(claims)
}

pub fn session_proof_message(grant: &str) -> String {
    format!("{PROOF_DOMAIN}\n{grant}")
}

pub fn verify_session_proof(
    grant: &str,
    proof: &str,
    claims: &HostGrantClaims,
) -> anyhow::Result<()> {
    let signature = Signature::from_slice(&STANDARD.decode(proof)?)?;
    decode_public_key(&claims.public_key_b64)?
        .verify(session_proof_message(grant).as_bytes(), &signature)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn make_claims(host: Uuid, key: &SigningKey) -> HostGrantClaims {
        let public_key_b64 = STANDARD.encode(key.verifying_key().as_bytes());
        HostGrantClaims {
            issuer: "https://central.example".into(),
            kind: grant_kind().into(),
            audience: host,
            user_id: Uuid::new_v4(),
            auth_session_id: Uuid::new_v4(),
            host_generation: 2,
            grant_version: 3,
            public_key_thumbprint: thumbprint(&public_key_b64).unwrap(),
            public_key_b64,
            issued_at: 1000,
            expires_at: 1300,
            jti: Uuid::new_v4(),
        }
    }
    #[test]
    fn grant_requires_correct_asymmetric_root_identity_generation_time_and_key() {
        let issuer = HostGrantSigner::new(
            "https://central.example".into(),
            "key-1".into(),
            [7; 32],
            vec![],
        )
        .unwrap();
        let peer = SigningKey::from_bytes(&[8; 32]);
        let host = Uuid::new_v4();
        let claims = make_claims(host, &peer);
        let token = issuer.sign(&claims).unwrap();
        let keys = issuer.public_keys();
        assert!(verify_grant(&token, &keys, &keys.issuer, host, 2, 1001).is_ok());
        for (host, generation, now) in [
            (Uuid::new_v4(), 2, 1001),
            (host, 3, 1001),
            (host, 2, 1300),
            (host, 2, 900),
        ] {
            assert!(verify_grant(&token, &keys, &keys.issuer, host, generation, now).is_err());
        }
        assert!(verify_grant(&token, &keys, "https://evil.example", host, 2, 1001).is_err());
        let attacker =
            HostGrantSigner::new(keys.issuer.clone(), "key-1".into(), [9; 32], vec![]).unwrap();
        assert!(
            verify_grant(
                &attacker.sign(&claims).unwrap(),
                &keys,
                &keys.issuer,
                host,
                2,
                1001
            )
            .is_err()
        );
        let proof = STANDARD.encode(
            peer.sign(session_proof_message(&token).as_bytes())
                .to_bytes(),
        );
        assert!(verify_session_proof(&token, &proof, &claims).is_ok());
        let other = make_claims(host, &SigningKey::from_bytes(&[10; 32]));
        assert!(verify_session_proof(&token, &proof, &other).is_err());
        let mut changed = claims.clone();
        changed.user_id = Uuid::new_v4();
        let tampered = token.replace(
            &URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap()),
            &URL_SAFE_NO_PAD.encode(serde_json::to_vec(&changed).unwrap()),
        );
        assert!(verify_grant(&tampered, &keys, &keys.issuer, host, 2, 1001).is_err());
    }
    #[test]
    fn public_key_rotation_and_host_credential_domains_are_separate() {
        let old = HostGrantSigner::new(
            "https://central.example".into(),
            "old".into(),
            [1; 32],
            vec![],
        )
        .unwrap();
        let new = HostGrantSigner::new(
            "https://central.example".into(),
            "new".into(),
            [2; 32],
            old.public_keys().keys,
        )
        .unwrap();
        let claims = make_claims(Uuid::new_v4(), &SigningKey::from_bytes(&[3; 32]));
        assert!(
            verify_grant(
                &old.sign(&claims).unwrap(),
                &new.public_keys(),
                new.issuer(),
                claims.audience,
                2,
                1001
            )
            .is_ok()
        );
        assert!(credential_hash(&new_credential()).is_ok());
        assert!(credential_hash("vkh_AA").is_err());
        assert!(credential_hash("user.jwt.token").is_err());
    }
}
