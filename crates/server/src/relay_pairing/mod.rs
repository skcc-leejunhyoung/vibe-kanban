pub mod server;

use deployment::Deployment;

use crate::{DeploymentImpl, relay_pairing::server::RelayPairingServer};

pub fn build_relay_pairing_server(deployment: &DeploymentImpl) -> RelayPairingServer {
    RelayPairingServer::new(
        deployment.trusted_key_auth().clone(),
        deployment.relay_signing().clone(),
    )
}
