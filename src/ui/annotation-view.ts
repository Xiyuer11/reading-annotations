import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import type { AnnotationRecord } from '../core/types';

export const READING_ANNOTATION_VIEW = 'reading-annotation-view';

export interface AnnotationViewHost {
  queryCurrentNote(query: string): Promise<AnnotationRecord[]>;
  jumpToAnnotation(record: AnnotationRecord): Promise<void>;
  editAnnotation(record: AnnotationRecord): Promise<void>;
  deleteAnnotation(record: AnnotationRecord): Promise<void>;
  getActiveFile(): TFile | null;
}

export class AnnotationListView extends ItemView {
  private query = '';
  private rows: AnnotationRecord[] = [];
  private cardsById = new Map<string, HTMLDivElement>();
  private listEl: HTMLDivElement | null = null;

  private clipSource(text: string, maxChars = 10): string {
    const chars = Array.from(text ?? '');
    if (chars.length <= maxChars) {
      return text;
    }
    return `${chars.slice(0, maxChars).join('')}…`;
  }

  private formatMinuteTime(iso: string): string {
    return new Date(iso).toLocaleString('zh-CN', {
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: AnnotationViewHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return READING_ANNOTATION_VIEW;
  }

  getDisplayText(): string {
    return '当前笔记标注';
  }

  getIcon(): string {
    return 'highlighter';
  }

  async onOpen(): Promise<void> {
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', async (leaf) => {
        // Ignore focus switches into this side view itself, otherwise the first click
        // on inner buttons can be interrupted by a full re-render.
        if (leaf === this.leaf) {
          return;
        }
        await this.refresh();
      }),
    );
    this.registerEvent(
      this.app.workspace.on('layout-change', async () => {
        await this.updateActiveCards();
      }),
    );
    this.registerEvent(
      this.app.workspace.on('resize', async () => {
        await this.updateActiveCards();
      }),
    );
    this.registerEvent(
      this.app.workspace.on('editor-change', async () => {
        await this.updateActiveCards();
      }),
    );

    this.registerInterval(window.setInterval(() => {
      void this.updateActiveCards();
    }, 180));

    await this.render();
  }

  async refresh(): Promise<void> {
    await this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('reading-annotations-view');

    const file = this.host.getActiveFile();
    contentEl.createEl('h3', { text: file ? `标注 · ${file.basename}` : '标注' });

    const input = contentEl.createEl('input', {
      type: 'text',
      placeholder: '搜索想法 / 来源（当前笔记）',
      cls: 'reading-annotations-search',
    });
    input.value = this.query;
    input.addEventListener('input', async () => {
      this.query = input.value;
      await this.render();
    });

    this.rows = await this.host.queryCurrentNote(this.query);
    this.cardsById.clear();

    if (this.rows.length === 0) {
      contentEl.createEl('p', { text: '当前笔记没有匹配标注。' });
      this.listEl = null;
      return;
    }

    const listEl = contentEl.createDiv({ cls: 'reading-annotations-list' });
    this.listEl = listEl;

    for (const record of this.rows) {
      const item = listEl.createDiv({ cls: 'reading-annotations-item reading-annotations-clickable' });
      item.dataset.id = record.id;

      const textRow = item.createDiv({ cls: 'reading-annotations-text' });
      textRow.createEl('div', { text: record.thought, cls: 'reading-annotations-thought' });

      if (record.tags.length > 0) {
        textRow.createEl('div', {
          text: record.tags.map((tag) => `#${tag}`).join(' '),
          cls: 'reading-annotations-tags',
        });
      }

      const metaRow = item.createDiv({ cls: 'reading-annotations-meta-row' });
      metaRow.createEl('div', {
        text: `来源: ${this.clipSource(record.source.display, 10)}`,
        cls: 'reading-annotations-meta-source',
      });
      metaRow.createEl('div', {
        text: this.formatMinuteTime(record.updatedAt),
        cls: 'reading-annotations-meta-time',
      });

      const actionRow = item.createDiv({ cls: 'reading-annotations-actions' });
      const editBtn = actionRow.createEl('button', { text: '编辑' });
      const deleteBtn = actionRow.createEl('button', { text: '删除' });
      editBtn.type = 'button';
      deleteBtn.type = 'button';

      const stopPointerDown = (evt: MouseEvent): void => {
        evt.preventDefault();
        evt.stopPropagation();
      };
      editBtn.addEventListener('mousedown', stopPointerDown);
      deleteBtn.addEventListener('mousedown', stopPointerDown);

      editBtn.addEventListener('click', async (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        await this.host.editAnnotation(record);
        await this.refresh();
      });

      deleteBtn.addEventListener('click', async (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const confirmed = window.confirm('确认删除这条标注吗？此操作不可撤销。');
        if (!confirmed) {
          return;
        }
        await this.host.deleteAnnotation(record);
        new Notice('标注已删除');
        await this.refresh();
      });

      item.addEventListener('click', async () => {
        await this.host.jumpToAnnotation(record);
      });

      this.cardsById.set(record.id, item);
    }

    await this.updateActiveCards();
  }

  private async updateActiveCards(): Promise<void> {
    if (!this.listEl || this.rows.length === 0) {
      return;
    }

    const activeFile = this.host.getActiveFile();
    if (!activeFile) {
      this.setAllCardsInactive();
      return;
    }

    const markdownView = this.findMarkdownViewForFile(activeFile.path);
    if (!markdownView) {
      this.setAllCardsInactive();
      return;
    }

    const cm = (markdownView.editor as {
      cm?: { coordsAtPos?: (offset: number) => DOMRect | null; dom?: HTMLElement };
    }).cm;
    if (markdownView.getMode() === 'source' && cm?.coordsAtPos && cm.dom) {
      const editorRect = cm.dom.getBoundingClientRect();
      if (editorRect.height < 20 || editorRect.width < 20) {
        this.setAllCardsInactive();
        return;
      }

      for (const row of this.rows) {
        const card = this.cardsById.get(row.id);
        if (!card) {
          continue;
        }

        const offset = markdownView.editor.posToOffset({ line: row.anchor.startLine, ch: 0 });
        const coords = cm.coordsAtPos(offset);
        const isActive = !!coords && coords.top >= editorRect.top && coords.top <= editorRect.bottom;
        card.classList.toggle('reading-annotations-item-active', isActive);
      }
      return;
    }

    // Preview mode fallback: infer visible line range from preview scroll ratio.
    const previewEl = markdownView.previewMode?.containerEl;
    if (!previewEl) {
      this.setAllCardsInactive();
      return;
    }
    const previewViewEl =
      markdownView.containerEl.querySelector<HTMLElement>('.markdown-reading-view .markdown-preview-view') ??
      markdownView.containerEl.querySelector<HTMLElement>('.markdown-preview-view') ??
      previewEl.querySelector<HTMLElement>('.markdown-preview-view') ??
      previewEl;
    const readingViewport = this.resolveScrollContainer([
      previewViewEl,
      previewEl,
      previewViewEl.parentElement as HTMLElement | null,
      previewEl.parentElement as HTMLElement | null,
      markdownView.containerEl.querySelector<HTMLElement>('.markdown-reading-view') ?? null,
    ]);
    if (readingViewport.clientHeight < 20 || readingViewport.clientWidth < 20) {
      this.setAllCardsInactive();
      return;
    }

    // Preferred preview strategy: use DOM blocks carrying source line anchors.
    const anchorRoot =
      previewViewEl.querySelector<HTMLElement>('.markdown-preview-sizer') ?? previewViewEl;
    const blocks = Array.from(
      anchorRoot.querySelectorAll<HTMLElement>('[data-line], [data-line-start], [data-section-start]'),
    );
    if (blocks.length > 0) {
      const viewportRect = readingViewport.getBoundingClientRect();
      let minLine = Number.POSITIVE_INFINITY;
      let maxLine = Number.NEGATIVE_INFINITY;

      for (const block of blocks) {
        const rect = block.getBoundingClientRect();
        const intersects = rect.bottom >= viewportRect.top && rect.top <= viewportRect.bottom;
        if (!intersects) {
          continue;
        }

        const raw =
          block.getAttribute('data-line') ??
          block.getAttribute('data-line-start') ??
          block.getAttribute('data-section-start') ??
          '';
        const line = Number.parseInt(String(raw).match(/\\d+/)?.[0] ?? '', 10);
        if (Number.isNaN(line)) {
          continue;
        }
        minLine = Math.min(minLine, line);
        maxLine = Math.max(maxLine, line);
      }

      if (Number.isFinite(minLine) && Number.isFinite(maxLine)) {
        const buffer = 2;
        for (const row of this.rows) {
          const card = this.cardsById.get(row.id);
          if (!card) {
            continue;
          }
          const line = row.anchor.startLine;
          const isActive = line >= minLine - buffer && line <= maxLine + buffer;
          card.classList.toggle('reading-annotations-item-active', isActive);
        }
        return;
      }
    }

    const totalLines = Math.max(1, markdownView.editor.lineCount());
    const viewportHeight = Math.max(1, readingViewport.clientHeight || previewViewEl.clientHeight);
    const scrollHeight = Math.max(1, readingViewport.scrollHeight, previewViewEl.scrollHeight);
    const scrollTop = Math.max(0, readingViewport.scrollTop || previewViewEl.scrollTop || 0);

    const topRatio = Math.max(0, Math.min(1, scrollTop / Math.max(1, scrollHeight - viewportHeight)));
    const bottomRatio = Math.max(
      topRatio,
      Math.min(1, (scrollTop + viewportHeight) / scrollHeight),
    );

    const startLine = Math.floor(topRatio * (totalLines - 1));
    const endLine = Math.ceil(bottomRatio * (totalLines - 1));
    const buffer = 2;

    for (const row of this.rows) {
      const card = this.cardsById.get(row.id);
      if (!card) {
        continue;
      }
      const line = row.anchor.startLine;
      const isActive = line >= startLine - buffer && line <= endLine + buffer;
      card.classList.toggle('reading-annotations-item-active', isActive);
    }
  }

  private resolveScrollContainer(candidates: Array<HTMLElement | null>): HTMLElement {
    const usable = candidates.filter((el): el is HTMLElement => !!el);
    for (const el of usable) {
      const style = window.getComputedStyle(el);
      const canScrollY = /(auto|scroll|overlay)/.test(style.overflowY);
      if (canScrollY && el.scrollHeight > el.clientHeight + 4) {
        return el;
      }
    }
    return usable[0] ?? document.body;
  }

  private setAllCardsInactive(): void {
    for (const card of this.cardsById.values()) {
      card.classList.remove('reading-annotations-item-active');
    }
  }

  private findMarkdownViewForFile(path: string): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === path) {
      return active;
    }

    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) {
        return view;
      }
    }
    return null;
  }
}
