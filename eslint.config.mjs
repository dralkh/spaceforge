import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import tsparser from "@typescript-eslint/parser";

export default [
    { ignores: ["dist/", "node_modules/", "main.js", ".eslintrc.js", "esbuild.config.mjs", "version-bump.mjs", "eslint-plugin/", "install.js", ".test-build/", "test/", "live-test-vault/", "media/"] },

    pluginJs.configs.recommended,
    ...tseslint.configs.recommended,

    {
        files: ["**/*.ts", "**/*.tsx"],
        plugins: {
            obsidianmd: obsidianmd
        },
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: import.meta.dirname,
            },
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/ban-ts-comment": "off",
            "@typescript-eslint/no-empty-function": "off",
            "no-unused-vars": "off",
            "no-prototype-builtins": "off",
            "@typescript-eslint/require-await": "error",
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/no-misused-promises": "error",
            "no-empty": "error",

            // Obsidian Rules
            "obsidianmd/commands/no-command-in-command-id": "error",
            "obsidianmd/commands/no-command-in-command-name": "error",
            "obsidianmd/commands/no-default-hotkeys": "error",
            "obsidianmd/commands/no-plugin-id-in-command-id": "error",
            "obsidianmd/commands/no-plugin-name-in-command-name": "error",
            "obsidianmd/settings-tab/no-manual-html-headings": "error",
            "obsidianmd/settings-tab/no-problematic-settings-headings": "error",
            "obsidianmd/settings-tab/prefer-setting-definitions": "warn",
            "obsidianmd/vault/iterate": "error",
            "obsidianmd/detach-leaves": "error",
            "obsidianmd/hardcoded-config-path": "error",
            "obsidianmd/no-forbidden-elements": "error",
            "obsidianmd/no-plugin-as-component": "error",
            "obsidianmd/no-sample-code": "error",
            "obsidianmd/no-tfile-tfolder-cast": "error",
            "obsidianmd/no-view-references-in-plugin": "error",
            "obsidianmd/no-static-styles-assignment": "error",
            "obsidianmd/object-assign": "error",
            "obsidianmd/platform": "error",
            "obsidianmd/prefer-file-manager-trash-file": "error",
            "obsidianmd/prefer-abstract-input-suggest": "error",
            "obsidianmd/regex-lookbehind": "error",
            "obsidianmd/sample-names": "error",
            "obsidianmd/validate-manifest": "error",
            "obsidianmd/validate-license": ["error"],
            // Product and feature names this plugin uses in its UI. The rule keeps
            // proper nouns capitalised and lowercases everything else, so without
            // this list our own names ("Spaceforge", "Study") and the CLIs we drive
            // read as title case to the linter.
            "obsidianmd/ui/sentence-case": ["error", {
                brands: [
                    "Anki",
                    "AnkiWeb",
                    "FSRS",
                    "SM-2",
                    "Cloze",
                    "Spaceforge",
                    "Spaceforge Study",
                    "Study",
                    "MCQs",
                    "Pomodoro",
                    "OpenRouter",
                    "Claude Code",
                    "Codex",
                    "Cursor Agent",
                    "Hermes",
                    "OpenClaw",
                    "Gemini CLI",
                    "Together AI",
                    "Tavily",
                    "Brave",
                    "SearXNG",
                    "FSRS",
                    "SM-2",
                ],
            }]
        },
    },
];
