// ESLint flat config for GJS / GNOME Shell extension code (ES modules, GJS and Shell globals).
// Rules follow the spirit of GNOME Shell's own lint config and the extensions.gnome.org review guidelines.
import js from '@eslint/js';
import globals from 'globals';

const gjsGlobals = {
    ARGV: 'readonly',
    Debugger: 'readonly',
    GIRepositoryGType: 'readonly',
    globalThis: 'readonly',
    imports: 'readonly',
    Intl: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    window: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
    console: 'readonly',
    setTimeout: 'readonly',
    setInterval: 'readonly',
    clearTimeout: 'readonly',
    clearInterval: 'readonly',
};

// Provided by GNOME Shell to extensions (not to plain GJS scripts).
const shellGlobals = {
    global: 'readonly',
    _: 'readonly',
    C_: 'readonly',
    N_: 'readonly',
    ngettext: 'readonly',
};

export default [
    {ignores: ['node_modules/**', 'dist/**', 'extensions/*/m3e/**', 'tests/bench/reference/**']},
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {...gjsGlobals, ...shellGlobals},
        },
        rules: {
            'array-callback-return': 'error',
            'consistent-return': 'error',
            'eqeqeq': ['error', 'always', {null: 'ignore'}],
            'no-await-in-loop': 'off',
            'no-implicit-globals': 'error',
            'no-restricted-globals': ['error',
                {name: 'print', message: 'Use console.log() / console.error() in extension code.'},
                {name: 'printerr', message: 'Use console.error() in extension code.'}],
            'no-shadow': ['error', {hoist: 'never'}],
            'no-unused-vars': ['error', {args: 'none', varsIgnorePattern: '^_'}],
            'prefer-const': 'error',
            'no-var': 'error',
            'semi': ['error', 'always'],
        },
    },
    {
        // Tests and tools run under plain GJS or Node: print() is the TAP output channel there.
        files: ['tests/**/*.js', 'tools/**/*.js'],
        languageOptions: {globals: {...globals.node}},
        rules: {'no-restricted-globals': 'off'},
    },
    {
        files: ['eslint.config.js'],
        languageOptions: {globals: {...globals.node}},
    },
];
