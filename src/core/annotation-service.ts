import { randomUUID } from 'node:crypto';
import { buildAnchorFromSelection, locateAnchorRange } from './anchor';
import { FileSidecarRepository } from './sidecar-repository';
import { SqliteIndexStore } from './sqlite-index';
import type {
  AnnotationAnchor,
  AnnotationRecord,
  AnnotationSource,
  AnchorResolution,
} from './types';

export interface CreateFromSelectionInput {
  notePath: string;
  noteContent: string;
  selectedText: string;
  startLine: number;
  endLine: number;
  thought: string;
  tags: string[];
  source: AnnotationSource;
}

export class AnnotationService {
  constructor(
    private readonly sidecar: FileSidecarRepository,
    private readonly index: SqliteIndexStore,
  ) {}

  async createFromSelection(input: CreateFromSelectionInput): Promise<AnnotationRecord> {
    const now = new Date().toISOString();
    const record: AnnotationRecord = {
      id: randomUUID(),
      notePath: input.notePath,
      thought: input.thought,
      tags: input.tags,
      source: input.source,
      createdAt: now,
      updatedAt: now,
      anchor: buildAnchorFromSelection(
        input.noteContent,
        input.selectedText,
        input.startLine,
        input.endLine,
      ),
    };

    await this.sidecar.upsert(input.notePath, record);
    await this.index.upsert(record);
    return record;
  }

  async queryCurrentNote(notePath: string, query: string): Promise<AnnotationRecord[]> {
    return this.index.queryByNote(notePath, query);
  }

  async getById(notePath: string, id: string): Promise<AnnotationRecord | null> {
    const all = await this.sidecar.readAll(notePath);
    return all.find((item) => item.id === id) ?? null;
  }

  async updateAnnotation(
    id: string,
    notePath: string,
    patch: {
      thought?: string;
      tags?: string[];
      source?: AnnotationSource;
      anchor?: AnnotationAnchor;
    },
  ): Promise<AnnotationRecord | null> {
    const all = await this.sidecar.readAll(notePath);
    const target = all.find((item) => item.id === id);
    if (!target) {
      return null;
    }

    if (patch.thought !== undefined) {
      target.thought = patch.thought;
    }
    if (patch.tags !== undefined) {
      target.tags = patch.tags;
    }
    if (patch.source !== undefined) {
      target.source = patch.source;
    }
    if (patch.anchor !== undefined) {
      target.anchor = patch.anchor;
    }
    target.updatedAt = new Date().toISOString();

    await this.sidecar.writeAll(notePath, all);
    await this.index.upsert(target);
    return target;
  }

  async updateThought(id: string, notePath: string, thought: string): Promise<AnnotationRecord | null> {
    return this.updateAnnotation(id, notePath, { thought });
  }

  async delete(id: string, notePath: string): Promise<void> {
    await this.sidecar.delete(notePath, id);
    await this.index.delete(id);
  }

  resolveInNote(noteContent: string, annotation: AnnotationRecord): AnchorResolution | null {
    return locateAnchorRange(noteContent, annotation.anchor);
  }
}
