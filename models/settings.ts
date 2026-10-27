import { DeckSessionPlacement, ReviewInterfaceMode, ReviewSessionHost, ReviewSessionPlacement } from './review-flow';

/**
 * MCQ difficulty levels
 */
export enum MCQDifficulty {
    /**
     * Basic difficulty - focuses on recall and simple understanding
     */
    Basic = 'basic',
    
    /**
     * Advanced difficulty - focuses on deeper understanding and application
     */
    Advanced = 'advanced'
}

/**
 * How the number of MCQs per note is determined
 */
export enum MCQQuestionAmountMode {
    /** User sets a fixed number of questions per note */
    Fixed = 'fixed',
    /** Number of questions is based on the note's word count */
    WordsPerQuestion = 'wordsPerQuestion'
}

/**
 * Where the Study tutor looks things up when ground-truthing a mechanism.
 */
export enum StudySearchProvider {
    /** No lookups; the tutor must flag claims as unverified. */
    None = 'none',
    Tavily = 'tavily',
    Brave = 'brave',
    /** Self-hosted SearXNG instance exposing its JSON API. */
    Searxng = 'searxng',
    /** Any endpoint accepting {query, max_results} and returning a results array. */
    Custom = 'custom'
}

/**
 * Where the tutor starts the learner. 'auto' lets the first few answers decide.
 */
export enum StudyExpertise {
    Auto = 'auto',
    Beginner = 'beginner',
    Intermediate = 'intermediate',
    Advanced = 'advanced'
}

/**
 * Plugin settings for Spaceforge
 */
export interface SpaceforgeSettings {
    /**
     * Show notifications when navigating between notes
     * Default: true
     */
    showNavigationNotifications: boolean;
    
    /**
     * Base ease factor for new notes (higher = longer intervals)
     * In SM-2, the default initial value is 2.5, stored as 250 internally
     * Default: 250 (2.5 in SM-2)
     */
    baseEase: number;
    
    /**
     * Add slight randomness to intervals to balance the workload
     * Default: true
     */
    loadBalance: boolean;
    
    /**
     * Maximum interval between reviews (in days)
     * Default: 365
     */
    maximumInterval: number;

    /**
     * Use a custom data path for storing plugin data
     * Default: false
     */
    useCustomDataPath: boolean;

    /**
     * Custom path for storing plugin data (relative to vault root)
     * Default: ''
     */
    customDataPath: string;
    
    // Auto-review is now the default behavior
    
    /**
     * Notification time for upcoming reviews (in minutes before due)
     * Default: 120
     */
    notifyBeforeDue: number;
    
    /**
     * Include subfolders when adding a folder to review
     * Default: true
     */
    includeSubfolders: boolean;
    
    /**
     * Reading speed in words per minute (used for time estimation)
     * Default: 120 WPM
     */
    readingSpeed: number;
    
    /**
     * View type for the sidebar (list or calendar)
     * Default: 'list'
     */
    sidebarViewType: 'list' | 'calendar' | 'review';
    
    /**
     * Use fixed schedule for initial reviews before switching to full SM-2 algorithm
     * 
     * When enabled, the first 5 reviews will use fixed intervals:
     * Review 1: Same day (0 days)
     * Review 2: 3 days
     * Review 3: 7 days
     * Review 4: 14 days
     * Review 5: 30 days
     * 
     * After these initial reviews, it switches to the standard SM-2 algorithm.
     * This approach helps build a solid foundation before longer intervals.
     * 
     * Default: true
     */
    useInitialSchedule: boolean;

    /**
     * Custom intervals for the initial learning phase (in days)
     * Default: [0, 3, 7, 14, 30]
     */
    initialScheduleCustomIntervals: number[];
    
    /**
     * Enable MCQ feature
     * Default: false
     */
    enableMCQ: boolean;
    
    /**
     * OpenRouter API key for generating MCQs
     * Default: ''
     */
    openRouterApiKey: string;
    
    /**
     * Model to use for generating MCQs
     * Default: 'openai/gpt-6.1-sol'
     */
    openRouterModel: string;
    
    /**
     * Type of prompt to use for generating MCQs
     * Default: 'detailed'
     */
    mcqPromptType: 'basic' | 'detailed';
    
    /**
     * Number of questions to generate per note
     * Default: 4
     */
    mcqQuestionsPerNote: number;
    
    /**
     * Number of choices per question
     * Default: 5
     */
    mcqChoicesPerQuestion: number;

    /**
     * How to determine the number of questions per note
     * Default: 'fixed'
     */
    mcqQuestionAmountMode: MCQQuestionAmountMode;

    /**
     * Target number of words per question when using WordsPerQuestion mode
     * Default: 100
     */
    mcqWordsPerQuestion: number;
    
    /**
     * Amount to deduct from score for slow answers (0-1)
     * Default: 0.5
     */
    mcqTimeDeductionAmount: number;
    
    /**
     * Time threshold in seconds after which to apply time deduction
     * Default: 90
     */
    mcqTimeDeductionSeconds: number;
    
    /**
     * MCQ difficulty level
     * Default: 'advanced'
     */
    mcqDifficulty: MCQDifficulty;

    /**
     * Deduct full mark for a question if the first attempt is a failure.
     * Default: false
     */
    mcqDeductFullMarkOnFirstFailure: boolean;

    /**
     * API Provider for MCQ generation. Every company in the registry, and every
     * local CLI under its own id (`cli:claude`).
     * Default: 'ollama'
     */
    mcqApiProvider: ProviderId;

    /**
     * OpenAI API Key
     * Default: ''
     */
    openaiApiKey: string;

    /**
     * OpenAI Model
     * Default: 'gpt-6.1-sol'
     */
    openaiModel: string;

    /**
     * Ollama API URL
     * Default: ''
     */
    ollamaApiUrl: string;

    /**
     * Ollama Model
     * Default: ''
     */
    ollamaModel: string;

    /**
     * Gemini API Key
     * Default: ''
     */
    geminiApiKey: string;

    /**
     * Gemini Model
     * Default: 'gemini-4-argon'
     */
    geminiModel: string;

    /**
     * Claude API Key
     * Default: ''
     */
    claudeApiKey: string;

    /**
     * Claude Model
     * Default: 'claude-opus-5-5'
     */
    claudeModel: string;

    /**
     * Together AI API Key
     * Default: ''
     */
    togetherApiKey: string;

    /**
     * Together AI Model
     * Default: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8'
     */
    togetherModel: string;

    /**
     * OpenAI Compatible API URL
     * Default: ''
     */
    openaiCompatibleApiUrl: string;

    /**
     * OpenAI Compatible API Key
     * Default: ''
     */
    openaiCompatibleApiKey: string;

    /**
     * OpenAI Compatible Model
     * Default: ''
     */
    openaiCompatibleModel: string;

    /**
     * The old single "local CLI" choice. Each CLI is a provider row of its own
     * now (`cli:<agent>`), so neither field is read any more; they are kept so a
     * vault saved before that still loads, and `migrateSettings` moves the choice
     * onto the CLI's own row.
     */
    cliAgent: string;
    cliModel: string;
    /**
     * Extra folders to search for CLI binaries, before every usual location.
     * The search already knows version managers and npm/bun/pnpm globals; this is
     * for the install that is somewhere else entirely.
     */
    cliExtraPath: string;

    /**
     * Keys, endpoints and models for the providers added after the original
     * six, keyed by provider id (`ApiProvider`). One store rather than three
     * fields per company: a new provider is a row in api/provider-registry.ts
     * and nothing else, and a provider's model can be left empty, in which case
     * the newest model that provider ships (its registry `latestModel`) is used.
     *
     * The original six keep their own fields so no existing vault needs a
     * migration; `providerKey`/`providerModel`/`providerBaseUrl` in the registry
     * read whichever of the two shapes a provider uses.
     */
    providerKeys: Record<string, string>;
    providerModels: Record<string, string>;
    providerUrls: Record<string, string>;
    
    /**
     * System prompt for basic difficulty MCQs
     */
    mcqBasicSystemPrompt: string;
    
    /**
     * System prompt for advanced difficulty MCQs
     */
    mcqAdvancedSystemPrompt: string;

    // Pomodoro Timer Settings
    pomodoroEnabled: boolean;
    pomodoroSoundEnabled: boolean;
    pomodoroWorkDuration: number; // in minutes
    pomodoroShortBreakDuration: number; // in minutes
    pomodoroLongBreakDuration: number; // in minutes
    pomodoroSessionsUntilLongBreak: number;

    // MCQ Question Regeneration Settings
    /**
     * Enable automatic regeneration of MCQs based on review rating
     * Default: false
     */
    enableQuestionRegenerationOnRating: boolean;

    /**
     * Minimum SM-2 review rating (0-5) to trigger MCQ regeneration.
     * Ratings at or above this value will trigger regeneration.
     * Default: 5 (Perfect Recall)
     */
    minSm2RatingForQuestionRegeneration: number;

    /**
     * Minimum FSRS review rating (1-4) to trigger MCQ regeneration.
     * Ratings at or above this value will trigger regeneration.
     * Default: 4 (Easy)
     */
    minFsrsRatingForQuestionRegeneration: number;

    // --- Algorithm Settings ---
    defaultSchedulingAlgorithm: 'sm2' | 'fsrs';

    // --- Review flow settings ---
    /**
     * How the review controls are presented.
     *
     * 'strip': the note opens in a normal tab and the grades live in a bar
     * docked underneath it, advancing to the next due note on each grade.
     * 'modal': the original dialog shown on top of the note.
     *
     * Default: 'strip'
     */
    reviewInterface: ReviewInterfaceMode;

    /**
     * Where a review session appears: in a split beside the note, or in its own
     * window (which can go on a second monitor, and leaves the pane you were
     * working in alone).
     * Default: 'split'
     */
    reviewSessionPlacement: ReviewSessionPlacement;
    /** Where the session's own surfaces live; see ReviewSessionHost. */
    reviewSessionHost: ReviewSessionHost;

    /**
     * Where a card sitting opens.
     *
     * A card sitting is a short, self-contained thing — the reader is answering
     * cards, not working inside a note — so it opens as a modal over the app by
     * default; the pane and a window of its own stay available for readers who
     * want the note beside their cards. Default: 'modal'.
     */
    deckSessionPlacement: DeckSessionPlacement;

    /**
     * How long one card takes, for the sidebar's estimates.
     *
     * A note carries its own estimate, measured from the note itself; a card
     * does not, so a plain number the reader sets is honest where a guess dressed
     * up as arithmetic would not be. Default: 1 minute.
     */
    deckMinutesPerCard: number;

    /**
     * Sync decks with Anki through the AnkiConnect add-on on this computer.
     *
     * Off by default: it makes the plugin write into a running Anki, which is
     * not something a reader should discover after the fact. When it is on, the
     * plugin pulls each deck, merges per card, and pushes the merged deck back
     * on a timer — see `services/anki-connect-service.ts`.
     */
    ankiConnectEnabled: boolean;

    /**
     * Carry review progress through the vault itself.
     *
     * The data file lives in `.obsidian/plugins/spaceforge/`, which is exactly
     * the folder people leave out of a sync. With this on, a projection of the
     * progress and of the preferences worth sharing is written to
     * `spaceforge/state/progress.json`, inside the vault, and merged back on
     * load: a device that syncs only notes still picks up the reviews. Device
     * settings (Anki's address, the data path) and session state stay behind.
     *
     * Off by default: it writes a second file, and that should be a choice.
     */
    syncProgressThroughVault: boolean;

    /**
     * Where AnkiConnect listens. The add-on's own default is
     * `http://127.0.0.1:8765`; anything else here is a deliberate choice (a
     * different port, or a host with the add-on bound to the network).
     */
    ankiConnectUrl: string;

    /**
     * The deck revision last sent to Anki, per deck path.
     *
     * A push is an import of the whole deck, and Anki's importer is slow on a
     * large one, so a deck whose `modified` stamp has not moved since the last
     * successful push is left alone: the timer then costs a pull and a due-date
     * pass, not a rebuild of every package.
     */
    ankiPushed: Record<string, number>;

    /**
     * Internal bookkeeping: set once the corrected FSRS short-term default has
     * been applied to an existing vault, so a later explicit "off" is respected.
     */
    fsrsShortTermMigrated?: boolean;

    /**
     * Set once the upgrade that turned background charting off by default has
     * run. Without it, a vault whose data.json says `studyAutoChart: true`
     * (which is every vault saved by 1.0.x — the old default was written out
     * on every save) would keep pre-charting for good.
     */
    studyChartDefaultMigrated?: boolean;

    /**
     * Show the resulting interval on each grade button.
     * Default: true
     */
    reviewStripIntervalPreviews: boolean;

    /**
     * How the grade palette is laid out in the review bar.
     *
     * `auto` reads the room the bar was given: one row when the names fit, a
     * compact two-column palette when they do not. `row` and `stack` are the
     * reader's own choice, for a host the automatic rule guesses wrong.
     * Default: 'auto'
     */
    reviewGradeLayout: ReviewGradeLayout;

    /**
     * Grade with the plain number keys while a review session is running.
     * Digits are still ignored while the caret is in text, where Alt+number works.
     * Default: true
     */
    reviewStripGradeKeys: boolean;

    /**
     * Lapses after which a note asks what should happen to it (reset, rest,
     * remove or carry on). 0 disables the prompt.
     * Default: 8
     */
    leechThreshold: number;

    // --- FSRS Specific Settings ---
    fsrsParameters: {
        request_retention?: number;
        maximum_interval?: number;
        w?: number[]; // FSRS-5 weights (19 numbers, the set ts-fsrs ships)
        enable_fuzz?: boolean;
        enable_short_term?: boolean;
    };

    // --- Navigation Command Settings ---
    enableNavigationCommands: boolean;
    navigationCommand: {
        modifiers: string[];
        key: string | null;
    };
    navigationCommandDelay: number; // in milliseconds

    // --- Calendar Events Settings ---
    /**
     * Enable calendar events feature
     * Default: true
     */
    enableCalendarEvents: boolean;

    /**
     * Show upcoming events below calendar
     * Default: true
     */
    showUpcomingEvents: boolean;

    /**
     * Number of days to show in upcoming events list
     * Default: 7
     */
    upcomingEventsDays: number;

    /**
     * Default event category
     * Default: 'personal'
     */
    defaultEventCategory: string;
    
    /**
     * Enable recurring notes feature
     * Default: false
     */
    enableRecurringNotes: boolean;
    
    /**
     * Default recurrence interval for new recurring notes (in days)
     * Default: 7
     */
    defaultRecurrenceInterval: number;

    // --- Study (adaptive tutor) Settings ---

    /**
     * Enable the Study feature
     * Default: true
     */
    studyEnabled: boolean;

    /**
     * Show the Study button on sidebar note rows
     * Default: true
     */
    studyShowInSidebar: boolean;

    /**
     * Chart notes ahead of time, in the background, as they are added to review.
     *
     * Off by default: nobody's model calls should be spent on notes they may
     * never open, and a vault-wide charting pass is real money and real quota.
     * With it off, the note in front of you is charted the moment you open its
     * Study panel (and its questions are written when you ask for them) — the
     * same result, paid for one note at a time, on demand.
     * Default: false
     */
    studyAutoChart: boolean;

    /**
     * After a note's plan is ready, draw its study material (mind map, visual
     * boards, condensed summary) in the background, with no button pressed.
     *
     * Off by default, and deliberately so: it is the same model call the Study
     * panel's own Make it button makes, just moved to the moment the chart
     * finished. With it off, material exists only when the reader asked for it.
     * Default: false
     */
    studyAutoMaterials: boolean;

    /**
     * After a note's plan is ready, write its question set in the background,
     * so a review or the questions tab finds it waiting.
     *
     * Off by default: questions cost a model call each and a vault that did not
     * ask for them should not be quietly spending anything. Default: false
     */
    studyAutoMcq: boolean;

    /**
     * Sections charted per note per background pass
     * Default: 3
     */
    studyChartSectionsPerRun: number;

    /**
     * Default state of the in-session web lookup toggle
     * Default: true (lookups still require a configured search provider)
     */
    studyWebSearchDefault: boolean;

    /**
     * Search backend used by the Study tutor
     * Default: none
     */
    studySearchProvider: StudySearchProvider;

    /**
     * API key for the configured search backend
     * Default: ''
     */
    studySearchApiKey: string;

    /**
     * Endpoint for SearXNG or a custom search backend
     * Default: ''
     */
    studySearchEndpoint: string;

    /**
     * How many sources to pull per lookup
     * Default: 4
     */
    studySearchMaxResults: number;

    /**
     * Where the tutor starts the learner
     * Default: auto
     */
    studyExpertise: StudyExpertise;

    /**
     * Language the tutor speaks. Empty means "match the note".
     * Default: ''
     */
    studyLanguage: string;

    /**
     * Upper bound on objectives produced when charting a note
     * Default: 12
     */
    studyMaxObjectives: number;

    /**
     * Maximum tutor turns in a single session before it wraps up
     * Default: 24
     */
    studyTurnLimit: number;

    /**
     * Sampling temperature for Study turns
     * Default: 0.4
     */
    studyTemperature: number;

    /**
     * Max output tokens per Study turn. Thinking models need headroom: they
     * spend part of the budget on reasoning before they answer.
     * Default: 2000
     */
    studyMaxTokens: number;

    /**
     * Context window hint passed to local backends (Ollama num_ctx)
     * Default: 8192
     */
    studyContextWindow: number;

    /**
     * Rate the note's review schedule from the Study session result
     *
     * Off by default: a finished sitting shows what it scored and leaves the
     * grade to the learner, docked under the note, rather than deciding for
     * them the moment the last turn lands.
     */
    studyAutoRateNote: boolean;

    /**
     * How a finished MCQ sitting becomes a grade.
     *
     * 'ask' shows the grade buttons with the score-derived grade suggested;
     * 'score' applies the score-derived grade as soon as the sitting ends.
     * Default: 'ask'
     */
    mcqGradingMode: McqGradingMode;

    /**
     * Height in px of the docked review workspace (the study/MCQ area under the
     * review bar). 0 = size to content.
     * Default: 0
     */
    reviewDockHeight: number;
}

/**
 * How a completed MCQ sitting is graded.
 *
 * The score is always shown; the question is only whether it is *applied*
 * without being asked.
 */
export type McqGradingMode = 'ask' | 'score';

/**
 * How the review bar lays out its grade palette: fit the host, one row, or
 * one grade per row. See `reviewGradeLayout` in the settings.
 */
export type ReviewGradeLayout = 'auto' | 'row' | 'stack';

/**
 * API Providers for MCQ generation
 */
export enum ApiProvider {
    OpenRouter = 'openrouter',
    OpenAI = 'openai',
    Ollama = 'ollama',
    Gemini = 'gemini',
    Claude = 'claude',
    Together = 'together',
    /** xAI's own API (Grok). */
    Xai = 'xai',
    Mistral = 'mistral',
    Deepseek = 'deepseek',
    Groq = 'groq',
    Fireworks = 'fireworks',
    Cohere = 'cohere',
    Minimax = 'minimax',
    /** Xiaomi's MiMo API. */
    Mimo = 'mimo',
    /** Z.AI (GLM). The coding plan is the same key on its own endpoint. */
    Zai = 'zai',
    Moonshot = 'moonshot',
    /** OpenCode's gateway (Zen and Go) — and its local server on the same row. */
    OpenCode = 'opencode',
    NanoGpt = 'nanogpt',
    /** A local LM Studio server. */
    LmStudio = 'lmstudio',
    /** A local Hermes agent gateway. */
    HermesAgent = 'hermes',
    /** Azure OpenAI deployments, addressed by resource + deployment. */
    AzureOpenai = 'azure-openai',
    OpenAICompatible = 'openai-compatible',
    /**
     * Kept only so a vault that had the old single "local CLI" choice still
     * loads; `migrateSettings` moves it onto the row of the CLI it named.
     */
    Cli = 'cli'
}

/**
 * What `mcqApiProvider` holds: a company from the enum, or one local CLI agent
 * under its own row (`cli:claude`, `cli:codex`, …). Each CLI is its own
 * provider — there is no second choice of *which* agent to run.
 */
export type ProviderId = ApiProvider | `cli:${string}`;

/**
 * Default settings for the plugin
 */
/** The weight set that shipped before FSRS-5 defaults replaced it. */
const LEGACY_DEFAULT_WEIGHTS = [
    0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61
];

/**
 * One-time corrections for settings that shipped with a different meaning.
 *
 * `enable_short_term: false` was the old default, which made a lapse land a day
 * out instead of in the same session. Anyone who never touched the toggle (it had
 * no effect on the numbers either way, as the library ignored the step list) gets
 * the corrected default once; after that the flag records the migration so a
 * deliberate "off" sticks.
 */
export function migrateSettings(settings: SpaceforgeSettings): boolean {
    // Every correction runs in one pass, and the caller saves once if anything
    // changed. They used to return early, which meant an upgrading vault needed
    // two launches before the second correction applied.
    let changed = false;

    // Reviews happen in the docked bar now. A vault that had the dialog
    // selected is moved over, so nobody is left on a setting that no longer
    // does anything.
    if (settings.reviewInterface !== 'strip') {
        settings.reviewInterface = 'strip';
        changed = true;
    }

    // The local CLIs were one provider with a second choice inside it. Each CLI
    // is now its own row, so the choice moves onto that row and the model the CLI
    // was given travels with it.
    if (settings.mcqApiProvider === ApiProvider.Cli) {
        const agent = settings.cliAgent || DEFAULT_SETTINGS.cliAgent;
        settings.mcqApiProvider = `cli:${agent}`;
        if (settings.cliModel) {
            settings.providerModels = { ...(settings.providerModels ?? {}), [`cli:${agent}`]: settings.cliModel };
            settings.cliModel = '';
        }
        changed = true;
    }

    // The Gemini CLI is deprecated in favour of Antigravity (`agy`), which is
    // the same Google account on the successor CLI. A vault that had chosen
    // Gemini moves to the Antigravity row; only the one model id both CLIs took
    // is carried across, and anything else falls back to Antigravity's default
    // so the next run cannot fail on a slug the new CLI never had.
    const provider: string = settings.mcqApiProvider;
    if (provider === 'cli:gemini') {
        settings.mcqApiProvider = 'cli:antigravity';
        const models = { ...(settings.providerModels ?? {}) };
        if (!models['cli:antigravity'] && models['cli:gemini'] === 'gemini-3.8-flash') {
            models['cli:antigravity'] = 'gemini-3.8-flash-medium';
        }
        delete models['cli:gemini'];
        settings.providerModels = models;
        changed = true;
    }

    // Background charting used to default to on, so every vault saved by 1.0.x
    // carries `true` whether or not anyone chose it. Turn it off once — the new
    // default — and let the marker keep any later choice: flip it back on and it
    // stays on, because this block does not run again.
    if (!settings.studyChartDefaultMigrated) {
        settings.studyAutoChart = false;
        settings.studyChartDefaultMigrated = true;
        changed = true;
    }

    if (!settings.fsrsShortTermMigrated) {
        const params = { ...(settings.fsrsParameters ?? {}) } as Record<string, unknown>;
        params.enable_short_term = DEFAULT_SETTINGS.fsrsParameters.enable_short_term;

        // The 17 weights that used to ship are not a complete model: ts-fsrs pads
        // them out with its own values and warns. A vault still on the stock set is
        // moved to the real FSRS-5 defaults; anything the user edited is left alone.
        const weights = params.w as number[] | undefined;
        const isLegacyDefault = Array.isArray(weights)
            && weights.length === LEGACY_DEFAULT_WEIGHTS.length
            && weights.every((value, index) => value === LEGACY_DEFAULT_WEIGHTS[index]);
        if (!weights || weights.length === 0 || isLegacyDefault) {
            params.w = [...DEFAULT_SETTINGS.fsrsParameters.w!];
        }

        // The step list was never read by the scheduler (ts-fsrs 4.7 owns its steps).
        delete params.learning_steps;

        settings.fsrsParameters = params;
        settings.fsrsShortTermMigrated = true;
        changed = true;
    }

    return changed;
}

export const DEFAULT_SETTINGS: SpaceforgeSettings = {
    showNavigationNotifications: false,
    baseEase: 250, // 2.5 in SM-2 format (recommended default from the original algorithm)
    loadBalance: false, // Disable load balancing by default for pure SM-2 compliance
    maximumInterval: 365, // Cap at 1 year (extension to original SM-2)
    useCustomDataPath: false,
    customDataPath: '',
    // autoNextNote property removed, now always true by default
    notifyBeforeDue: 120,
    includeSubfolders: true,
    readingSpeed: 100, // Default WPM set to 100
    sidebarViewType: 'calendar',
    reviewSessionHost: 'note',
    useInitialSchedule: true,
    initialScheduleCustomIntervals: [0, 3, 7, 14, 30],
    
    // MCQ settings
    enableMCQ: true,
    mcqApiProvider: ApiProvider.Ollama, // Default API provider set to Ollama
    openRouterApiKey: '',
    openRouterModel: 'openai/gpt-6.1-sol',
    openaiApiKey: '',
    openaiModel: 'gpt-6.1-sol',
    ollamaApiUrl: '',
    ollamaModel: '',
    geminiApiKey: '',
    geminiModel: 'gemini-4-argon',
    claudeApiKey: '',
    claudeModel: 'claude-opus-5-5',
    togetherApiKey: '',
    togetherModel: 'Qwen/Qwen3.8-2.4T-A95B',
    openaiCompatibleApiUrl: '',
    openaiCompatibleApiKey: '',
    openaiCompatibleModel: '',
    cliAgent: 'claude',
    cliModel: '',
    cliExtraPath: '',
    // The providers added after the original six keep their key, endpoint and
    // model here, keyed by provider id. Empty means "whatever that provider
    // ships newest" for the model, and "not configured" for the rest.
    providerKeys: {},
    providerModels: {},
    providerUrls: {},
    mcqPromptType: 'detailed',
    mcqQuestionsPerNote: 4,
    mcqChoicesPerQuestion: 5,
    mcqQuestionAmountMode: MCQQuestionAmountMode.Fixed, // Default to fixed number
    mcqWordsPerQuestion: 100, // Default words per question if mode is switched
    mcqTimeDeductionAmount: 0.5,
    mcqTimeDeductionSeconds: 90,
    mcqDifficulty: MCQDifficulty.Advanced,
    mcqDeductFullMarkOnFirstFailure: true,
    mcqBasicSystemPrompt: 'You are a tutor who creates clear, straightforward multiple-choice questions to test basic understanding of the given content. Focus on key concepts and important facts. Make questions simple and direct, with one clearly correct answer. Always mark the correct answer with [CORRECT] at the end of the line.',
    mcqAdvancedSystemPrompt: 'You are an expert tutor who creates challenging but fair multiple-choice questions to test deep understanding of the given content. Generate questions that assess comprehension, application, and analysis, not just memorization. Make incorrect choices plausible to encourage critical thinking. Always mark the correct answer with [CORRECT] at the end of the line.',

    // Pomodoro Timer Defaults
    pomodoroEnabled: true,
    pomodoroSoundEnabled: true,
    pomodoroWorkDuration: 25,
    pomodoroShortBreakDuration: 5,
    pomodoroLongBreakDuration: 15,
    pomodoroSessionsUntilLongBreak: 4,

    // MCQ Question Regeneration Settings
    enableQuestionRegenerationOnRating: false,
    minSm2RatingForQuestionRegeneration: 4, // SM-2: 0 (Blackout) to 5 (Perfect Recall) - Defaulting to 4 (Correct with Hesitation)
    minFsrsRatingForQuestionRegeneration: 3, // FSRS: 1 (Again) to 4 (Easy) - Defaulting to 3 (Good)

    // Algorithm Defaults
    defaultSchedulingAlgorithm: 'fsrs',

    // Review flow defaults
    reviewInterface: 'strip',
    reviewSessionPlacement: 'split',
    deckSessionPlacement: 'modal',
    deckMinutesPerCard: 1,
    ankiConnectEnabled: false,
    ankiConnectUrl: 'http://127.0.0.1:8765',
    syncProgressThroughVault: false,
    ankiPushed: {},
    reviewStripIntervalPreviews: true,
    reviewGradeLayout: 'auto',
    reviewStripGradeKeys: true,
    leechThreshold: 8,
    fsrsParameters: {
        request_retention: 0.9,
        maximum_interval: 36500,
        enable_fuzz: true,
        // FSRS-5 default weights: exactly the 19 the library ships. A shorter
        // array makes ts-fsrs pad it (and warn), which is a different model.
        w: [
            0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
            1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621
        ],
        // Anki-style short-term scheduling: a failure lands on a relearning step
        // today (minutes) instead of being pushed out to tomorrow.
        enable_short_term: true,
    },

    // Navigation Command Defaults
    enableNavigationCommands: false,
    navigationCommand: {
        modifiers: [],
        key: null,
    },
    navigationCommandDelay: 500,

    // Calendar Events Defaults
    enableCalendarEvents: true,
    showUpcomingEvents: true,
    upcomingEventsDays: 7,
    defaultEventCategory: 'personal',
    
    // Recurring Notes Defaults
    enableRecurringNotes: false,
    defaultRecurrenceInterval: 7,

    // Study (adaptive tutor) Defaults
    studyEnabled: true,
    studyShowInSidebar: true,
    studyAutoChart: false,
    // The auto-pilot's two steps: after a chart lands, the material and then
    // the questions. Off for everyone; a saved data.json carries the choice.
    studyAutoMaterials: false,
    studyAutoMcq: false,
    studyChartSectionsPerRun: 3,
    studyWebSearchDefault: true,
    studySearchProvider: StudySearchProvider.None,
    studySearchApiKey: '',
    studySearchEndpoint: '',
    studySearchMaxResults: 4,
    studyExpertise: StudyExpertise.Auto,
    studyLanguage: '',
    studyMaxObjectives: 24,
    studyTurnLimit: 24,
    studyTemperature: 0.4,
    studyMaxTokens: 2000,
    studyContextWindow: 8192,
    studyAutoRateNote: false,
    mcqGradingMode: 'ask',
    reviewDockHeight: 0,
};
