/**
 * The settings tab, driven through the miniature DOM: what it renders, where it
 * puts it, and — the part a reader feels every day — what it does *not* do when
 * a value changes.
 *
 * The complaint this guards against: changing anything re-rendered the whole
 * tab, which closed every section the reader had opened and threw away where
 * they had scrolled to, so the settings read as a page that kept reloading.
 * Rendering is real code here, not a description of it: the tab is built
 * against DOM-backed stand-ins for Obsidian's `Setting` and `PluginSettingTab`
 * (test/support/obsidian-shim.ts) over the miniature DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SpaceforgeSettingTab } from '../ui/settings-tab';
import { getHttpProvider } from '../api/provider-registry';
import { DEFAULT_SETTINGS, SpaceforgeSettings, ApiProvider, MCQQuestionAmountMode, StudySearchProvider } from '../models/settings';
import { DEFAULT_PLUGIN_STATE_DATA } from '../models/plugin-data';
import { Platform, Setting, createdSettings } from './support/obsidian-shim';
import { MiniElement } from './support/mini-dom';

type TabCtor = ConstructorParameters<typeof SpaceforgeSettingTab>;

interface Harness {
    tab: SpaceforgeSettingTab;
    containerEl: MiniElement;
    /** The settings the tab is reading and writing. */
    settings: SpaceforgeSettings;
    /** The row with this title, as the current render left it. */
    find(name: string): Setting;
    /** Every attached row with this title (headings count too). */
    named(name: string): Setting[];
    /** The section container whose heading is this title. */
    section(title: string): MiniElement;
    sectionTitles(): string[];
    /** The element behind a row, for identity checks. */
    rows(): Setting[];
}

function makeTab(overrides: Partial<SpaceforgeSettings> = {}): Harness {
    const settings: SpaceforgeSettings = {
        ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as SpaceforgeSettings,
        ...overrides,
    };

    const app = {
        vault: { configDir: '.obsidian', getAbstractFileByPath: () => null },
        fileManager: { trashFile: async () => undefined },
        setting: undefined,
    };

    // Only what the tab reads while it renders. The services behind its buttons
    // are not what this suite is about, so they record the call and do nothing.
    const plugin = {
        app,
        settings,
        manifest: { id: 'spaceforge', version: '0.0.0' },
        pluginState: JSON.parse(JSON.stringify(DEFAULT_PLUGIN_STATE_DATA)),
        saves: 0,
        async savePluginData() { this.saves += 1; },
        register() { /* the tab registers its key capture here */ },
        initializeMCQComponents() { /* rebuilds services, not the tab */ },
        getSidebarView: () => null,
        chartAllScheduledNotes() { /* charting runs elsewhere */ },
        studyChartQueue: { getStatus: () => ({ queued: 0, message: '' }) },
        studyController: null,
        studyWebSearchService: null,
        pomodoroService: null,
        events: { emit: () => undefined },
    };

    const tab = new SpaceforgeSettingTab(app as unknown as TabCtor[0], plugin as unknown as TabCtor[1]);
    tab.display();
    const containerEl = tab.containerEl as unknown as MiniElement;

    const attached = (el: MiniElement): boolean => containerEl.find(candidate => candidate === el) !== null;

    const rows = (): Setting[] => createdSettings.filter(setting => attached(setting.settingEl));

    const named = (name: string): Setting[] => rows().filter(setting => setting.name === name);

    const find = (name: string): Setting => {
        const matches = named(name);
        assert.equal(matches.length, 1, `expected one setting named "${name}", found ${matches.length}`);
        return matches[0];
    };

    const section = (title: string): MiniElement => {
        const found = containerEl.byClass('sf-settings-section')
            .filter(candidate => candidate.find(el => el.hasClass('setting-item-name'))?.text === title);
        assert.equal(found.length, 1, `expected one section titled "${title}", found ${found.length}`);
        return found[0];
    };

    const sectionTitles = (): string[] => containerEl.byClass('sf-settings-section')
        .map(candidate => candidate.find(el => el.hasClass('setting-item-name'))?.text ?? '');

    return { tab, containerEl, settings, find, named, section, sectionTitles, rows };
}

/** The same elements, in the same order: what "the tab was not rebuilt" means. */
function assertSameElements(after: MiniElement[], before: MiniElement[], message: string): void {
    assert.equal(
        after.length === before.length && after.every((el, index) => el === before[index]),
        true,
        message,
    );
}

/** A section's heading row, which is what the reader clicks to open it. */
function headingRow(sectionEl: MiniElement): MiniElement {
    return sectionEl.children[0];
}

function sectionContent(sectionEl: MiniElement): MiniElement {
    const content = sectionEl.find(el => el.hasClass('sf-settings-section-content'));
    assert.ok(content, 'the section has no content container');
    return content;
}

function indicator(sectionEl: MiniElement): MiniElement {
    const arrow = sectionEl.find(el => el.hasClass('sf-settings-collapse-indicator'));
    assert.ok(arrow, 'the section has no collapse indicator');
    return arrow;
}

test('the API configuration is its own section, above the multiple-choice section', () => {
    const { containerEl, section, find, sectionTitles } = makeTab();

    const titles = sectionTitles();
    const api = titles.indexOf('API configuration');
    const mcq = titles.indexOf('Multiple choice questions');
    assert.ok(api >= 0, `no API configuration section: ${titles.join(' | ')}`);
    assert.ok(mcq >= 0, `no multiple-choice section: ${titles.join(' | ')}`);
    assert.ok(api < mcq, `the API section must come first, got: ${titles.join(' -> ')}`);

    // Not merely moved up the page: it is not nested inside the feature it serves.
    const apiSection = section('API configuration');
    const mcqSection = section('Multiple choice questions');
    assert.equal(mcqSection.find(el => el === apiSection), null, 'the API section must not sit inside the MCQ section');

    for (const row of ['API provider', 'Detected providers', 'Model']) {
        const rowEl = find(row).settingEl;
        assert.ok(apiSection.find(el => el === rowEl), `"${row}" belongs to the API section`);
        assert.equal(mcqSection.find(el => el === rowEl), null, `"${row}" must not be inside the MCQ section`);
    }
});

test('the provider\'s own rows are the only thing a provider change redraws', async () => {
    const { containerEl, find, named } = makeTab({ mcqApiProvider: ApiProvider.OpenRouter });

    assert.match(find('Model').descEl.text, /OpenRouter/, 'the OpenRouter model field says what it wants');
    assert.equal(find('Model').button?.buttonText, 'List models', 'the model row offers what the provider lists');

    const sections = containerEl.children.slice();
    const providerRow = find('API provider').settingEl;

    await find('API provider').dropdown?.change(ApiProvider.Ollama);

    assertSameElements(containerEl.children, sections, 'switching provider rebuilt the settings tab');
    assert.ok(containerEl.find(el => el === providerRow), 'the provider row itself survives the change');
    assert.equal(named('OpenRouter configuration').length, 0, 'the previous provider\'s rows are gone');
    assert.match(find('Model').descEl.text, /Ollama/, 'the new provider\'s model field is the one on screen');
    assert.ok(find('API URL'), 'the new provider\'s URL row is on screen');
});

test('changing a value never rebuilds the tab', async () => {
    const { containerEl, find } = makeTab();

    // Every control whose change used to re-render the whole tab. Each one is
    // driven the way a click would, on the element the reader is looking at.
    const changes: { name: string; value: unknown }[] = [
        { name: 'Enable multiple choice feature', value: true },
        { name: 'Question amount mode', value: MCQQuestionAmountMode.WordsPerQuestion },
        { name: 'Enable question regeneration on rating', value: true },
        { name: 'Enable Study', value: true },
        { name: 'Chart notes ahead of time', value: true },
        { name: 'Make Study material automatically', value: true },
        { name: 'Write questions automatically', value: true },
        { name: 'Search provider', value: StudySearchProvider.Tavily },
        { name: 'Enable Pomodoro timer', value: true },
        { name: 'Enable navigation command', value: true },
        { name: 'Use initial learning schedule (SM-2)', value: true },
        { name: 'Default scheduling algorithm', value: 'fsrs' },
        { name: 'Default view type', value: 'calendar' },
    ];

    for (const change of changes) {
        const before = containerEl.children.slice();
        const row = find(change.name);
        const control = row.toggle ?? row.dropdown ?? row.slider ?? row.text;
        assert.ok(control, `"${change.name}" has no control to drive`);
        await control.change(change.value);
        assertSameElements(
            containerEl.children,
            before,
            `changing "${change.name}" rebuilt the settings tab instead of showing or hiding what depends on it`,
        );
    }
});

test('a row that a setting turns on appears in place, and turns off in place', async () => {
    const { containerEl, find, section } = makeTab({ enableMCQ: false });

    const gradeRow = find('Grade after a set of questions').settingEl;
    const body = gradeRow.parent;
    assert.ok(body, 'the feature row has no wrapper');
    assert.ok(body.hasClass('sf-hidden'), 'the feature rows are hidden while the feature is off');

    const content = sectionContent(section('Multiple choice questions'));
    const disabledNote = content.find(el => el.hasClass('sf-info-box'));
    assert.ok(disabledNote && !disabledNote.hasClass('sf-hidden'), 'the section says the feature is off');

    const before = containerEl.children.slice();
    await find('Enable multiple choice feature').toggle?.change(true);

    assertSameElements(containerEl.children, before, 'turning the feature on rebuilt the tab');
    assert.equal(body.hasClass('sf-hidden'), false, 'the rows appear');
    assert.ok(containerEl.find(el => el === gradeRow), 'and they are the same rows, not new ones');
    assert.equal(disabledNote.hasClass('sf-hidden'), true, 'and the note explaining the feature is off goes away');

    await find('Enable multiple choice feature').toggle?.change(false);
    assert.ok(body.hasClass('sf-hidden'), 'turning it off hides the very same rows again');
    assert.equal(disabledNote.hasClass('sf-hidden'), false, 'and the note comes back');
});

test('the auto-pilot rows are one hint that appears in place, and only while a step is on', async () => {
    const { containerEl, find, section } = makeTab();

    // The hint lives in the Study section, and is the only box that says this.
    const hintBox = (): MiniElement | null => sectionContent(section('Study'))
        .find(el => el.hasClass('sf-info-box') && el.textContent.includes('finished quietly in the background'));
    const hintRow = (): MiniElement | null => hintBox()?.parent ?? null;

    const row = hintRow();
    assert.ok(row, 'the hint row exists');
    assert.ok(row.hasClass('sf-hidden'), 'with both steps off it is hidden');

    const before = containerEl.children.slice();
    await find('Make Study material automatically').toggle?.change(true);
    assertSameElements(containerEl.children, before, 'turning the material step on rebuilt the tab');
    assert.equal(row.hasClass('sf-hidden'), false, 'the hint appears in place');
    assert.ok(containerEl.find(el => el === row), 'and it is the same row, not a new one');

    await find('Write questions automatically').toggle?.change(true);
    await find('Make Study material automatically').toggle?.change(false);
    assert.equal(row.hasClass('sf-hidden'), false, 'still shown: one step is still on');

    await find('Write questions automatically').toggle?.change(false);
    assert.ok(row.hasClass('sf-hidden'), 'and hidden again once both are off');
});

test('a section the reader opened stays open when the tab is rebuilt', () => {
    const { tab, containerEl, section } = makeTab();

    const mcq = section('Multiple choice questions');
    assert.ok(sectionContent(mcq).hasClass('sf-hidden'), 'a feature section starts closed');
    assert.equal(indicator(mcq).text, '▸', 'and says so');

    headingRow(mcq).click();
    assert.ok(sectionContent(mcq).hasClass('sf-visible'), 'clicking the heading opens the section');
    assert.equal(indicator(mcq).text, '▾', 'the arrow agrees with what is on screen');

    // The one rebuild left: a whole-vault action (import, reset, clear, convert).
    tab.display();

    const reopened = sectionContent(section('Multiple choice questions'));
    assert.ok(reopened.hasClass('sf-visible'), 'a rebuild must not close the section the reader opened');
    assert.equal(indicator(section('Multiple choice questions')).text, '▾', 'nor lie about it');
});

test('the section that is open by default opens, closes and reopens with an honest arrow', () => {
    const { section } = makeTab();

    const spaced = section('Spaced repetition');
    assert.ok(sectionContent(spaced).hasClass('sf-visible'), 'it is open by default');
    assert.equal(indicator(spaced).text, '▾');

    headingRow(spaced).click();
    assert.ok(sectionContent(spaced).hasClass('sf-hidden'), 'clicking closes it');
    assert.equal(indicator(spaced).text, '▸', 'the arrow follows the content');

    headingRow(spaced).click();
    assert.ok(sectionContent(spaced).hasClass('sf-visible'), 'and clicking again reopens it');
    assert.equal(indicator(spaced).text, '▾');
});

test('a rebuild is only ever a whole-vault action', () => {
    // display() empties the container: every section closes and the reader loses
    // their place. The sources of it are pinned here so a change to one setting
    // cannot quietly reintroduce it — show and hide the rows instead.
    const source = fs.readFileSync('ui/settings-tab.ts', 'utf8');
    const rebuilds = [...source.matchAll(/this\.display\(\)/g)].length;
    assert.equal(
        rebuilds,
        8,
        'display() is for the data-wide actions (import, reset, clear, convert, delete the legacy file). '
        + 'A control\'s change must show and hide its rows in place.',
    );
});

test('every provider in the dropdown has rows of its own, and they stay put', async () => {
    const { containerEl, find, section } = makeTab();
    const apiSection = section('API configuration');
    const dropdown = find('API provider').dropdown;
    assert.ok(dropdown, 'the provider choice is a dropdown');
    const options = dropdown.options.map(option => option.value);
    assert.ok(options.length >= 28, `expected every company and every CLI, found ${options.length}`);
    for (const agentId of ['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'hermes', 'openclaw', 'opencode']) {
        assert.ok(options.includes(`cli:${agentId}`), `${agentId} is offered under its own id`);
    }
    assert.ok(!options.includes(ApiProvider.Cli), 'there is no converged "local CLI" row to narrow down');
    assert.ok(!options.includes('cli:gemini'), 'the deprecated Gemini CLI is no longer offered');
    // The CLIs lead the list: they need no key and no account, so they are the
    // shortest path from a fresh install to a working provider.
    assert.deepEqual(
        options.slice(0, 8),
        ['cli:antigravity', 'cli:claude', 'cli:codex', 'cli:copilot', 'cli:cursor', 'cli:hermes', 'cli:openclaw', 'cli:opencode'],
        'every CLI is listed first',
    );

    for (const id of options) {
        const before = containerEl.children.slice();
        await dropdown.change(id);
        assertSameElements(containerEl.children, before, `choosing ${id} rebuilt the settings tab`);

        // The rows for a provider always live inside the API section, and there is
        // always a model field — that is what makes a provider usable at all.
        const rows = [find('Model')];
        if (id.startsWith('cli:')) {
            // A CLI is configured by picking it and checking it: no second choice
            // of which agent, and no key, because the CLI owns its own login.
            rows.push(find('Is it ready?'));
        } else {
            rows.push(find('API key'));
        }
        for (const row of rows) {
            assert.ok(apiSection.find(el => el === row.settingEl), `${id}: its rows belong to the API section`);
        }
    }
});

test('a local CLI is one row: no agent to pick inside it', async () => {
    const { find, named, settings } = makeTab({ mcqApiProvider: 'cli:codex' });

    assert.equal(named('Local CLI').length, 0, 'there is no separate agent choice to narrow down');
    assert.equal(named('Codex CLI (ChatGPT) configuration').length, 1, 'the CLI the reader chose is the heading');
    assert.equal(named('API key').length, 0, 'a CLI carries its own login, so there is no key row');

    // The model it is given is stored per CLI, not in one shared field.
    const modelRow = find('Model');
    await modelRow.text?.change('gpt-5.5');
    assert.deepEqual(settings.providerModels, { 'cli:codex': 'gpt-5.5' });

    await find('API provider').dropdown?.change('cli:claude');
    await find('Model').text?.change('sonnet');
    assert.deepEqual(
        settings.providerModels,
        { 'cli:codex': 'gpt-5.5', 'cli:claude': 'sonnet' },
        'each CLI keeps its own model',
    );
});

test('the check reports names and a count, not a page of explanations', async () => {
    const { find, section } = makeTab({ providerKeys: { xai: 'xai-test' } });
    await find('Detected providers').button?.click();

    const apiSection = section('API configuration');
    const summary = apiSection.find(el => el.hasClass('sf-provider-status-summary'));
    assert.ok(summary, 'one summary line');
    assert.match(summary.text, /ready now: /, 'the ready providers are named');
    assert.match(summary.text, /xAI \(Grok\)/, 'including the one this vault has a key for');
    assert.equal(summary.children.length, 0, 'and nothing is nested under it');

    // Nothing per provider is written into the section: the detail belongs to the
    // chosen provider's own rows.
    assert.equal(apiSection.byClass('sf-provider-status-list').length, 0, 'no list of provider essays');
    assert.equal(apiSection.byClass('sf-provider-status').length, 0, 'no per-provider rows');

    // A vault with nothing configured gets the same single line, not twenty-eight.
    const cold = makeTab();
    await cold.find('Detected providers').button?.click();
    const coldSummary = cold.section('API configuration').find(el => el.hasClass('sf-provider-status-summary'));
    assert.ok(coldSummary, 'still one line');
    assert.match(coldSummary.text, /(ready now: |None of the \d+ providers is ready yet)/);
    assert.equal(cold.section('API configuration').byClass('sf-provider-status').length, 0);
});

test('a provider is only called ready when its own rule says it is usable', async () => {
    // OpenAI-compatible with no URL: the summary must not count it, even though
    // its key is optional.
    const { find, section } = makeTab({ providerKeys: {}, providerUrls: {} });
    await find('Detected providers').button?.click();
    const summary = section('API configuration').find(el => el.hasClass('sf-provider-status-summary'));
    assert.doesNotMatch(summary.text, /OpenAI-compatible server/, 'no URL means not ready');
});

test('a provider added later is configured in the same rows as the original six', async () => {
    const { find, settings } = makeTab({ mcqApiProvider: ApiProvider.Xai });

    const keyRow = find('API key');
    assert.equal(keyRow.text?.value, '', 'nothing stored yet');
    keyRow.text?.setValue('xai-key');
    await keyRow.text?.change('xai-key');
    assert.deepEqual(settings.providerKeys, { xai: 'xai-key' }, 'the key goes to the shared store, keyed by provider');

    const modelRow = find('Model');
    const xai = getHttpProvider(ApiProvider.Xai);
    assert.ok(xai);
    assert.ok(modelRow.descEl.text.includes(xai.latestModel), 'the newest model is named where the reader looks');
    assert.equal(modelRow.text?.placeholder, xai.latestModel, 'and offered as the field\u2019s own suggestion');
    await modelRow.text?.change('grok-3');
    assert.deepEqual(settings.providerModels, { xai: 'grok-3' }, 'a chosen model is stored');
});

test('a provider whose endpoint is the reader\u2019s gets a URL row above its key', async () => {
    const { find, settings, section } = makeTab({ mcqApiProvider: ApiProvider.AzureOpenai });

    const urlRow = find('API URL');
    const apiSection = section('API configuration');
    assert.ok(apiSection.find(el => el === urlRow.settingEl), 'the URL row belongs to the API section');
    assert.equal(urlRow.text?.value, '', 'nothing stored yet');

    await urlRow.text?.change('https://res.openai.azure.com/openai/deployments/dep');
    assert.deepEqual(settings.providerUrls, { 'azure-openai': 'https://res.openai.azure.com/openai/deployments/dep' });
    assert.ok(find('API key'), 'and the key row is still there');
});

test('choosing a provider draws its detection matrix, and a CLI is checked at once', async () => {
    const { find, section } = makeTab({ mcqApiProvider: 'cli:claude' });
    const apiSection = section('API configuration');

    // The matrix is the shape a reader can scan: label on the left, what was found
    // on the right. Checking runs because the choice was made, not because a
    // button was pressed.
    const rows = async (): Promise<Array<[string, string]>> => {
        const matrix = apiSection.find(el => el.hasClass('sf-detect-matrix'));
        if (!matrix) return [];
        for (let attempt = 0; attempt < 40; attempt++) {
            const found = matrix.children
                .filter(row => row.hasClass('sf-detect-row'))
                .map(row => [
                    row.children.find(child => child.hasClass('sf-detect-label'))?.text ?? '',
                    row.children.find(child => child.hasClass('sf-detect-value'))?.text ?? '',
                ] as [string, string]);
            if (found.length > 0) return found;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return [];
    };

    const labels = (await rows()).map(([label]) => label);
    assert.deepEqual(labels, ['Binary', 'Version', 'Signed in', 'Models'], 'the matrix reports the four things that matter');
    const values = new Map(await rows());
    assert.ok((values.get('Binary') ?? '').length > 0, 'and every row has an answer');

    // A company gets the same widget, filled from its own settings.
    const { find: findCompany, section: sectionCompany } = makeTab({ mcqApiProvider: ApiProvider.Xai, providerKeys: { xai: 'k' } });
    const companyRows = sectionCompany('API configuration')
        .find(el => el.hasClass('sf-detect-matrix'));
    assert.ok(companyRows, 'a chosen company has a matrix too');
    const companyValues = new Map(companyRows.children
        .filter(row => row.hasClass('sf-detect-row'))
        .map(row => [
            row.children.find(child => child.hasClass('sf-detect-label'))?.text ?? '',
            row.children.find(child => child.hasClass('sf-detect-value'))?.text ?? '',
        ] as [string, string]));
    assert.deepEqual([...companyValues.keys()], ['Key', 'Endpoint', 'Model']);
    assert.equal(companyValues.get('Key'), 'from this vault', 'the key is reported by where it came from');
    assert.match(companyValues.get('Endpoint') ?? '', /^https:\/\/api\.x\.ai/, 'and the endpoint it will call');
    assert.equal(companyValues.get('Model'), getHttpProvider(ApiProvider.Xai)?.latestModel, 'with the model it would ask for');
    void find; void findCompany;
});

test('the Anki switch shows its address row in place, without rebuilding the tab', async () => {
    const h = makeTab({ ankiConnectEnabled: false });
    const toggle = h.find('Sync with Anki in the background');
    const address = h.find('AnkiConnect address');
    const addressEl = address.settingEl;
    const sectionBefore = h.section('Spaced repetition');

    assert.ok(addressEl.hasClass('sf-hidden'), 'the address waits while the switch is off');

    await toggle.toggle?.change(true);

    assert.equal(h.settings.ankiConnectEnabled, true);
    assert.ok(!addressEl.hasClass('sf-hidden'), 'and appears as soon as it is on');
    assert.equal(address.settingEl, addressEl, 'the same row, not a rebuilt one');
    assert.equal(h.section('Spaced repetition'), sectionBefore, 'the section the reader had open is still there');
    assert.equal(h.settings.ankiConnectUrl, 'http://127.0.0.1:8765', 'with the add-on\u2019s own default ready to edit');
});

test('a phone explains the Anki bridge instead of offering a switch that cannot work', async () => {
    const platform = Platform as unknown as { isDesktop: boolean };
    platform.isDesktop = false;
    try {
        const h = makeTab({ ankiConnectEnabled: false });
        assert.deepEqual(h.named('Sync with Anki in the background'), [], 'no switch');
        assert.deepEqual(h.named('AnkiConnect address'), [], 'no address to edit');
        const text = h.section('Spaced repetition')?.textContent ?? '';
        assert.match(text, /Anki runs on a computer/, 'and it says why');
        assert.match(text, /through the vault/, 'and where the decks come from instead');
    } finally {
        platform.isDesktop = true;
    }
});
