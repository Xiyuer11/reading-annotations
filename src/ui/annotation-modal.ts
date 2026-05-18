import { Modal } from 'obsidian';

export interface AnnotationModalResult {
  thought: string;
}

interface AnnotationModalOptions {
  title: string;
  initialThought: string;
  onSubmit: (result: AnnotationModalResult) => Promise<void>;
  onClose?: () => void;
}

export class AnnotationModal extends Modal {
  private thoughtValue: string;

  constructor(
    app: import('obsidian').App,
    private readonly options: AnnotationModalOptions,
  ) {
    super(app);
    this.thoughtValue = options.initialThought;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.style.width = 'min(680px, 86vw)';
    this.modalEl.style.maxWidth = '680px';
    contentEl.empty();
    contentEl.addClass('reading-annotations-modal');

    const shell = contentEl.createDiv({ cls: 'reading-annotations-modal-shell' });

    shell.createEl('h3', {
      cls: 'reading-annotations-modal-title',
      text: this.options.title,
    });

    const inputWrap = shell.createDiv({ cls: 'reading-annotations-modal-input-wrap' });
    const input = inputWrap.createEl('textarea', {
      cls: 'reading-annotations-modal-textarea',
      attr: { placeholder: '写下你现在的理解、疑问或联想' },
    });
    input.value = this.thoughtValue;
    input.addEventListener('input', () => {
      this.thoughtValue = input.value;
    });

    const actionRow = shell.createDiv({ cls: 'reading-annotations-modal-actions' });
    const cancelBtn = actionRow.createEl('button', {
      cls: 'reading-annotations-modal-btn',
      text: '关闭',
    });
    cancelBtn.type = 'button';

    const saveBtn = actionRow.createEl('button', {
      cls: 'reading-annotations-modal-btn mod-cta',
      text: '保存',
    });
    saveBtn.type = 'button';

    cancelBtn.addEventListener('click', () => this.close());
    saveBtn.addEventListener('click', async () => {
      const thought = this.thoughtValue.trim();
      if (!thought) {
        input.focus();
        return;
      }
      await this.options.onSubmit({ thought });
      this.close();
    });

    // Keep keyboard flow friendly.
    input.focus();
  }

  onClose(): void {
    this.options.onClose?.();
    this.modalEl.style.width = '';
    this.modalEl.style.maxWidth = '';
    this.contentEl.empty();
  }
}
