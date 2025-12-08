module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    plugins: ['@typescript-eslint'],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:obsidianmd/recommended',
    ],
    rules: {
        '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/ban-ts-comment': 'off',
        '@typescript-eslint/no-empty-function': 'off',
        'no-unused-vars': 'off',
        'no-prototype-builtins': 'off',
        '@typescript-eslint/ban-types': 'off'
    },
    env: {
        node: true,
        browser: true,
        es6: true
    }
};
