import { cn } from '@/shared/lib/utils';
import { useWorkspaceSidebarPreviewController } from '@/shared/hooks/useWorkspaceSidebarPreviewController';
import { WorkspacesSidebarContainer } from '@/pages/workspaces/WorkspacesSidebarContainer';

interface WorkspaceSidebarHoverPreviewProps {
  enabled: boolean;
  isAppBarHovered: boolean;
}

/**
 * Slide-out preview of the workspaces sidebar shown when the left sidebar is
 * collapsed. Opens while the AppBar (or the preview itself) is hovered.
 *
 * Render this inside a `relative overflow-hidden` content container anchored to
 * the area where the always-visible sidebar would otherwise sit; the
 * overflow-hidden clips the preview while it is parked off-screen.
 */
export function WorkspaceSidebarHoverPreview({
  enabled,
  isAppBarHovered,
}: WorkspaceSidebarHoverPreviewProps) {
  const sidebarPreview = useWorkspaceSidebarPreviewController({
    enabled,
    isAppBarHovered,
  });

  if (!enabled) {
    return null;
  }

  return (
    <div
      className={cn(
        'absolute left-0 top-0 z-30 h-full w-[300px] transition-transform duration-150 ease-out',
        sidebarPreview.isPreviewOpen
          ? 'translate-x-0 pointer-events-auto'
          : '-translate-x-full pointer-events-none'
      )}
      onMouseEnter={sidebarPreview.handlePreviewHoverStart}
      onMouseLeave={sidebarPreview.handlePreviewHoverEnd}
    >
      <div className="h-full w-full overflow-hidden border-r border-border bg-secondary shadow-lg">
        <WorkspacesSidebarContainer />
      </div>
    </div>
  );
}
