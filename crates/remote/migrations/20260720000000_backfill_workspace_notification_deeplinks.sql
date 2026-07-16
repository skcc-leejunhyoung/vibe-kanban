UPDATE notifications AS notification
SET payload = jsonb_set(
    notification.payload,
    '{deeplink_path}',
    to_jsonb(
        format(
            '/hosts/%s/workspaces/%s',
            workspace.host_id,
            workspace.local_workspace_id
        )
    ),
    true
)
FROM workspaces AS workspace
WHERE notification.notification_type = 'workspace_task_completed'
  AND workspace.host_id IS NOT NULL
  AND workspace.local_workspace_id IS NOT NULL
  AND notification.payload ->> 'workspace_id' = workspace.local_workspace_id::text
  AND notification.payload ->> 'deeplink_path' = format(
      '/workspace/%s',
      workspace.local_workspace_id
  );
