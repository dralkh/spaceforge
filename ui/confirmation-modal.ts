import { App, Modal, Setting } from 'obsidian';

export class ConfirmationModal extends Modal {
    private title: string;
    private message: string;
    private onConfirm: () => void | Promise<void>;
    private onCancel: () => void | Promise<void>;

    constructor(
        app: App,
        title: string,
        message: string,
        onConfirm: () => void | Promise<void>,
        onCancel: () => void | Promise<void> = () => { }
    ) {
        super(app);
        this.title = title;
        this.message = message;
        this.onConfirm = onConfirm;
        this.onCancel = onCancel;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: this.title });
        contentEl.createEl('p', { text: this.message });

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        new Setting(buttonContainer)
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => {
                    void this.onCancel();
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText('Confirm')
                .setCta()
                .onClick(() => {
                    void this.onConfirm();
                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
