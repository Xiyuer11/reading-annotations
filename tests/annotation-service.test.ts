import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnnotationService } from '../src/core/annotation-service';
import { FileSidecarRepository } from '../src/core/sidecar-repository';
import { SqliteIndexStore } from '../src/core/sqlite-index';

describe('AnnotationService', () => {
  it('writes sidecar as source of truth and keeps sqlite index in sync', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'obsidian-anno-svc-'));
    const sidecarRoot = path.join(tmp, 'sidecars');
    const dbPath = path.join(tmp, 'index.sqlite');

    const repo = new FileSidecarRepository(sidecarRoot);
    const index = await SqliteIndexStore.open(dbPath);
    const service = new AnnotationService(repo, index);

    const notePath = 'folder/note.md';
    const noteContent = ['one', 'target text', 'three'].join('\n');

    const created = await service.createFromSelection({
      notePath,
      noteContent,
      selectedText: 'target text',
      startLine: 1,
      endLine: 1,
      thought: 'my idea',
      tags: ['spark'],
      source: { kind: 'manual', value: 'book x', display: 'book x' },
    });

    const sidecarPath = repo.pathFor(notePath);
    const raw = await readFile(sidecarPath, 'utf8');
    expect(raw).toContain('my idea');

    const found = await service.queryCurrentNote(notePath, 'my');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(created.id);

    await service.updateThought(created.id, notePath, 'my updated idea');
    const updated = await service.queryCurrentNote(notePath, 'updated');
    expect(updated).toHaveLength(1);

    await service.delete(created.id, notePath);
    const afterDelete = await service.queryCurrentNote(notePath, 'updated');
    expect(afterDelete).toHaveLength(0);

    await index.close();
    await rm(tmp, { recursive: true, force: true });
  });
});
