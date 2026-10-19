import { Modal } from 'obsidian';
import SpaceforgePlugin from '../main';
import { StudyController } from '../controllers/study-controller';
import { StudyPanel } from './study-panel';

/**
 * Standalone Study window.
 *
 * A thin shell around `StudyPanel`, which is the real surface: the review
 * dialog embeds the same panel inline, so study mode is part of reviewing a
 * note rather than a separate errand. This wrapper exists for the entry points
 * that legitimately want their own window (sidebar button, context menu,
 * command palette).
 */
export class StudyModal extends Modal {
    private panel: StudyPanel;

    constructor(plugin: SpaceforgePlugin, controller: StudyController, notePath: string) {
        super(plugin.app);
        this.modalEl.addClass('sf-study-modal-shell');
        this.panel = new StudyPanel(plugin, controller, notePath, {
            onSessionEnd: () => {
                // The window stays open on the report; the learner closes it
                // when they are done reading.
            },
        });
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('sf-study-modal');
        this.panel.mount(contentEl.createDiv('sf-study-shell'));
        this.registerChoiceHotkeys();
    }

    onClose(): void {
        this.panel.unmount();
        this.contentEl.empty();
    }

    /** Number and letter keys pick a choice, unless a text field has focus. */
    private registerChoiceHotkeys(): void {
        const handler = (index: number) => (event: KeyboardEvent): unknown => {
            const active = document.activeElement;
            if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return undefined;
            if (!this.panel.handleChoiceKey(index)) return undefined;
            event.preventDefault();
            return false;
        };
        for (let i = 1; i <= 9; i++) this.scope.register([], String(i), handler(i - 1));
        for (let i = 0; i < 9; i++) this.scope.register([], String.fromCharCode(65 + i), handler(i));
    }
}
