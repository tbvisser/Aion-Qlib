/**
 * Deliberately small: `tsc --noEmit` (strict, noUnusedLocals) already owns
 * type errors and unused code, so this config carries only what the compiler
 * cannot see — the React hooks contract. The `eslint-disable` comments that
 * predate this file used to suppress nothing; now they are real.
 *
 * `exhaustive-deps` is a warning, not an error: several effects in the
 * builders omit dependencies deliberately (seed-once, revision-gated) and say
 * so with a disable comment. A warning keeps the signal without failing the
 * build on a pattern the codebase argues for in prose.
 */
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
)
