use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct UserNotificationPreference {
    pub user_id: Uuid,
    pub review_requested_enabled: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct UpdateUserNotificationPreferenceRequest {
    pub review_requested_enabled: bool,
}
