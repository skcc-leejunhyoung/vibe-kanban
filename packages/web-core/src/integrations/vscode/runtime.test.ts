import { describe, expect, it } from 'vitest';
import { isVSCodeWebviewPath } from './runtime';

describe('isVSCodeWebviewPath', () => {
  it('accepts only dedicated VS Code routes', () => {
    expect(isVSCodeWebviewPath('/workspaces/ws-1/vscode')).toBe(true);
    expect(isVSCodeWebviewPath('/hosts/host-1/workspaces/ws-1/vscode')).toBe(
      true
    );
    expect(isVSCodeWebviewPath('/workspaces/ws-1?vk_split_embed=1')).toBe(
      false
    );
  });
});
