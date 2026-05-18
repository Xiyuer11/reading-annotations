export type SourceKind = 'frontmatter' | 'url' | 'manual' | 'path';

export interface AnnotationSource {
  kind: SourceKind;
  value: string;
  display: string;
}

export interface AnnotationAnchor {
  selectedText: string;
  startLine: number;
  endLine: number;
  contextBefore: string;
  contextAfter: string;
}

export interface AnnotationRecord {
  id: string;
  notePath: string;
  thought: string;
  tags: string[];
  source: AnnotationSource;
  createdAt: string;
  updatedAt: string;
  anchor: AnnotationAnchor;
}

export interface AnchorResolution {
  startLine: number;
  endLine: number;
  startCh: number;
  endCh: number;
  resolved: boolean;
}
