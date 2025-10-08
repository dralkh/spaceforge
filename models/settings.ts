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
    sidebarViewType: 'list' | 'calendar';
    
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
     * Default: 'anthropic/claude-3-opus'
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
     * API Provider for MCQ generation
     * Default: 'openrouter'
     */
    mcqApiProvider: ApiProvider;

    /**
     * OpenAI API Key
     * Default: ''
     */
    openaiApiKey: string;

    /**
     * OpenAI Model
     * Default: 'gpt-3.5-turbo'
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
     * Default: 'gemini-pro'
     */
    geminiModel: string;

    /**
     * Claude API Key
     * Default: ''
     */
    claudeApiKey: string;

    /**
     * Claude Model
     * Default: 'claude-3-sonnet-20240229'
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

    // --- FSRS Specific Settings ---
    fsrsParameters: {
        request_retention?: number;
        maximum_interval?: number;
        w?: number[]; // FSRS weights (array of numbers)
        enable_fuzz?: boolean;
        learning_steps?: number[]; // In minutes
        enable_short_term?: boolean; // Added for FSRSParameters requirement
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
}

/**
 * API Providers for MCQ generation
 */
export enum ApiProvider {
    OpenRouter = 'openrouter',
    OpenAI = 'openai',
    Ollama = 'ollama',
    Gemini = 'gemini',
    Claude = 'claude',
    Together = 'together'
}

/**
 * Default settings for the plugin
 */
export const DEFAULT_SETTINGS: SpaceforgeSettings = {
    showNavigationNotifications: true,
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
    useInitialSchedule: true,
    initialScheduleCustomIntervals: [0, 3, 7, 14, 30],
    
    // MCQ settings
    enableMCQ: true,
    mcqApiProvider: ApiProvider.Ollama, // Default API provider set to Ollama
    openRouterApiKey: '',
    openRouterModel: 'openai/gpt-4.1-mini',
    openaiApiKey: '',
    openaiModel: 'gpt-3.5-turbo',
    ollamaApiUrl: '',
    ollamaModel: '',
    geminiApiKey: '',
    geminiModel: 'gemini-pro',
    claudeApiKey: '',
    claudeModel: 'claude-3-sonnet-20240229',
    togetherApiKey: '',
    togetherModel: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
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
    fsrsParameters: {
        request_retention: 0.9,
        maximum_interval: 36500,
        enable_fuzz: true,
        // Default FSRS weights from FSRS-4.5-Anki
        w: [
            0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61
        ],
        learning_steps: [1, 10], // 1 minute, 10 minutes
        enable_short_term: false, // Default for enable_short_term
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
};
