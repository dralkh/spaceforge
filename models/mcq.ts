/**
 * Represents a single multiple-choice question
 */
export interface MCQQuestion {
    /**
     * The question text
     */
    question: string;
    
    /**
     * Available answer choices
     */
    choices: string[];
    
    /**
     * Index of the correct answer in the choices array
     */
    correctAnswerIndex: number;
}

/**
 * A set of multiple-choice questions for a note
 */
export interface MCQSet {
    /**
     * Path to the note these questions are for
     */
    notePath: string;
    
    /**
     * Array of questions
     */
    questions: MCQQuestion[];
    
    /**
     * When the set was generated (timestamp)
     */
    generatedAt: number;

    /**
     * Flag indicating if this MCQ set needs regeneration before next review
     * Optional for backward compatibility.
     */
    needsQuestionRegeneration?: boolean;
}

/**
 * User's answer to a question
 */
export interface MCQAnswer {
    /**
     * Index of the question in the MCQSet
     */
    questionIndex: number;
    
    /**
     * Index of the selected answer
     */
    selectedAnswerIndex: number;
    
    /**
     * Whether the answer was correct
     */
    correct: boolean;
    
    /**
     * Time taken to answer in seconds
     */
    timeToAnswer: number;
    
    /**
     * Number of attempts made
     */
    attempts: number;
}

/**
 * A session of answering MCQs
 */
export interface MCQSession {
    /**
     * ID of the MCQ set being used
     */
    mcqSetId: string;
    
    /**
     * Path to the note
     */
    notePath: string;
    
    /**
     * User's answers to questions
     */
    answers: MCQAnswer[];
    
    /**
     * Overall score (0-1)
     */
    score: number;
    
    /**
     * Current question index
     */
    currentQuestionIndex: number;
    
    /**
     * Whether the session is completed
     */
    completed: boolean;
    
    /**
     * When the session started
     */
    startedAt: number;
    
    /**
     * When the session was completed (null if not completed)
     */
    completedAt: number | null;
}
