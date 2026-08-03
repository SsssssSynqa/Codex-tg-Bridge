// Regression tests for redactSensitiveText.
//
// Run these after ANY change to redact.mjs. Every case asserts two things:
// the placeholder appears, AND the original secret fragment is completely
// gone. Partial masking that leaves a recognisable tail is still a leak.

import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveText } from '../src/redact.mjs';

// [input, expectedMarker, fragmentThatMustBeGone]
//   expectedMarker: null means the input must pass through unchanged.
const cases = [
  [
    'curl https://api.openai.com -H "Authorization: Bearer sk-proj-AbCd1234567890XyZqwerty"',
    /\[openai-anthropic-key-redacted\]/,
    'sk-proj-AbCd1234567890XyZqwerty',
  ],
  [
    'export GITHUB_TOKEN=ghp_AbCd1234567890XyZqwertyAbCd1234',
    /\[github-token-redacted\]/,
    'ghp_AbCd1234567890XyZqwertyAbCd1234',
  ],
  ['github_pat_11ABCDEF1234567890ABCDEF12345', /\[github-pat-redacted\]/, '11ABCDEF1234567890ABCDEF12345'],
  [
    'export ANTHROPIC_API_KEY=sk-ant-api03-AbCd1234567890XyZqwertyAbCd1234XyZ',
    /\[openai-anthropic-key-redacted\]/,
    'sk-ant-api03-AbCd1234567890XyZqwertyAbCd1234XyZ',
  ],
  [
    'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.AbCd1234.XyZqwerty"',
    /Bearer \[token-redacted\]/,
    'eyJhbGciOiJIUzI1NiJ9.AbCd1234.XyZqwerty',
  ],
  ['AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE', /\[aws-access-key-redacted\]/, 'AKIAIOSFODNN7EXAMPLE'],
  [
    'bot12345:AAEhBP9JBcMzKqLpVRxXyZ123456_pdq30AbCd-987',
    /\[telegram-token-redacted\]/,
    'AAEhBP9JBcMzKqLpVRxXyZ123456_pdq30AbCd-987',
  ],
  [
    '12345:AAEhBP9JBcMzKqLpVRxXyZ123456_pdq30AbCd-987',
    /\[telegram-token-redacted\]/,
    'AAEhBP9JBcMzKqLpVRxXyZ123456_pdq30AbCd-987',
  ],

  // Values containing punctuation must not leave a tail behind.
  ['api_key="abcdefghijklmnop1234!@#"', /\[secret-redacted\]/, '!@#'],
  ['password = "MySecretPassword!@"', /\[secret-redacted\]/, '!@'],
  ['secret="abc123456789!@#"', /\[secret-redacted\]/, '!@#'],
  ['token=plain123', /\[secret-redacted\]/, 'plain123'],

  // Quoted values with spaces must be swallowed whole.
  ['password="correct horse battery staple"', /\[secret-redacted\]/, 'horse battery'],
  ["password='correct horse battery staple'", /\[secret-redacted\]/, 'horse battery'],
  ['api_key: "long secret with spaces"', /\[secret-redacted\]/, 'secret with spaces'],
  ["token = 'multi word secret abc'", /\[secret-redacted\]/, 'multi word secret'],

  // A quote of the other kind inside a quoted value must not end the match
  // early — that is exactly what a backreference-based pattern gets wrong.
  ['password=\'correct "horse" battery staple\'', /\[secret-redacted\]/, '"horse"'],
  ['password="correct \'horse\' battery staple"', /\[secret-redacted\]/, "'horse'"],
  ['api_key=\'long secret with "double" quote\'', /\[secret-redacted\]/, '"double"'],

  // Ordinary command text must survive untouched.
  ['ls -la /tmp', null, null],
  ['rm -rf node_modules', null, null],
  ['git push origin main', null, null],
];

test('redactSensitiveText masks secrets without leaving fragments', () => {
  for (const [input, expectedMarker, fragmentMustBeGone] of cases) {
    const output = redactSensitiveText(input);
    if (expectedMarker === null) {
      assert.equal(output, input, `should pass through unchanged: ${input}`);
      continue;
    }
    assert.match(output, expectedMarker, `marker missing for: ${input}`);
    if (fragmentMustBeGone !== null) {
      assert.equal(
        output.includes(fragmentMustBeGone),
        false,
        `secret fragment "${fragmentMustBeGone}" survived in: ${output}`,
      );
    }
  }
});
