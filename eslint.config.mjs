import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import tsparser from "@typescript-eslint/parser";

export default [
    { ignores: ["dist/", "node_modules/", "main.js", ".eslintrc.js", "esbuild.config.mjs", "version-bump.mjs", "eslint-plugin/", "install.js"] },

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
            "obsidianmd/prefer-file-manager-trash-file": "warn",
            "obsidianmd/prefer-abstract-input-suggest": "error",
            "obsidianmd/regex-lookbehind": "error",
            "obsidianmd/sample-names": "error",
            "obsidianmd/validate-manifest": "error",
            "obsidianmd/validate-license": ["error"],
            "obsidianmd/ui/sentence-case": "warn"
        },
    },
];
