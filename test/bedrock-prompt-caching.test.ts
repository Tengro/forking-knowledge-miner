/**
 * Bedrock prompt caching is model-gated, not suppressed transport-wide
 * (issue #35). The transport exists here for legacy ids that left the
 * direct API (Opus 3, 3.5 Sonnet 0620) — those genuinely reject
 * cache_control — but everything from 3.5 Sonnet 1022 up caches normally
 * on Bedrock, and the old blanket promptCaching:false made every modern
 * Bedrock agent re-pay its full context on every call.
 */
import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';
import {
  buildFrameworkAgentConfig,
  bedrockModelSupportsPromptCaching,
} from '../src/framework-agent-config.js';

function recipe(agent: Record<string, unknown> = {}) {
  return { name: 'bedrock-caching-test', agent: { systemPrompt: 'sys', ...agent } };
}

describe('bedrockModelSupportsPromptCaching', () => {
  test('ids without GA caching support are gated off', () => {
    for (const id of [
      'anthropic.claude-3-opus-20240229-v1:0',
      'anthropic.claude-3-sonnet-20240229-v1:0',
      'anthropic.claude-3-haiku-20240307-v1:0',
      'us.anthropic.claude-3-5-sonnet-20240620-v1:0',
      // "3.6" — preview-only on Bedrock, dropped at GA; grandfathered
      // accounts opt back in via recipe promptCaching: true.
      'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
      'anthropic.claude-v2:1',
      'anthropic.claude-instant-v1',
    ]) {
      expect(bedrockModelSupportsPromptCaching(id)).toBe(false);
    }
  });

  test('models with GA Bedrock caching support stay on', () => {
    for (const id of [
      'anthropic.claude-3-5-haiku-20241022-v1:0',
      'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
      'us.anthropic.claude-sonnet-4-20250514-v1:0',
      'claude-sonnet-4-20250514',
      'claude-opus-4-6',
      'bedrock:us.anthropic.claude-opus-4-20250514-v1:0',
    ]) {
      expect(bedrockModelSupportsPromptCaching(id)).toBe(true);
    }
  });
});

describe('bedrock agent config', () => {
  test('GA-supported bedrock model gets caching on, without cacheTtl', () => {
    const parsed = validateRecipe(recipe({ provider: 'bedrock' }));
    const config = buildFrameworkAgentConfig(
      parsed, 'agent', 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', undefined,
    );
    expect(config.promptCaching).toBe(true);
    // Bedrock rejects cache_control.ttl; the recipe default ('1h') must not
    // ride along even though membrane also strips it.
    expect(Object.prototype.hasOwnProperty.call(config, 'cacheTtl')).toBe(false);
  });

  test('legacy bedrock model keeps caching suppressed', () => {
    const parsed = validateRecipe(recipe({ provider: 'bedrock' }));
    const config = buildFrameworkAgentConfig(
      parsed, 'agent', 'us.anthropic.claude-3-5-sonnet-20240620-v1:0', undefined,
    );
    expect(config.promptCaching).toBe(false);
  });

  test('recipe promptCaching overrides the model gate in both directions', () => {
    const forcedOff = buildFrameworkAgentConfig(
      validateRecipe(recipe({ provider: 'bedrock', promptCaching: false })),
      'agent', 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', undefined,
    );
    expect(forcedOff.promptCaching).toBe(false);

    // The grandfathered-preview-account path: 3.6 with explicit opt-in.
    const forcedOn = buildFrameworkAgentConfig(
      validateRecipe(recipe({ provider: 'bedrock', promptCaching: true })),
      'agent', 'us.anthropic.claude-3-5-sonnet-20241022-v2:0', undefined,
    );
    expect(forcedOn.promptCaching).toBe(true);
  });

  test('non-bedrock providers keep prior behavior: caching omitted, cacheTtl forwarded', () => {
    const parsed = validateRecipe(recipe());
    const config = buildFrameworkAgentConfig(parsed, 'agent', 'claude-opus-4-6', undefined);
    expect(Object.prototype.hasOwnProperty.call(config, 'promptCaching')).toBe(false);
    expect(config.cacheTtl).toBe('1h');
  });

  test('recipe promptCaching applies on non-bedrock providers too', () => {
    const parsed = validateRecipe(recipe({ promptCaching: false }));
    const config = buildFrameworkAgentConfig(parsed, 'agent', 'claude-opus-4-6', undefined);
    expect(config.promptCaching).toBe(false);
  });

  test('non-boolean promptCaching is rejected at validation', () => {
    expect(() => validateRecipe(recipe({ promptCaching: 'yes' }))).toThrow(/promptCaching/);
    expect(() => validateRecipe(recipe({ promptCaching: 1 }))).toThrow(/promptCaching/);
  });
});
