import { describe, expect, it } from 'vitest';
import { resolveDefaultSource } from '../src/core/source';

describe('resolveDefaultSource', () => {
  it('uses first matching frontmatter field by priority', () => {
    const source = resolveDefaultSource(
      'notes/a.md',
      { source: 'Book A', url: 'https://example.com' },
      ['url', 'source'],
    );

    expect(source.kind).toBe('url');
    expect(source.value).toBe('https://example.com');
    expect(source.display).toBe('https://example.com');
  });

  it('falls back to note path when no source field exists', () => {
    const source = resolveDefaultSource('notes/a.md', { title: 'A' }, ['source', 'url']);

    expect(source.kind).toBe('path');
    expect(source.value).toBe('notes/a.md');
    expect(source.display).toBe('notes/a.md');
  });
});
