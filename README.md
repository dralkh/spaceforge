# Spaceforge: Advanced Spaced Repetition & AI-Powered Study Plugin for Obsidian

**Spaceforge: Your ultimate Obsidian plugin for efficient knowledge management, memory retention, and exam preparation. Featuring advanced spaced repetition (FSRS & SM-2), AI-powered MCQ generation, and an integrated study Pomodoro timer.**

Spaceforge transforms your Obsidian notes into a powerful learning and revision tool. It enhances your learning workflow by providing intelligent flashcards, automated multiple-choice question generation, and focused study sessions, all designed for optimal memory retention and active recall.

![image](https://github.com/user-attachments/assets/064adc71-0769-46cb-8b46-21dafbc42b31)

## Preview
https://github.com/user-attachments/assets/10bb251e-360c-41ae-a128-e90f3f3e2576

## Key Features

*   **Advanced Spaced Repetition & Smart Flashcards:**
    *   Master active recall with cutting-edge spaced repetition algorithms: **FSRS (Free Spaced Repetition Scheduler)**, a modern, scientifically optimized algorithm for maximum memory retention, or an **enhanced SM-2 algorithm** for efficient review scheduling.
    *   Customize your learning journey with tailored scheduling parameters, turning your notes into intelligent flashcards.
*   **AI-Powered MCQ Generation & Quiz Creation:**
    *   Effortlessly create Multiple Choice Questions (MCQs) directly from your Obsidian notes, transforming them into interactive quizzes.
    *   Leverage powerful AI models from various providers: **OpenAI, OpenRouter, Ollama, Gemini, Claude, and Together** for intelligent question generation.
    *   Seamlessly configure API keys and AI models within the plugin settings for personalized quiz creation.
*   **Integrated Pomodoro Timer:**
    *   Boost productivity with a built-in Pomodoro timer.
    *   Customize work, short break, and long break durations.
    *   Track sessions and manage your focus directly within Obsidian.
*   **Comprehensive Review Management:**
    *   A dedicated sidebar view displays upcoming reviews, estimated completion times, and allows for easy navigation.
    *   Calendar view for visualizing your review schedule.
*   **Flexible Note Addition:**
    *   Add individual notes or entire folders to your review schedule via the right-click context menu.
    *   Use Obsidian commands to add the current note or its folder.
*   **Centralized Data, No Frontmatter Clutter:**
    *   All review schedules and plugin data are stored centrally, keeping your note frontmatter clean.
    *   Option to specify a custom data path for your Spaceforge data.
*   **Customizable Settings:**
    *   Extensive settings tab to configure scheduling algorithms, API providers, Pomodoro timer, appearance, and behavior.

## Getting Started: Install & Configure Your Obsidian Study Plugin

1.  **Installation:** Easily install Spaceforge directly from the Obsidian Community Plugins browser. Alternatively, for manual installation or development:

```bash
# Clone the Spaceforge repository
git clone https://github.com/dralkh/spaceforge.git
cd spaceforge

# Install dependencies, build the plugin, and deploy to your Obsidian vault
npm install && npm run build && node install.js --d /home/user/Documents/vault/.obsidian/plugins

```

2.  **Configuration:** Optimize Spaceforge for your learning style:
    *   Access the Spaceforge settings within Obsidian.
    *   Select your preferred Spaced Repetition Algorithm (FSRS is highly recommended for its efficiency).
    *   For AI-powered MCQ Generation, choose your desired AI provider (e.g., OpenAI, Gemini) and input the necessary API key and model details.
    *   Personalize Pomodoro timer durations to fit your study habits.

> **Disclaimer:** When updating Spaceforge, please ensure you preserve your `data.json` file, which contains all your review schedules and MCQ questions. striving to maintain backward compatibility, it may not always work flawlessly.

### How to Use

#### Adding Notes to Review
*   **File Explorer:** Right-click on a note or a folder in the file explorer and select "Add to review schedule."
*   **Automatic linking heirachy:** Notes will be based upon main folder name note which all links would go through serially, if none is found it will find note with most links to be main focal point of the specific folder. Outgoing link to be included but not its concurrent folder's notes.
*   **Command Palette:**
    *   Use "Spaceforge: Add Current Note to Review Schedule."
    *   Use "Spaceforge: Add Current Note's Folder to Review Schedule."

#### Reviewing Notes
1.  Open the Spaceforge sidebar (usually on the right, or activate via the ribbon icon/command "Spaceforge: Open Review Sidebar").
2.  The sidebar lists notes due for review.
3.  Click on a note to open it or click the "Review" button.
4.  After reviewing a standard note, rate your recall (e.g., Again, Hard, Good, Easy). The note will be rescheduled accordingly.
5.  For MCQs, answer the questions presented.

#### Using the Pomodoro Timer
1.  Access Pomodoro controls from the Spaceforge sidebar.
2.  Start, pause, reset, or skip Pomodoro sessions (Work, Short Break, Long Break).
3.  The timer and current session type are displayed in the sidebar.

## Core Concepts

### Scheduling Algorithms: Optimize Your Learning
*   **FSRS (Free Spaced Repetition Scheduler):** A cutting-edge, modern algorithm rooted in memory science that dynamically optimizes your review intervals for maximum retention and learning efficiency. Customize FSRS parameters in settings to fine-tune your spaced repetition system.
*   **SM-2 (SuperMemo 2):** A proven, classic spaced repetition algorithm. Spaceforge utilizes an enhanced version of SM-2 to intelligently manage overdue items and facilitate comprehensive note reviews, ensuring effective knowledge recall.

### AI-Powered MCQ Generation: Create Quizzes from Your Notes
Spaceforge seamlessly integrates with various AI services to automatically generate Multiple Choice Questions from your note content. This powerful feature transforms your study material into interactive quizzes, providing an alternative and effective way to test your understanding and reinforce learning. Ensure your chosen AI provider is configured correctly in the settings to unlock this intelligent quiz creation capability.

## Settings Overview

The Spaceforge settings tab allows you to customize:
*   **General Settings:** Default review views, notification preferences.
*   **Scheduling Algorithm:** Select and configure FSRS or SM-2 parameters.
*   **MCQ Generation:** Enable/disable MCQs, select API provider, enter API keys and models.
*   **Pomodoro Timer:** Enable/disable, set durations for work/break sessions, sound notifications.
*   **Data Management:** Set a custom path for plugin data, import/export data.

## Commands & Shortcuts

Spaceforge adds several commands to the Obsidian command palette:
*   `Spaceforge: Next Review Note`
*   `Spaceforge: Previous Review Note`
*   `Spaceforge: Review Current Note`
*   `Spaceforge: Add Current Note to Review Schedule`
*   `Spaceforge: Add Current Note's Folder to Review Schedule`
*   `Spaceforge: Open Review Sidebar`

You can assign custom keyboard shortcuts to these commands via Obsidian's hotkey settings.


## Support & Contribution

If you encounter any issues, have feature requests, or would like to contribute, please let me know.

## License

This plugin is licensed under the MIT License.

## Future Enhancements (Ideas)
**I. Enhanced Question Generation & Active Recall Tools:**
*   **Diverse Question Types:** Beyond MCQs, support for generating Cloze Deletions (fill-in-the-blanks), True/False questions, and short-answer prompts to enhance active recall.
*   **Question Quality Feedback:** Enable users to rate generated questions, potentially influencing future AI generation or flagging sets for review and improvement.
*   **Context-Aware Generation:** Optionally use content from linked notes to create questions that test understanding of connections and interdisciplinary knowledge.

**II. Advanced Spaced Repetition & Learning Analytics:**
*   **"Leech" Management:** Detect and provide special handling for notes that are consistently difficult for the user (e.g., options to suspend, reset, or refactor for improved learning).
*   **Advanced Statistics & Visualizations:** Gain deeper insights into your learning progress with review heatmaps, success rate charts over time, forecasted workload visualizations, and ease/difficulty distribution charts.
*   **FSRS Parameter Optimization Helper:** An in-plugin tool to help users fine-tune FSRS weights based on their personal review history, maximizing memory retention.
*   **Flexible Manual Rescheduling:** More options to manually set a specific next review date for a note, offering greater control over your study schedule.
*   **"Deck" / Topic-Based Reviews:** Allow focusing review sessions on specific topics (e.g., via tags or folders) or interleaving notes from different topics for comprehensive study.
*   **Focus Mode:** A less cluttered UI during active review sessions to minimize distractions and enhance concentration.

**III. User Experience & Study Workflow Improvements:**
*   **Enhanced List Filtering & Sorting:** More options to filter (by text, tags) and sort (by title, ease, interval) notes in the review list with variable reading time, improving study organization.
*   **Improved Batch Operations:** Perform actions (postpone, remove, generate MCQs) on multiple selected notes in the sidebar, boosting productivity.
*   **Customizable Sidebar Sections:** Allow users to show/hide or reorder sections within the Spaceforge sidebar for a personalized study environment.
*   **More Informative Note Items:** Display more details on note items (e.g., icons for MCQ availability, leech status, FSRS/SM-2 type; hover for more stats) for quick insights.
*   **Calendar View Enhancements:** More interactive calendar with direct review options, visual density indicators, and hover details for better schedule management.
*   **Pomodoro UI Refinements:** Visual timer, session history, and more sound customization options for an improved focus timer experience.

**IV. Integrations & Data Management:**
*   **Anki Sync (Import/Export):** More robust Anki compatibility, creation of .md files based on batch, subdivided links based on amount of content with predefined questions, facilitating seamless data transfer and flashcard management.
