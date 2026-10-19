import { App, Modal, Notice, Setting } from 'obsidian';

import type SpaceforgePlugin from '../main';
import type { DataFileCandidate } from '../utils/data-file';

/**
 * Lists the copies of the data file that still hold scheduling state, so a user who
 * lost notes to an interrupted save can put them back.
 *
 * Restoring only ever *adds* what is missing: notes the current state already has
 * keep their due dates, so running it twice is harmless.
 */
export class DataRecoveryModal extends Modal {
    private plugin: SpaceforgePlugin;
    private candidates: DataFileCandidate[] = [];
    private loaded = false;

    constructor(app: App, plugin: SpaceforgePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen(): void {
        this.titleEl.setText('Recover review data');
        this.contentEl.createEl('p', {
            text: 'Copies of the data file found next to it. Restoring adds the notes and reviews that are missing from the current state and leaves everything else as it is.',
        });
        this.contentEl.createEl('p', { text: this.plugin.describeCurrentDataCounts(), cls: 'sf-recovery-current' });
        const list = this.contentEl.createDiv({ cls: 'sf-recovery-list' });
        list.setText('Looking for backup files…');

        void (async () => {
            try {
                const candidates = await this.plugin.listDataRecoveryCandidates();
                this.candidates = candidates;
                this.loaded = true;
                this.renderList(list);
            } catch (error) {
                list.setText(`Could not read the plugin folder: ${String(error)}`);
            }
        })();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private renderList(container: HTMLElement): void {
        container.empty();
        if (this.candidates.length === 0) {
            container.createEl('p', { text: 'No backup files found. Nothing to recover from.' });
            return;
        }

        for (const candidate of this.candidates) {
            const row = container.createDiv({ cls: 'sf-recovery-row' });
            const text = row.createDiv({ cls: 'sf-recovery-text' });
            text.createEl('div', { text: candidate.name, cls: 'sf-recovery-name' });
            const when = candidate.mtime > 0 ? new Date(candidate.mtime).toLocaleString() : 'unknown date';
            text.createEl('div', {
                text: `${candidate.schedules} note(s), ${candidate.history} review(s) · ${when}`,
                cls: 'sf-recovery-meta',
            });
            new Setting(row).addButton(button => button
                .setButtonText('Restore')
                .setCta()
                .onClick(async () => {
                    button.setDisabled(true);
                    try {
                        await this.plugin.applyRecoveredData(candidate);
                        this.close();
                    } catch (error) {
                        button.setDisabled(false);
                        console.error('[spaceforge] restore failed', error);
                        new Notice(`Could not restore from ${candidate.name}. See the developer console.`, 8000);
                    }
                }));
        }

        if (!this.loaded) container.createEl('p', { text: 'Still scanning…' });
    }
}
