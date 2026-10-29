/**
 * The rules the Obsidian community-plugin review reports on, for this repo.
 *
 * The review bot runs a type-aware pass over the published source and lists its
 * findings by file and line; `npm run lint:review` reproduces that pass locally
 * with `--max-warnings 0`, so a finding is caught here instead of in the next
 * review. It is deliberately narrower than `eslint.config.mjs`: this file says
 * nothing about the product rules, only the subset the reviewer speaks in —
 * plus the `any`-leak rules, which are the same defect spelled differently.
 *
 * The CSS half of the review (unsupported browser features, `:has`) has no local
 * equivalent; that pass needs the reviewer's own browser data. Keep the
 * declarations those rules dislike out of `styles/` instead: `gap` rather than
 * `column-gap`, no `display: contents`, no `:has()`.
 */
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";
import tsparser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";

export default [
    {
        ignores: [
            "dist/", "node_modules/", "main.js", "styles.css",
            "esbuild.config.mjs", "version-bump.mjs", "install.js",
            "scripts/", "test/", ".test-build/", "live-test-vault/", "media/",
            ".eslintrc.js", "eslint.config.mjs", "eslint.review.config.mjs",
        ],
    },
    {
        files: ["**/*.ts"],
        plugins: {
            obsidianmd: obsidianmd,
            "@typescript-eslint": tseslint,
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
            // What the review's "Source code" section reports.
            "@typescript-eslint/no-unsafe-enum-comparison": "warn",
            "@typescript-eslint/no-unsafe-assignment": "warn",
            "@typescript-eslint/no-unsafe-return": "warn",
            "@typescript-eslint/no-unnecessary-type-assertion": "warn",
            "@typescript-eslint/unbound-method": "warn",
            "obsidianmd/no-global-this": "warn",
        },
    },
];
