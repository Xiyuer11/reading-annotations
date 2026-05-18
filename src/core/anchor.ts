import { AnnotationAnchor, AnchorResolution } from './types';

function getLineOffsets(text: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function offsetToLine(offsets: number[], pos: number): number {
  let lo = 0;
  let hi = offsets.length - 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsets[mid] <= pos) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return Math.max(0, lo - 1);
}

export function buildAnchorFromSelection(
  noteText: string,
  selectedText: string,
  startLine: number,
  endLine: number,
): AnnotationAnchor {
  const lines = noteText.split('\n');
  const before = startLine > 0 ? lines[startLine - 1] ?? '' : '';
  const after = endLine + 1 < lines.length ? lines[endLine + 1] ?? '' : '';

  return {
    selectedText,
    startLine,
    endLine,
    contextBefore: before,
    contextAfter: after,
  };
}

export function locateAnchorRange(noteText: string, anchor: AnnotationAnchor): AnchorResolution | null {
  const lines = noteText.split('\n');

  if (anchor.startLine >= 0 && anchor.endLine < lines.length) {
    const chunk = lines.slice(anchor.startLine, anchor.endLine + 1).join('\n');
    const pos = chunk.indexOf(anchor.selectedText);
    if (pos >= 0) {
      const firstLine = lines[anchor.startLine] ?? '';
      const linePos = firstLine.indexOf(anchor.selectedText);
      return {
        startLine: anchor.startLine,
        endLine: anchor.endLine,
        startCh: linePos >= 0 ? linePos : 0,
        endCh: (linePos >= 0 ? linePos : 0) + anchor.selectedText.length,
        resolved: true,
      };
    }
  }

  const offsets = getLineOffsets(noteText);
  let idx = noteText.indexOf(anchor.selectedText);

  while (idx >= 0) {
    const startLine = offsetToLine(offsets, idx);
    const endLine = offsetToLine(offsets, idx + anchor.selectedText.length);
    const beforeLine = startLine > 0 ? lines[startLine - 1] ?? '' : '';
    const afterLine = endLine + 1 < lines.length ? lines[endLine + 1] ?? '' : '';

    const beforeOk = anchor.contextBefore.length === 0 || beforeLine.includes(anchor.contextBefore);
    const afterOk = anchor.contextAfter.length === 0 || afterLine.includes(anchor.contextAfter);

    if (beforeOk || afterOk) {
      return {
        startLine,
        endLine,
        startCh: idx - offsets[startLine],
        endCh: idx - offsets[startLine] + anchor.selectedText.length,
        resolved: true,
      };
    }

    idx = noteText.indexOf(anchor.selectedText, idx + Math.max(1, anchor.selectedText.length));
  }

  return null;
}
