import { describe, expect, test } from 'bun:test';
import type { Membrane } from '@animalabs/membrane';
import { validateRecipe } from '../src/recipe.js';
import { buildRetrievalModuleConfig } from '../src/retrieval-config.js';

const membrane = {} as Membrane;

function recipe(retrieval: unknown, provider: string = 'openai-codex') {
  return {
    name: 'retrieval-config-test',
    agent: { systemPrompt: 'sys', provider },
    modules: { retrieval },
  };
}

describe('retrieval recipe config', () => {
  test('accepts and maps provider reasoning settings', () => {
    const parsed = validateRecipe(recipe({
      model: 'test-model',
      maxInjected: 7,
      reasoningEffort: 'minimal',
    }));

    expect(parsed.modules?.retrieval).toEqual({
      model: 'test-model',
      maxInjected: 7,
      reasoningEffort: 'minimal',
    });
    expect(buildRetrievalModuleConfig(membrane, parsed.modules!.retrieval!, 'openai-codex')).toEqual({
      membrane,
      retrievalModel: 'test-model',
      maxInjectedLessons: 7,
      retrievalReasoning: { effort: 'minimal' },
    });
  });

  test('preserves boolean shorthand and omits unconfigured reasoning', () => {
    expect(validateRecipe(recipe(true)).modules?.retrieval).toBe(true);
    expect(validateRecipe(recipe(false)).modules?.retrieval).toBe(false);
    expect(buildRetrievalModuleConfig(membrane, { model: 'test-model' }, 'anthropic')).toEqual({
      membrane,
      retrievalModel: 'test-model',
    });
  });

  test('rejects malformed retrieval reasoning settings', () => {
    expect(() => validateRecipe(recipe(null))).toThrow(/modules\.retrieval must be a boolean or object/);
    expect(() => validateRecipe(recipe([]))).toThrow(/modules\.retrieval must be a boolean or object/);
    expect(() => validateRecipe(recipe({ reasoningEffort: 'ultra' }))).toThrow(/reasoningEffort/);
    expect(() => validateRecipe(recipe({ reasoningEffort: ['high'] }))).toThrow(/reasoningEffort/);
    expect(() => validateRecipe(recipe({ reasoningContext: 'current_turn' }))).toThrow(
      /independent one-shot requests/,
    );
    expect(() => validateRecipe(recipe({ reasoningEffort: 'high' }, 'anthropic'))).toThrow(
      /requires agent\.provider/,
    );
    expect(() => buildRetrievalModuleConfig(
      membrane,
      { reasoningEffort: 'high' },
      'anthropic',
    )).toThrow(/requires agent\.provider/);
    expect(() => validateRecipe(recipe({ reasoningEffort: 'high' }))).toThrow(
      /model must be a non-empty string/,
    );
    expect(() => validateRecipe(recipe({ model: '  ', reasoningEffort: 'high' }))).toThrow(
      /model must be a non-empty string/,
    );
    expect(() => buildRetrievalModuleConfig(
      membrane,
      { reasoningEffort: 'high' },
      'openai-codex',
    )).toThrow(/model must be a non-empty string/);
  });
});
