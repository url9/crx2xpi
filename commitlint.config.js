// Conventional Commits are mandatory. Allowed types mirror CONTRIBUTING.md;
// the initial repository commit ("Initial commit") predates this configuration
// and is intentionally left untouched.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'refactor',
        'test',
        'chore',
        'build',
        'ci',
        'perf',
        'style',
        'revert',
      ],
    ],
    'header-max-length': [2, 'always', 100],
    'subject-case': [0, 'always'],
  },
};
