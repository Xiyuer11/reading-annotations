import {
  App,
  Editor,
  EditorPosition,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from 'obsidian';
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import path from 'node:path';
import { AnnotationService } from './core/annotation-service';
import { FileSidecarRepository } from './core/sidecar-repository';
import { SqliteIndexStore } from './core/sqlite-index';
import type { AnnotationRecord } from './core/types';
import type { AnchorResolution } from './core/types';
import { AnnotationModal } from './ui/annotation-modal';
import {
  AnnotationListView,
  READING_ANNOTATION_VIEW,
  type AnnotationViewHost,
} from './ui/annotation-view';

interface ReadingAnnotationsSettings {
  sourceFieldPriority: string[];
  highlightPersistenceMode: 'virtual' | 'markdown';
}

const DEFAULT_SETTINGS: ReadingAnnotationsSettings = {
  sourceFieldPriority: ['source', 'url', 'reference'],
  highlightPersistenceMode: 'markdown',
};

interface SelectionContext {
  file: TFile;
  view: MarkdownView;
  mode: 'source' | 'preview';
  selectedText: string;
  startLine: number;
  endLine: number;
  noteContent: string;
  editor?: Editor;
  from?: EditorPosition;
  to?: EditorPosition;
  selectionRect?: DOMRect;
  hostRect?: DOMRect;
}

interface InlineHighlightRange {
  from: number;
  to: number;
}

interface ResolvedInlineHighlight {
  selectedText: string;
  resolved: AnchorResolution;
}

const setInlineHighlightRangesEffect = StateEffect.define<InlineHighlightRange[]>();
const inlineHighlightMark = Decoration.mark({ class: 'reading-annotations-inline-mark' });
const inlineHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setInlineHighlightRangesEffect)) {
        continue;
      }
      const builder = new RangeSetBuilder<Decoration>();
      for (const range of effect.value) {
        const from = Math.max(0, Math.min(range.from, range.to));
        const to = Math.max(from, Math.max(range.from, range.to));
        if (to > from) {
          builder.add(from, to, inlineHighlightMark);
        }
      }
      next = builder.finish();
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export default class ReadingAnnotationsPlugin extends Plugin implements AnnotationViewHost {
  settings: ReadingAnnotationsSettings = DEFAULT_SETTINGS;

  private sidecarRepo: FileSidecarRepository | null = null;
  private indexStore: SqliteIndexStore | null = null;
  private annotationService: AnnotationService | null = null;
  private indexPath: string | null = null;
  private inlineCommentTriggerEl: HTMLButtonElement | null = null;
  private pendingSelection: SelectionContext | null = null;
  private highlightRefreshTimer: number | null = null;
  private isAnnotationModalOpen = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    try {
      await this.initializeStorage();
    } catch (error) {
      console.error(error);
      new Notice('Reading Annotations 初始化失败，请检查桌面端环境。');
      return;
    }

    this.registerView(
      READING_ANNOTATION_VIEW,
      (leaf) => new AnnotationListView(leaf, this),
    );
    this.registerEditorExtension(inlineHighlightField);
    this.app.workspace.updateOptions();

    this.addCommand({
      id: 'add-annotation-from-selection',
      name: 'Add Annotation From Selection',
      editorCallback: async (editor, view) => {
        const file = view.file ?? null;
        if (!file) {
          new Notice('未找到当前笔记文件。');
          return;
        }
        const selection = this.createSelectionContext(view as MarkdownView, editor, file);
        if (!selection) {
          new Notice('请先选择一段文本。');
          return;
        }
        await this.openAnnotationCard(selection);
      },
      callback: async () => {
        const selection = this.getActiveSelectionContext();
        if (!selection) {
          new Notice('请先选择一段文本。');
          return;
        }
        await this.openAnnotationCard(selection);
      },
    });

    this.addCommand({
      id: 'open-current-note-annotations',
      name: 'Open Current Note Annotations',
      callback: async () => {
        await this.activateAnnotationView();
      },
    });

    this.addCommand({
      id: 'rebuild-annotation-index',
      name: 'Rebuild Annotation Index',
      callback: async () => {
        await this.rebuildIndex();
      },
    });

    this.registerEvent(
      this.app.workspace.on('file-open', async (file) => {
        if (!file) {
          return;
        }
        await this.refreshIndexForNoteIfNeeded(file.path);
        await this.refreshView();
        this.scheduleHighlightRefresh();
        this.updateInlineCommentTrigger();
      }),
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.scheduleHighlightRefresh(10);
      }),
    );
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.scheduleHighlightRefresh(20);
      }),
    );
    this.registerEvent(
      this.app.workspace.on('editor-change', () => {
        this.scheduleHighlightRefresh(20);
      }),
    );

    this.addRibbonIcon('highlighter', '当前笔记标注', async () => {
      await this.activateAnnotationView();
    });

    this.addSettingTab(new ReadingAnnotationsSettingTab(this.app, this));

    this.setupInlineCommentTrigger();
    this.registerDomEvent(document, 'selectionchange', () => {
      this.updateInlineCommentTrigger();
    });
    this.registerDomEvent(window, 'resize', () => {
      this.updateInlineCommentTrigger();
    });
    this.registerDomEvent(window, 'scroll', () => {
      this.updateInlineCommentTrigger();
    }, true);
    this.registerInterval(window.setInterval(() => {
      this.updateInlineCommentTrigger();
    }, 220));
    this.registerInterval(window.setInterval(() => {
      this.scheduleHighlightRefresh(40);
    }, 700));
    this.scheduleHighlightRefresh(120);
  }

  async onunload(): Promise<void> {
    this.inlineCommentTriggerEl?.remove();
    this.inlineCommentTriggerEl = null;
    this.pendingSelection = null;
    this.isAnnotationModalOpen = false;
    if (this.highlightRefreshTimer != null) {
      window.clearTimeout(this.highlightRefreshTimer);
      this.highlightRefreshTimer = null;
    }
    this.clearAllInlineHighlights();

    if (this.indexStore) {
      await this.indexStore.close();
    }
  }

  getActiveFile(): TFile | null {
    const active = this.app.workspace.getActiveFile();
    if (active) {
      return active;
    }

    const activeMarkdown = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeMarkdown?.file) {
      return activeMarkdown.file;
    }

    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) {
        return view.file;
      }
    }

    return null;
  }

  async queryCurrentNote(query: string): Promise<AnnotationRecord[]> {
    if (!this.annotationService) {
      return [];
    }

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      return [];
    }

    return this.annotationService.queryCurrentNote(file.path, query);
  }

  async jumpToAnnotation(record: AnnotationRecord): Promise<void> {
    if (!this.annotationService) {
      return;
    }

    const target = this.app.vault.getAbstractFileByPath(record.notePath);
    if (!(target instanceof TFile)) {
      new Notice('原文文件不存在或已移动。');
      return;
    }

    try {
      const leaf = await this.pickLeafForTarget(target);
      if (!leaf) {
        new Notice('无法找到可用的正文视图。');
        return;
      }

      const currentView = leaf.view;
      const currentFile =
        currentView instanceof MarkdownView ? (currentView.file ?? null) : null;

      if (!currentFile || currentFile.path !== target.path) {
        await leaf.openFile(target);
      }
      this.app.workspace.revealLeaf(leaf);

      const content = await this.app.vault.read(target);
      const resolved = this.annotationService.resolveInNote(content, record);
      if (!resolved) {
        new Notice('未定位到原文位置，请删除后重新标注。');
        return;
      }

      const openedView = leaf.view;
      if (!(openedView instanceof MarkdownView)) {
        new Notice('无法打开原文编辑视图。');
        return;
      }

      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      const markdownView = openedView;
      if (markdownView.getMode() === 'source') {
        this.jumpInSourceMode(markdownView, resolved);
        return;
      }

      const jumpedInPreview = this.jumpInPreviewMode(markdownView, resolved, record.anchor.selectedText);
      if (jumpedInPreview) {
        return;
      }

      const modeSwitchable = markdownView as MarkdownView & {
        setMode?: (mode: 'source' | 'preview') => Promise<void> | void;
      };
      if (typeof modeSwitchable.setMode !== 'function') {
        new Notice('跳转失败，当前阅读模式无法定位。');
        return;
      }

      await modeSwitchable.setMode('source');
      const refreshedView = leaf.view;
      if (!(refreshedView instanceof MarkdownView)) {
        new Notice('跳转失败，无法切换到可定位视图。');
        return;
      }
      this.jumpInSourceMode(refreshedView, resolved);
    } catch (error) {
      console.error('Reading Annotations jump failed', error);
      new Notice('跳转失败，已保留当前布局，请重试。');
    }
  }

  private jumpInSourceMode(markdownView: MarkdownView, resolved: AnchorResolution): void {
    markdownView.editor.focus();
    markdownView.editor.setSelection(
      { line: resolved.startLine, ch: resolved.startCh },
      { line: resolved.endLine, ch: resolved.endCh },
    );
    markdownView.editor.scrollIntoView(
      {
        from: { line: resolved.startLine, ch: resolved.startCh },
        to: { line: resolved.endLine, ch: resolved.endCh },
      },
      true,
    );
  }

  private jumpInPreviewMode(
    markdownView: MarkdownView,
    resolved: AnchorResolution,
    selectedText: string,
  ): boolean {
    const previewRoot =
      markdownView.containerEl.querySelector<HTMLElement>('.markdown-reading-view .markdown-preview-view') ??
      markdownView.containerEl.querySelector<HTMLElement>('.markdown-preview-view') ??
      markdownView.previewMode?.containerEl ??
      null;
    if (!previewRoot) {
      return false;
    }

    const anchors = Array.from(
      previewRoot.querySelectorAll<HTMLElement>('[data-line], [data-line-start], [data-section-start]'),
    ).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.height > 0 && rect.width > 0;
    });
    if (anchors.length === 0) {
      return false;
    }

    const targetLine = resolved.startLine;
    const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
    const parseLine = (el: HTMLElement): number | null => {
      const raw =
        el.getAttribute('data-line') ??
        el.getAttribute('data-line-start') ??
        el.getAttribute('data-section-start') ??
        '';
      const line = Number.parseInt(String(raw).match(/\d+/)?.[0] ?? '', 10);
      return Number.isNaN(line) ? null : line;
    };

    const needle = normalize(selectedText);
    const shortNeedle = needle.length > 120 ? needle.slice(0, 120) : needle;
    const textCandidates: Array<{ el: HTMLElement; line: number; distance: number; textLen: number }> = [];

    if (shortNeedle.length >= 2) {
      for (const el of anchors) {
        const line = parseLine(el);
        if (line == null) {
          continue;
        }
        const textNorm = normalize(el.textContent ?? '');
        if (!textNorm || !textNorm.includes(shortNeedle)) {
          continue;
        }
        textCandidates.push({
          el,
          line,
          distance: Math.abs(line - targetLine),
          textLen: textNorm.length,
        });
      }
    }

    const byBetterCandidate = (
      a: { distance: number; textLen: number; line: number },
      b: { distance: number; textLen: number; line: number },
    ): number => {
      if (a.distance !== b.distance) {
        return a.distance - b.distance;
      }
      if (a.textLen !== b.textLen) {
        return a.textLen - b.textLen;
      }
      return a.line - b.line;
    };

    let targetBlock: HTMLElement | null = null;
    if (textCandidates.length > 0) {
      textCandidates.sort(byBetterCandidate);
      targetBlock = textCandidates[0].el;
    }

    if (!targetBlock) {
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const el of anchors) {
        const line = parseLine(el);
        if (line == null) {
          continue;
        }
        const distance = Math.abs(line - targetLine);
        if (distance < bestDistance) {
          bestDistance = distance;
          targetBlock = el;
        }
      }
    }

    if (!targetBlock) {
      return false;
    }

    targetBlock.scrollIntoView({ block: 'center', inline: 'nearest' });

    for (const old of previewRoot.querySelectorAll('.reading-annotations-jump-highlight')) {
      old.classList.remove('reading-annotations-jump-highlight');
    }
    targetBlock.classList.add('reading-annotations-jump-highlight');
    window.setTimeout(() => {
      targetBlock?.classList.remove('reading-annotations-jump-highlight');
    }, 1800);

    if (selectedText) {
      const escaped = selectedText.slice(0, 80).replace(/\s+/g, ' ').trim();
      if (escaped.length > 0) {
        targetBlock.setAttribute('data-reading-annotations-hit', escaped);
      }
    }
    return true;
  }

  private async pickLeafForTarget(target: TFile): Promise<WorkspaceLeaf | null> {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf) {
      try {
        if (activeLeaf.isDeferred) {
          await activeLeaf.loadIfDeferred();
        }
      } catch {
        // no-op: continue with best-effort selection
      }
    }

    const activeMarkdown = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeMarkdown) {
      return activeMarkdown.leaf;
    }

    const markdownLeaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of markdownLeaves) {
      try {
        if (leaf.isDeferred) {
          await leaf.loadIfDeferred();
        }
      } catch {
        // ignore deferred load failures and keep scanning
      }
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === target.path) {
        return leaf;
      }
    }

    for (const leaf of markdownLeaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        return leaf;
      }
    }

    const fallback = this.app.workspace.getLeaf(false);
    if (fallback.isDeferred) {
      try {
        await fallback.loadIfDeferred();
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  async editAnnotation(record: AnnotationRecord): Promise<void> {
    if (!this.annotationService) {
      return;
    }

    new AnnotationModal(this.app, {
      title: '编辑标注',
      initialThought: record.thought,
      onSubmit: async (result) => {
        await this.annotationService?.updateAnnotation(record.id, record.notePath, {
          thought: result.thought,
        });
        await this.refreshView();
        this.scheduleHighlightRefresh();
        new Notice('标注已更新');
      },
    }).open();
  }

  async deleteAnnotation(record: AnnotationRecord): Promise<void> {
    await this.removeMarkdownHighlightIfOrphan(record);
    await this.annotationService?.delete(record.id, record.notePath);
    this.scheduleHighlightRefresh();
  }

  private setupInlineCommentTrigger(): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reading-annotations-inline-trigger';
    button.title = '添加评论';
    button.innerHTML = '<span class="reading-annotations-inline-icon">💬</span><span>评论</span>';
    button.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
    });
    button.addEventListener('click', async (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (!this.pendingSelection) {
        this.updateInlineCommentTrigger();
      }
      if (!this.pendingSelection) {
        return;
      }
      const selection = this.pendingSelection;
      this.clearSelectionVisualState(selection);
      this.hideInlineCommentTrigger();
      await this.openAnnotationCard(selection);
    });

    document.body.appendChild(button);
    this.inlineCommentTriggerEl = button;
    this.hideInlineCommentTrigger();
  }

  private hideInlineCommentTrigger(): void {
    if (!this.inlineCommentTriggerEl) {
      return;
    }
    this.inlineCommentTriggerEl.classList.remove('is-visible');
    this.pendingSelection = null;
  }

  private updateInlineCommentTrigger(): void {
    if (this.isAnnotationModalOpen) {
      this.hideInlineCommentTrigger();
      return;
    }
    const selection = this.getActiveSelectionContext();
    if (!selection) {
      this.hideInlineCommentTrigger();
      return;
    }

    if (!selection.selectionRect || !selection.hostRect) {
      this.hideInlineCommentTrigger();
      return;
    }

    if (!this.inlineCommentTriggerEl) {
      return;
    }

    this.pendingSelection = selection;
    this.inlineCommentTriggerEl.classList.add('is-visible');

    const triggerWidth = this.inlineCommentTriggerEl.offsetWidth || 62;
    const triggerHeight = this.inlineCommentTriggerEl.offsetHeight || 26;
    const left = Math.max(selection.hostRect.left + 8, selection.hostRect.right - triggerWidth - 10);
    const selectionMidY = selection.selectionRect.top + (selection.selectionRect.height / 2);
    const top = Math.max(
      selection.hostRect.top + 8,
      Math.min(selection.hostRect.bottom - triggerHeight - 8, selectionMidY - (triggerHeight / 2)),
    );

    this.inlineCommentTriggerEl.style.left = `${Math.round(left)}px`;
    this.inlineCommentTriggerEl.style.top = `${Math.round(top)}px`;
  }

  private getActiveSelectionContext(): SelectionContext | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) {
      return null;
    }

    if (view.getMode() === 'source') {
      return this.createSelectionContext(view, view.editor, view.file);
    }

    return this.createPreviewSelectionContext(view, view.file);
  }

  private createSelectionContext(view: MarkdownView, editor: Editor, file: TFile): SelectionContext | null {
    const selectedText = editor.getSelection().trim();
    if (!selectedText) {
      return null;
    }

    const cm = (editor as Editor & {
      cm?: { coordsAtPos?: (offset: number) => DOMRect | null; dom?: HTMLElement };
    }).cm;
    if (!cm?.coordsAtPos || !cm.dom) {
      return null;
    }

    const from = editor.getCursor('from');
    const to = editor.getCursor('to');
    const fromOffset = editor.posToOffset(from);
    const toOffset = editor.posToOffset(to);
    const coords = cm.coordsAtPos(fromOffset);
    const endCoords = cm.coordsAtPos(Math.max(fromOffset, toOffset - 1));
    if (!coords || !endCoords) {
      return null;
    }

    const hostRect = cm.dom.getBoundingClientRect();
    if (coords.top < hostRect.top - 6 || coords.top > hostRect.bottom + 6) {
      return null;
    }
    const left = Math.min(coords.left, endCoords.left);
    const right = Math.max(coords.right, endCoords.right);
    const top = Math.min(coords.top, endCoords.top);
    const bottom = Math.max(coords.bottom, endCoords.bottom);
    const selectionRect = new DOMRect(
      left,
      top,
      Math.max(1, right - left),
      Math.max(1, bottom - top),
    );

    return {
      file,
      view,
      mode: 'source',
      editor,
      selectedText,
      from,
      to,
      startLine: from.line,
      endLine: to.line,
      noteContent: editor.getValue(),
      selectionRect,
      hostRect,
    };
  }

  private createPreviewSelectionContext(view: MarkdownView, file: TFile): SelectionContext | null {
    const domSelection = window.getSelection();
    if (!domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) {
      return null;
    }

    const range = domSelection.getRangeAt(0);
    const selectedText = domSelection.toString().trim();
    if (!selectedText) {
      return null;
    }

    const previewRoot = this.getPreviewRoot(view);
    if (!previewRoot || !previewRoot.contains(range.commonAncestorContainer)) {
      return null;
    }

    const noteContent = view.editor.getValue();
    const hintStart = this.extractPreviewLineFromNode(range.startContainer, previewRoot);
    const hintEnd = this.extractPreviewLineFromNode(range.endContainer, previewRoot);
    const lines = this.estimateSelectionLines(noteContent, selectedText, hintStart, hintEnd);

    const selectionRect = range.getBoundingClientRect();
    const hostRect = previewRoot.getBoundingClientRect();
    if (!selectionRect || selectionRect.height === 0 || hostRect.height === 0) {
      return null;
    }

    return {
      file,
      view,
      mode: 'preview',
      selectedText,
      startLine: lines.startLine,
      endLine: lines.endLine,
      noteContent,
      selectionRect,
      hostRect,
    };
  }

  private getPreviewRoot(view: MarkdownView): HTMLElement | null {
    return (
      view.containerEl.querySelector<HTMLElement>('.markdown-reading-view .markdown-preview-view') ??
      view.containerEl.querySelector<HTMLElement>('.markdown-preview-view')
    );
  }

  private extractPreviewLineFromNode(node: Node | null, root: HTMLElement): number | null {
    let current: HTMLElement | null = node instanceof HTMLElement ? node : node?.parentElement ?? null;
    while (current) {
      const raw =
        current.getAttribute('data-line') ??
        current.getAttribute('data-line-start') ??
        current.getAttribute('data-section-start');
      if (raw) {
        const parsed = Number.parseInt(String(raw).match(/\d+/)?.[0] ?? '', 10);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
      if (current === root) {
        break;
      }
      current = current.parentElement;
    }
    return null;
  }

  private estimateSelectionLines(
    noteContent: string,
    selectedText: string,
    hintStart: number | null,
    hintEnd: number | null,
  ): { startLine: number; endLine: number } {
    const totalLines = Math.max(1, noteContent.split('\n').length);
    const fallbackStart = this.clampLine(hintStart ?? 0, totalLines);
    const fallbackEnd = this.clampLine(hintEnd ?? fallbackStart, totalLines);

    const matches = this.findSelectionLineMatches(noteContent, selectedText, 80);
    if (matches.length === 0) {
      return { startLine: Math.min(fallbackStart, fallbackEnd), endLine: Math.max(fallbackStart, fallbackEnd) };
    }

    if (hintStart == null) {
      return matches[0];
    }

    let best = matches[0];
    let bestDistance = Math.abs(best.startLine - hintStart);
    for (const match of matches) {
      const distance = Math.abs(match.startLine - hintStart);
      if (distance < bestDistance) {
        best = match;
        bestDistance = distance;
      }
    }
    return best;
  }

  private findSelectionLineMatches(
    noteContent: string,
    selectedText: string,
    limit: number,
  ): Array<{ startLine: number; endLine: number }> {
    const rows: Array<{ startLine: number; endLine: number }> = [];
    if (!selectedText) {
      return rows;
    }

    let cursor = 0;
    while (rows.length < limit) {
      const idx = noteContent.indexOf(selectedText, cursor);
      if (idx < 0) {
        break;
      }
      const startLine = this.offsetToLine(noteContent, idx);
      const endLine = this.offsetToLine(noteContent, idx + Math.max(0, selectedText.length - 1));
      rows.push({ startLine, endLine });
      cursor = idx + Math.max(1, selectedText.length);
    }
    return rows;
  }

  private offsetToLine(content: string, offset: number): number {
    const bounded = Math.max(0, Math.min(content.length, offset));
    let line = 0;
    for (let i = 0; i < bounded; i += 1) {
      if (content.charCodeAt(i) === 10) {
        line += 1;
      }
    }
    return line;
  }

  private clampLine(line: number, totalLines: number): number {
    return Math.max(0, Math.min(totalLines - 1, line));
  }

  private async openAnnotationCard(selection: SelectionContext): Promise<void> {
    if (!this.annotationService) {
      return;
    }
    const selectedSource = selection.selectedText;
    this.isAnnotationModalOpen = true;
    this.hideInlineCommentTrigger();

    new AnnotationModal(this.app, {
      title: '评论标注',
      initialThought: '',
      onClose: () => {
        this.isAnnotationModalOpen = false;
        this.clearSelectionVisualState(selection);
        this.hideInlineCommentTrigger();
      },
      onSubmit: async (result) => {
        const persisted = await this.persistHighlightForSelection(selection);
        await this.annotationService?.createFromSelection({
          notePath: selection.file.path,
          noteContent: persisted.noteContent,
          selectedText: persisted.selectedText,
          startLine: persisted.startLine,
          endLine: persisted.endLine,
          thought: result.thought,
          tags: [],
          source: {
            kind: 'manual',
            value: selectedSource,
            display: selectedSource,
          },
        });
        await this.activateAnnotationView();
        await this.refreshView();
        this.scheduleHighlightRefresh();
        this.clearSelectionVisualState(selection);
        new Notice('标注已保存');
      },
    }).open();
  }

  private clearSelectionVisualState(selection?: SelectionContext): void {
    try {
      const domSel = window.getSelection();
      if (domSel && domSel.rangeCount > 0) {
        domSel.removeAllRanges();
      }
    } catch {
      // ignore browser selection clear failures
    }

    const view = selection?.view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== 'source') {
      return;
    }
    const editor = selection?.editor ?? view.editor;
    const cursor = selection?.to ?? editor.getCursor('to');
    editor.setSelection(cursor, cursor);
  }

  private async removeMarkdownHighlightIfOrphan(record: AnnotationRecord): Promise<void> {
    if (this.settings.highlightPersistenceMode !== 'markdown' || !this.annotationService) {
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(record.notePath);
    if (!(file instanceof TFile)) {
      return;
    }

    const content = await this.app.vault.read(file);
    const target = this.annotationService.resolveInNote(content, record);
    if (!target) {
      return;
    }

    const siblings = await this.annotationService.queryCurrentNote(record.notePath, '');
    for (const sibling of siblings) {
      if (sibling.id === record.id) {
        continue;
      }
      const siblingResolved = this.annotationService.resolveInNote(content, sibling);
      if (!siblingResolved) {
        continue;
      }
      const sameRange =
        siblingResolved.startLine === target.startLine &&
        siblingResolved.startCh === target.startCh &&
        siblingResolved.endLine === target.endLine &&
        siblingResolved.endCh === target.endCh;
      if (sameRange) {
        return;
      }
    }

    const startOffset = this.positionToOffset(content, target.startLine, target.startCh);
    const endOffset = this.positionToOffset(content, target.endLine, target.endCh);
    if (endOffset <= startOffset) {
      return;
    }

    const before = content.slice(Math.max(0, startOffset - 2), startOffset);
    const after = content.slice(endOffset, Math.min(content.length, endOffset + 2));
    if (before !== '==' || after !== '==') {
      return;
    }

    const next =
      content.slice(0, startOffset - 2) +
      content.slice(startOffset, endOffset) +
      content.slice(endOffset + 2);
    await this.app.vault.modify(file, next);
  }

  private positionToOffset(content: string, line: number, ch: number): number {
    const lines = content.split('\n');
    const safeLine = Math.max(0, Math.min(lines.length - 1, line));
    let offset = 0;
    for (let i = 0; i < safeLine; i += 1) {
      offset += (lines[i]?.length ?? 0) + 1;
    }
    const safeCh = Math.max(0, Math.min(lines[safeLine]?.length ?? 0, ch));
    return offset + safeCh;
  }

  private async persistHighlightForSelection(
    selection: SelectionContext,
  ): Promise<{ noteContent: string; selectedText: string; startLine: number; endLine: number }> {
    if (this.settings.highlightPersistenceMode !== 'markdown') {
      return {
        noteContent: selection.noteContent,
        selectedText: selection.selectedText,
        startLine: selection.startLine,
        endLine: selection.endLine,
      };
    }

    const selectedText = selection.selectedText.trim();
    if (!selectedText) {
      return {
        noteContent: selection.noteContent,
        selectedText: selection.selectedText,
        startLine: selection.startLine,
        endLine: selection.endLine,
      };
    }

    if (selection.mode === 'source' && selection.editor && selection.from && selection.to) {
      const editor = selection.editor;
      const current = editor.getValue();
      const fromOffset = editor.posToOffset(selection.from);
      const toOffset = editor.posToOffset(selection.to);
      const before = current.slice(Math.max(0, fromOffset - 2), fromOffset);
      const after = current.slice(toOffset, Math.min(current.length, toOffset + 2));
      if (before !== '==' || after !== '==') {
        const original = editor.getRange(selection.from, selection.to);
        editor.replaceRange(`==${original}==`, selection.from, selection.to);
      }

      return {
        noteContent: editor.getValue(),
        selectedText,
        startLine: selection.startLine,
        endLine: selection.endLine,
      };
    }

    const content = await this.app.vault.read(selection.file);
    const hit = this.findNearestSelectionOffset(content, selectedText, selection.startLine);
    if (!hit) {
      return {
        noteContent: content,
        selectedText,
        startLine: selection.startLine,
        endLine: selection.endLine,
      };
    }
    const before = content.slice(Math.max(0, hit.startOffset - 2), hit.startOffset);
    const after = content.slice(hit.endOffset, Math.min(content.length, hit.endOffset + 2));
    let next = content;
    if (before !== '==' || after !== '==') {
      next = `${content.slice(0, hit.startOffset)}==${content.slice(hit.startOffset, hit.endOffset)}==${content.slice(hit.endOffset)}`;
      await this.app.vault.modify(selection.file, next);
    }
    return {
      noteContent: next,
      selectedText,
      startLine: hit.startLine,
      endLine: hit.endLine,
    };
  }

  private findNearestSelectionOffset(
    content: string,
    selectedText: string,
    hintLine: number,
  ): { startOffset: number; endOffset: number; startLine: number; endLine: number } | null {
    let cursor = 0;
    let best:
      | { startOffset: number; endOffset: number; startLine: number; endLine: number; distance: number }
      | null = null;
    while (cursor < content.length) {
      const idx = content.indexOf(selectedText, cursor);
      if (idx < 0) {
        break;
      }
      const startLine = this.offsetToLine(content, idx);
      const endLine = this.offsetToLine(content, idx + Math.max(0, selectedText.length - 1));
      const distance = Math.abs(startLine - hintLine);
      if (!best || distance < best.distance) {
        best = {
          startOffset: idx,
          endOffset: idx + selectedText.length,
          startLine,
          endLine,
          distance,
        };
      }
      cursor = idx + Math.max(1, selectedText.length);
    }
    if (!best) {
      return null;
    }
    return {
      startOffset: best.startOffset,
      endOffset: best.endOffset,
      startLine: best.startLine,
      endLine: best.endLine,
    };
  }

  private async activateAnnotationView(): Promise<void> {
    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(READING_ANNOTATION_VIEW)[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice('无法打开标注视图。');
        return;
      }
      await leaf.setViewState({
        type: READING_ANNOTATION_VIEW,
        active: true,
      });
    }

    this.app.workspace.revealLeaf(leaf);
    await this.refreshView();
  }

  private async refreshView(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(READING_ANNOTATION_VIEW)[0];
    if (!leaf) {
      return;
    }

    const view = leaf.view;
    if (view instanceof AnnotationListView) {
      await view.refresh();
    }
    this.scheduleHighlightRefresh(20);
  }

  private async initializeStorage(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('Reading Annotations requires FileSystemAdapter');
    }

    const vaultRoot = adapter.getBasePath();
    const pluginRoot = path.join(vaultRoot, this.app.vault.configDir, 'plugins', this.manifest.id);
    const sidecarRoot = path.join(pluginRoot, 'sidecars');
    const indexPath = path.join(pluginRoot, 'annotation-index.sqlite');

    this.sidecarRepo = new FileSidecarRepository(sidecarRoot);
    this.indexStore = await SqliteIndexStore.open(indexPath);
    this.annotationService = new AnnotationService(this.sidecarRepo, this.indexStore);
    this.indexPath = indexPath;
  }

  private async refreshIndexForNoteIfNeeded(notePath: string): Promise<void> {
    if (!this.sidecarRepo || !this.indexStore || !this.indexPath) {
      return;
    }

    const sidecarMtime = await this.sidecarRepo.getLastModified(notePath);
    if (!sidecarMtime) {
      return;
    }

    let indexMtime = 0;
    try {
      const fs = await import('node:fs/promises');
      const s = await fs.stat(this.indexPath);
      indexMtime = s.mtimeMs;
    } catch {
      indexMtime = 0;
    }

    if (sidecarMtime <= indexMtime) {
      return;
    }

    const records = await this.sidecarRepo.readAll(notePath);
    for (const record of records) {
      await this.indexStore.upsert(record);
    }
  }

  async rebuildIndex(): Promise<void> {
    if (!this.sidecarRepo || !this.indexStore) {
      return;
    }
    const all = await this.sidecarRepo.readAllAnnotationsInVault();
    await this.indexStore.rebuildFromAnnotations(all);
    new Notice(`索引已重建，共 ${all.length} 条标注。`);
    await this.refreshView();
    this.scheduleHighlightRefresh();
  }

  private scheduleHighlightRefresh(delayMs = 60): void {
    if (this.highlightRefreshTimer != null) {
      window.clearTimeout(this.highlightRefreshTimer);
    }
    this.highlightRefreshTimer = window.setTimeout(() => {
      this.highlightRefreshTimer = null;
      void this.refreshInlineHighlights();
    }, delayMs);
  }

  triggerHighlightRefresh(delayMs = 60): void {
    this.scheduleHighlightRefresh(delayMs);
  }

  private async refreshInlineHighlights(): Promise<void> {
    if (!this.annotationService) {
      this.clearAllInlineHighlights();
      return;
    }
    if (this.settings.highlightPersistenceMode === 'markdown') {
      // In markdown write-back mode, rely on native `==text==` rendering only.
      // We explicitly clear virtual overlays to keep both modes visually consistent.
      this.clearAllInlineHighlights();
      return;
    }

    const leaves = this.app.workspace.getLeavesOfType('markdown');
    if (leaves.length === 0) {
      return;
    }

    const recordsByNote = new Map<string, AnnotationRecord[]>();
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) {
        continue;
      }
      const notePath = view.file.path;
      if (!recordsByNote.has(notePath)) {
        recordsByNote.set(
          notePath,
          await this.annotationService.queryCurrentNote(notePath, ''),
        );
      }
    }

    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) {
        continue;
      }
      const records = recordsByNote.get(view.file.path) ?? [];
      this.applyInlineHighlightsToView(view, records);
    }
  }

  private applyInlineHighlightsToView(view: MarkdownView, records: AnnotationRecord[]): void {
    const content = view.editor.getValue();
    const resolved: ResolvedInlineHighlight[] = [];
    for (const record of records) {
      const hit = this.annotationService?.resolveInNote(content, record);
      if (!hit) {
        continue;
      }
      resolved.push({
        selectedText: record.anchor.selectedText,
        resolved: hit,
      });
    }

    this.applySourceInlineHighlights(view, resolved);
    this.applyPreviewInlineHighlights(view, resolved);
  }

  private applySourceInlineHighlights(
    view: MarkdownView,
    resolved: ResolvedInlineHighlight[],
  ): void {
    const editorView = this.resolveEditorViewFromEditor(view.editor);
    if (!editorView) {
      return;
    }
    this.ensureInlineHighlightField(editorView);

    if (view.getMode() !== 'source' || resolved.length === 0) {
      editorView.dispatch({ effects: setInlineHighlightRangesEffect.of([]) });
      return;
    }

    const ranges: InlineHighlightRange[] = [];
    for (const item of resolved) {
      const fromPos = { line: item.resolved.startLine, ch: item.resolved.startCh };
      const toPos = { line: item.resolved.endLine, ch: item.resolved.endCh };
      const from = view.editor.posToOffset(fromPos);
      const to = view.editor.posToOffset(toPos);
      if (to > from) {
        ranges.push({ from, to });
      }
    }
    editorView.dispatch({ effects: setInlineHighlightRangesEffect.of(ranges) });
  }

  private ensureInlineHighlightField(editorView: EditorView): void {
    let hasField = false;
    try {
      hasField = !!editorView.state.field(inlineHighlightField, false);
    } catch {
      hasField = false;
    }
    if (hasField) {
      return;
    }
    editorView.dispatch({
      effects: StateEffect.appendConfig.of([inlineHighlightField]),
    });
  }

  private resolveEditorViewFromEditor(editor: Editor): EditorView | null {
    const cmHost = (editor as Editor & { cm?: unknown }).cm as
      | { dispatch?: unknown; state?: unknown; cm?: unknown }
      | undefined;
    if (!cmHost) {
      return null;
    }
    if (typeof cmHost.dispatch === 'function' && cmHost.state) {
      return cmHost as unknown as EditorView;
    }
    const nested = (cmHost as { cm?: unknown }).cm as
      | { dispatch?: unknown; state?: unknown }
      | undefined;
    if (nested && typeof nested.dispatch === 'function' && nested.state) {
      return nested as unknown as EditorView;
    }
    return null;
  }

  private applyPreviewInlineHighlights(
    view: MarkdownView,
    resolved: ResolvedInlineHighlight[],
  ): void {
    const previewRoot = this.getPreviewRoot(view);
    if (!previewRoot) {
      return;
    }
    this.clearPreviewInlineHighlights(previewRoot);
    if (view.getMode() === 'source' || resolved.length === 0) {
      return;
    }

    const blocks = Array.from(
      previewRoot.querySelectorAll<HTMLElement>('[data-line], [data-line-start], [data-section-start]'),
    ).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.height > 0 && rect.width > 0;
    });
    if (blocks.length === 0) {
      return;
    }

    const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
    const parseLine = (el: HTMLElement): number | null => {
      const raw =
        el.getAttribute('data-line') ??
        el.getAttribute('data-line-start') ??
        el.getAttribute('data-section-start') ??
        '';
      const line = Number.parseInt(String(raw).match(/\d+/)?.[0] ?? '', 10);
      return Number.isNaN(line) ? null : line;
    };
    const pickBlock = (startLine: number, selectedText: string): HTMLElement | null => {
      const needle = normalize(selectedText);
      const shortNeedle = needle.length > 120 ? needle.slice(0, 120) : needle;
      type Candidate = { el: HTMLElement; line: number; distance: number; textLen: number };
      const candidates: Candidate[] = [];
      if (shortNeedle.length >= 2) {
        for (const block of blocks) {
          const line = parseLine(block);
          if (line == null) {
            continue;
          }
          const textNorm = normalize(block.textContent ?? '');
          if (!textNorm || !textNorm.includes(shortNeedle)) {
            continue;
          }
          candidates.push({
            el: block,
            line,
            distance: Math.abs(line - startLine),
            textLen: textNorm.length,
          });
        }
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => {
          if (a.distance !== b.distance) {
            return a.distance - b.distance;
          }
          if (a.textLen !== b.textLen) {
            return a.textLen - b.textLen;
          }
          return a.line - b.line;
        });
        return candidates[0].el;
      }

      let nearest: HTMLElement | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const block of blocks) {
        const line = parseLine(block);
        if (line == null) {
          continue;
        }
        const distance = Math.abs(line - startLine);
        if (distance < bestDistance) {
          bestDistance = distance;
          nearest = block;
        }
      }
      return nearest;
    };

    for (const item of resolved) {
      const target = pickBlock(item.resolved.startLine, item.selectedText);
      if (!target) {
        continue;
      }
      this.highlightTextInPreviewBlock(target, item.selectedText);
    }
  }

  private clearAllInlineHighlights(): void {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        continue;
      }
      const editorView = this.resolveEditorViewFromEditor(view.editor);
      if (editorView) {
        editorView.dispatch({ effects: setInlineHighlightRangesEffect.of([]) });
      }
      const previewRoot = this.getPreviewRoot(view);
      if (!previewRoot) {
        continue;
      }
      this.clearPreviewInlineHighlights(previewRoot);
    }
  }

  private clearPreviewInlineHighlights(previewRoot: HTMLElement): void {
    const marks = Array.from(previewRoot.querySelectorAll<HTMLElement>('span.reading-annotations-inline-mark-preview'));
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) {
        continue;
      }
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      if (parent instanceof HTMLElement) {
        parent.normalize();
      }
    }
  }

  private highlightTextInPreviewBlock(block: HTMLElement, selectedText: string): boolean {
    const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
    const needle = normalize(selectedText);
    if (!needle || needle.length < 2) {
      return false;
    }
    const shortNeedle = needle.length > 180 ? needle.slice(0, 180) : needle;

    type CharRef = { node: Text; offset: number };
    const refs: CharRef[] = [];
    let flat = '';
    let lastWasSpace = false;

    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!(node instanceof Text)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        const parentEl = node.parentElement;
        if (!parentEl) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parentEl.closest('span.reading-annotations-inline-mark-preview')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let current: Node | null = walker.nextNode();
    while (current) {
      const textNode = current as Text;
      const value = textNode.nodeValue ?? '';
      for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        const isSpace = /\s/.test(ch);
        if (isSpace) {
          if (lastWasSpace) {
            continue;
          }
          lastWasSpace = true;
          flat += ' ';
          refs.push({ node: textNode, offset: i });
          continue;
        }
        lastWasSpace = false;
        flat += ch;
        refs.push({ node: textNode, offset: i });
      }
      current = walker.nextNode();
    }

    const idx = flat.indexOf(shortNeedle);
    if (idx < 0) {
      return false;
    }
    const startRef = refs[idx];
    const endRef = refs[idx + shortNeedle.length - 1];
    if (!startRef || !endRef) {
      return false;
    }

    const range = document.createRange();
    range.setStart(startRef.node, startRef.offset);
    range.setEnd(endRef.node, endRef.offset + 1);

    const wrap = document.createElement('span');
    wrap.className = 'reading-annotations-inline-mark-preview';
    const extracted = range.extractContents();
    wrap.appendChild(extracted);
    range.insertNode(wrap);
    return true;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class ReadingAnnotationsSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ReadingAnnotationsPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h3', { text: 'Reading Annotations' });

    new Setting(containerEl)
      .setName('来源字段优先级')
      .setDesc('从 frontmatter 中按顺序读取来源字段，逗号分隔。')
      .addText((text) => {
        text
          .setPlaceholder('source, url, reference')
          .setValue(this.plugin.settings.sourceFieldPriority.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.sourceFieldPriority = value
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('高亮写回模式')
      .setDesc('`Markdown` 模式会把标注文本写成 `==文本==`，`虚拟` 模式不改原文。')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('markdown', 'Markdown（==高亮==）')
          .addOption('virtual', '虚拟（不改原文）')
          .setValue(this.plugin.settings.highlightPersistenceMode)
          .onChange(async (value: string) => {
            const mode = value === 'virtual' ? 'virtual' : 'markdown';
            this.plugin.settings.highlightPersistenceMode = mode;
            await this.plugin.saveSettings();
            this.plugin.triggerHighlightRefresh(0);
          });
      });

    new Setting(containerEl)
      .setName('索引维护')
      .setDesc('如果 sidecar 与索引不一致，可手动重建。')
      .addButton((btn) => {
        btn.setButtonText('重建索引');
        btn.onClick(async () => {
          await this.plugin.rebuildIndex();
        });
      });
  }
}
