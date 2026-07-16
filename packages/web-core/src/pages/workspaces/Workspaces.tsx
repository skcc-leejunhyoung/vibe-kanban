import type { ReactNode } from 'react';
import { WorkspacesLayout } from './WorkspacesLayout';

interface WorkspacesProps {
  /**
   * Optional replacement for the detail (main) pane. Remote web passes a
   * host-unavailable notice here when the opened workspace's host is offline,
   * so the unified sidebar list stays mounted instead of the whole page being
   * blanked. `undefined` (local web, healthy host) renders the workspace.
   */
  detailUnavailable?: ReactNode;
}

export function Workspaces({ detailUnavailable }: WorkspacesProps = {}) {
  return <WorkspacesLayout detailUnavailable={detailUnavailable} />;
}
