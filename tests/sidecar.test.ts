import { describe, expect, it } from 'vitest';
import { computeSidecarPath } from '../src/core/sidecar';

describe('computeSidecarPath', () => {
  it('maps note path under sidecar dir without touching markdown file', () => {
    const sidecarPath = computeSidecarPath(
      '.obsidian/plugins/reading-annotations/sidecars',
      'folder/My Note.md',
    );

    expect(sidecarPath).toContain('.obsidian/plugins/reading-annotations/sidecars');
    expect(sidecarPath.endsWith('.annotation.json')).toBe(true);
    expect(sidecarPath.includes('My%20Note.md')).toBe(true);
  });
});
