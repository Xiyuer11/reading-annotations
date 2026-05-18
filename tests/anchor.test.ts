import { describe, expect, it } from 'vitest';
import { buildAnchorFromSelection, locateAnchorRange } from '../src/core/anchor';

describe('anchor hybrid strategy', () => {
  it('locates by line range and exact text when unchanged', () => {
    const note = ['alpha', 'beta target text', 'gamma'].join('\n');
    const anchor = buildAnchorFromSelection(note, 'target text', 1, 1);

    const range = locateAnchorRange(note, anchor);

    expect(range).not.toBeNull();
    expect(range?.resolved).toBe(true);
    expect(range?.startLine).toBe(1);
  });

  it('falls back to context search when line offset changed', () => {
    const original = ['alpha', 'beta target text', 'gamma'].join('\n');
    const anchor = buildAnchorFromSelection(original, 'target text', 1, 1);
    const edited = ['new heading', 'alpha', 'beta target text', 'gamma'].join('\n');

    const range = locateAnchorRange(edited, anchor);

    expect(range).not.toBeNull();
    expect(range?.resolved).toBe(true);
    expect(range?.startLine).toBe(2);
  });
});
