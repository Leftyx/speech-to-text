import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // resample-16k.js is plain JavaScript that no TypeScript project includes,
  // so the type-aware rules cannot read it.
  globalIgnores(['dist', 'assets', 'work', 'site', 'web', 'node_modules', '.wrangler', 'resample-16k.js']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Numbers in template strings are fine: every one here is a count or a size.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // `declare var` is the only way to declare a property of the global object.
    files: ['**/*.d.ts'],
    rules: { 'no-var': 'off' },
  },
);
