import { AnnotationSource } from './types';

export function resolveDefaultSource(
  notePath: string,
  frontmatter: Record<string, unknown> | null,
  sourceFieldPriority: string[],
): AnnotationSource {
  for (const field of sourceFieldPriority) {
    const value = frontmatter?.[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      const looksLikeUrl = /^https?:\/\//i.test(value.trim());
      return {
        kind: looksLikeUrl ? 'url' : 'frontmatter',
        value: value.trim(),
        display: value.trim(),
      };
    }
  }

  return {
    kind: 'path',
    value: notePath,
    display: notePath,
  };
}
