import { describe, expect, it } from 'vitest';
import { getCycledWorkspaceKey } from './workspaceCycle';

describe('getCycledWorkspaceKey', () => {
  const workspaces = ['host-a:same-id', 'host-b:same-id', 'host-a:third'];

  it('cycles between host-qualified workspace identities', () => {
    expect(getCycledWorkspaceKey(workspaces, 'host-a:same-id', 1)).toBe(
      'host-b:same-id'
    );
  });

  it('wraps in both directions', () => {
    expect(getCycledWorkspaceKey(workspaces, 'host-a:third', 1)).toBe(
      'host-a:same-id'
    );
    expect(getCycledWorkspaceKey(workspaces, 'host-a:same-id', -1)).toBe(
      'host-a:third'
    );
  });

  it('starts at the direction-appropriate edge without a selection', () => {
    expect(getCycledWorkspaceKey(workspaces, null, 1)).toBe('host-a:same-id');
    expect(getCycledWorkspaceKey(workspaces, null, -1)).toBe('host-a:third');
  });
});
