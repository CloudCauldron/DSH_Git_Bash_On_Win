import { resolve } from 'node:path';
import js from '@eslint/js';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  includeIgnoreFile(resolve(import.meta.dirname, '.gitignore')),
  { files: ['eslint.config.mjs'], extends: [js.configs.recommended] },
  {
    files: ['{src,test,poc,scripts}/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Native FFI and dynamically loaded DSH APIs have opaque boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['test/**/*.ts'],
    // Test doubles capture their instances for lifecycle assertions.
    rules: { '@typescript-eslint/no-this-alias': 'off' },
  },
);
