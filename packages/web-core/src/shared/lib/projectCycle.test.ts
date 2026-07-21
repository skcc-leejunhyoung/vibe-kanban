import { describe, expect, it } from 'vitest';
import { getCycledProjectId } from './projectCycle';

describe('getCycledProjectId', () => {
  const projects = ['one', 'two', 'three'];

  it('cycles forward and wraps', () => {
    expect(getCycledProjectId(projects, 'one', 1)).toBe('two');
    expect(getCycledProjectId(projects, 'three', 1)).toBe('one');
  });

  it('cycles backward and wraps', () => {
    expect(getCycledProjectId(projects, 'three', -1)).toBe('two');
    expect(getCycledProjectId(projects, 'one', -1)).toBe('three');
  });

  it('starts at the directional edge without a current project', () => {
    expect(getCycledProjectId(projects, null, 1)).toBe('one');
    expect(getCycledProjectId(projects, null, -1)).toBe('three');
  });
});
