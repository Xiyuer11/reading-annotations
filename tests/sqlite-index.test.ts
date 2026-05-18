import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteIndexStore } from '../src/core/sqlite-index';
import type { AnnotationRecord } from '../src/core/types';

function fixture(id: string, thought = 'idea'): AnnotationRecord {
  return {
    id,
    notePath: 'notes/a.md',
    thought,
    tags: ['reading'],
    source: { kind: 'path', value: 'notes/a.md', display: 'notes/a.md' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    anchor: {
      selectedText: 'target',
      startLine: 1,
      endLine: 1,
      contextBefore: 'a',
      contextAfter: 'b',
    },
  };
}

describe('SqliteIndexStore', () => {
  it('upserts, queries, and deletes annotations', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'obsidian-anno-'));
    const dbPath = path.join(tmp, 'index.sqlite');

    const store = await SqliteIndexStore.open(dbPath);
    await store.upsert(fixture('1', 'first thought'));
    await store.upsert(fixture('2', 'second thought'));

    const matches = await store.queryByNote('notes/a.md', 'second');
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('2');

    await store.delete('2');

    const afterDelete = await store.queryByNote('notes/a.md', 'second');
    expect(afterDelete).toHaveLength(0);

    await store.close();
    await rm(tmp, { recursive: true, force: true });
  });
});
