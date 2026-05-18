import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { computeSidecarPath } from './sidecar';
import type { AnnotationRecord } from './types';

interface SidecarPayload {
  notePath: string;
  annotations: AnnotationRecord[];
}

export class FileSidecarRepository {
  constructor(private readonly sidecarRoot: string) {}

  pathFor(notePath: string): string {
    return computeSidecarPath(this.sidecarRoot, notePath);
  }

  async readAll(notePath: string): Promise<AnnotationRecord[]> {
    const sidecarPath = this.pathFor(notePath);

    try {
      const raw = await readFile(sidecarPath, 'utf8');
      const payload = JSON.parse(raw) as SidecarPayload;
      return payload.annotations ?? [];
    } catch {
      return [];
    }
  }

  async writeAll(notePath: string, annotations: AnnotationRecord[]): Promise<void> {
    const sidecarPath = this.pathFor(notePath);
    await mkdir(path.dirname(sidecarPath), { recursive: true });

    const payload: SidecarPayload = {
      notePath,
      annotations,
    };

    await writeFile(sidecarPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  async upsert(notePath: string, record: AnnotationRecord): Promise<void> {
    const existing = await this.readAll(notePath);
    const idx = existing.findIndex((item) => item.id === record.id);
    if (idx >= 0) {
      existing[idx] = record;
    } else {
      existing.push(record);
    }

    await this.writeAll(notePath, existing);
  }

  async delete(notePath: string, id: string): Promise<void> {
    const sidecarPath = this.pathFor(notePath);
    const existing = await this.readAll(notePath);
    const next = existing.filter((item) => item.id !== id);

    if (next.length === 0) {
      await rm(sidecarPath, { force: true });
      return;
    }

    await this.writeAll(notePath, next);
  }

  async getLastModified(notePath: string): Promise<number | null> {
    const sidecarPath = this.pathFor(notePath);
    try {
      const sidecarStat = await stat(sidecarPath);
      return sidecarStat.mtimeMs;
    } catch {
      return null;
    }
  }

  async readAllAnnotationsInVault(): Promise<AnnotationRecord[]> {
    const files = await this.collectSidecarFiles(this.sidecarRoot);
    const rows: AnnotationRecord[] = [];

    for (const filePath of files) {
      try {
        const raw = await readFile(filePath, 'utf8');
        const payload = JSON.parse(raw) as SidecarPayload;
        if (Array.isArray(payload.annotations)) {
          rows.push(...payload.annotations);
        }
      } catch {
        continue;
      }
    }

    return rows;
  }

  private async collectSidecarFiles(dirPath: string): Promise<string[]> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.collectSidecarFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith('.annotation.json')) {
        files.push(fullPath);
      }
    }

    return files;
  }
}
