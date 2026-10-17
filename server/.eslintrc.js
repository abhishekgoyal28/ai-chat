module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { project: 'tsconfig.json', tsconfigRootDir: __dirname, sourceType: 'module' },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: ['plugin:@typescript-eslint/recommended'],
  root: true,
  env: { node: true, jest: true },
  ignorePatterns: ['.eslintrc.js', 'dist', 'jest*.config.js'],
  rules: {
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['**/chat-app/**', '**/chat-expert/**'],
            message: 'chat-socket and shared code must not import another service.',
          },
        ],
      },
    ],
  },
  overrides: [
    { files: ['src/chat-app/**/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: ['**/chat-socket/**', '**/chat-expert/**'] }] } },
    { files: ['src/chat-expert/**/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: ['**/chat-socket/**', '**/chat-app/**'] }] } },
    { files: ['src/chat-socket/**/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: ['**/chat-app/**', '**/chat-expert/**', '**/shared/database/**'] }] } },
  ],
};
