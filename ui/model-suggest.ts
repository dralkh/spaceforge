import { AbstractInputSuggest, App } from 'obsidian';
import { DiscoveredModel, searchModels } from '../api/provider-registry';

/**
 * The model field, made searchable.
 *
 * Model ids are long, half-remembered and change every few weeks, which is why
 * the settings offer what the provider itself listed instead of asking the user
 * to recall one. Still an editable text field: a model the provider did not list
 * is exactly the sort of thing a learner tries before switching provider, and
 * refusing it would be worse than accepting a typo.
 */
export class ModelSuggest extends AbstractInputSuggest<DiscoveredModel> {
    private models: DiscoveredModel[];

    constructor(
        app: App,
        inputEl: HTMLInputElement,
        models: DiscoveredModel[],
        private onPick: (model: DiscoveredModel) => void
    ) {
        super(app, inputEl);
        this.models = models;
    }

    /** Swap in a freshly discovered list without rebuilding the field. */
    setModels(models: DiscoveredModel[]): void {
        this.models = models;
    }

    getModels(): DiscoveredModel[] {
        return this.models;
    }

    protected getSuggestions(query: string): DiscoveredModel[] {
        return searchModels(this.models, query, 20);
    }

    renderSuggestion(model: DiscoveredModel, el: HTMLElement): void {
        el.addClass('sf-model-suggestion');
        el.createSpan({ cls: 'sf-model-suggestion-id', text: model.id });
        // What the list knows about this model: that it leads it, and whatever
        // name the provider gave it. The "newest" mark is read as exactly what it
        // is — the newest entry in the list that was just returned.
        const notes: string[] = [];
        if (model.latest) notes.push('newest in this list');
        if (model.label && model.label !== model.id) notes.push(model.label);
        else if (model.source === 'catalog') notes.push('from the built-in list');
        const note = notes.join(' · ');
        if (note) el.createSpan({ cls: 'sf-model-suggestion-note', text: note });
    }

    selectSuggestion(model: DiscoveredModel): void {
        this.setValue(model.id);
        this.onPick(model);
        this.close();
    }
}
