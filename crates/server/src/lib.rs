pub mod blocker_watcher;
pub mod error;
pub mod middleware;
pub mod rate_limit_watcher;
pub mod relay_pairing;
pub mod routes;
pub mod runtime;
pub mod scheduled_resume_watcher;
pub mod startup;

// #[cfg(feature = "cloud")]
// type DeploymentImpl = vibe_kanban_cloud::deployment::CloudDeployment;
// #[cfg(not(feature = "cloud"))]
pub type DeploymentImpl = local_deployment::LocalDeployment;
