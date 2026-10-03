import test from 'node:test';
import assert from 'node:assert/strict';
import { Envs } from './envs.js';

test('AI prompt defaults for empty values while preserving custom raw text and other empty settings', () => {
  const previous = { env: Envs.env, systemEnvBackup: Envs.systemEnvBackup, rawEnvValues: Envs.rawEnvValues };
  const previousPrompt = process.env.AI_MATCH_PROMPT;
  delete process.env.AI_MATCH_PROMPT;
  try {
    for (const value of [undefined, '', ' \t\n ']) {
      for (const source of ['raw', 'system', 'worker']) {
        Envs.systemEnvBackup = source === 'worker' ? null : {};
        Envs.rawEnvValues = { BLOCKED_WORDS: '' };
        const env = {};
        if (value !== undefined) {
          (source === 'raw' ? Envs.rawEnvValues : source === 'system' ? Envs.systemEnvBackup : env).AI_MATCH_PROMPT = value;
        }
        assert.equal(Envs.load(env).aiMatchPrompt, Envs.DEFAULT_AI_MATCH_PROMPT, `${source}: ${JSON.stringify(value)}`);
      }
    }
    const custom = '  # custom prompt\nKeep this text intact.  ';
    Envs.systemEnvBackup = {};
    Envs.rawEnvValues = { AI_MATCH_PROMPT: custom, BLOCKED_WORDS: '' };
    assert.equal(Envs.load().aiMatchPrompt, custom);
    assert.equal(Envs.get('BLOCKED_WORDS', 'fallback'), '');
    Envs.systemEnvBackup = { AI_MATCH_PROMPT: 'system override' };
    assert.equal(Envs.load().aiMatchPrompt, 'system override');
  } finally {
    Object.assign(Envs, previous);
    if (previousPrompt === undefined) delete process.env.AI_MATCH_PROMPT;
    else process.env.AI_MATCH_PROMPT = previousPrompt;
  }
});
