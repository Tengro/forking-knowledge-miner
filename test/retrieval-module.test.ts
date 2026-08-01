import { describe, expect, test } from 'bun:test';
import type { Membrane, NormalizedRequest } from '@animalabs/membrane';
import { RetrievalModule } from '../src/modules/retrieval-module.js';
import { buildRetrievalModuleConfig } from '../src/retrieval-config.js';
import type { Lesson } from '../src/modules/lessons-module.js';

function lesson(id: string, content: string): Lesson {
  return {
    id,
    content,
    confidence: 0.9,
    tags: ['memory'],
    evidence: [],
    created: 1,
    updated: 1,
    deprecated: false,
  };
}

function harness(responses: Array<string | Error>, lessons: Lesson[]) {
  const calls: NormalizedRequest[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      calls.push(structuredClone(request));
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error('unexpected retrieval call');
      return { content: [{ type: 'text', text: next }] };
    },
  } as unknown as Membrane;

  const installContext = (mod: RetrievalModule) => {
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => lessons } : null,
      queryMessages: () => ({
        messages: [{
          participant: 'user',
          content: [{ type: 'text', text: 'Please recall the relevant memory context.' }],
        }],
        totalCount: 1,
      }),
    };
  };

  return { calls, membrane, installContext };
}

describe('RetrievalModule provider-specific reasoning', () => {
  test('passes configured reasoning to concept extraction and relevance validation', async () => {
    const lessons = [1, 2, 3, 4].map(n => lesson(`l${n}`, `memory detail ${n}`));
    const h = harness(['["memory"]', '["l1", "l3"]'], lessons);
    const mod = new RetrievalModule(buildRetrievalModuleConfig(h.membrane, {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
    }, 'openai-codex'));
    h.installContext(mod);

    const injections = await mod.gatherContext('sol');

    expect(h.calls).toHaveLength(2);
    for (const request of h.calls) {
      expect(request.config.model).toBe('gpt-5.6-sol');
      expect(request.providerParams).toEqual({
        reasoning: { effort: 'xhigh' },
      });
    }
    const text = (injections[0].content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('memory detail 1');
    expect(text).toContain('memory detail 3');
    expect(text).not.toContain('memory detail 2');
  });

  test('omits providerParams when retrieval reasoning is not configured', async () => {
    const h = harness(['[]'], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane, retrievalModel: 'gpt-5.4-mini' });
    h.installContext(mod);

    expect(await mod.gatherContext('sol')).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].providerParams).toBeUndefined();
  });

  test('skips relevance validation for three or fewer candidates and caches non-empty results', async () => {
    const h = harness(['["memory"]'], [lesson('l1', 'memory alpha'), lesson('l2', 'memory beta')]);
    const mod = new RetrievalModule({
      membrane: h.membrane,
      retrievalModel: 'gpt-5.6-sol',
      retrievalReasoning: { effort: 'xhigh' },
    });
    h.installContext(mod);

    const first = await mod.gatherContext('sol');
    const second = await mod.gatherContext('sol');

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].providerParams).toEqual({ reasoning: { effort: 'xhigh' } });
  });

  test('fails open when the concept extraction provider call fails', async () => {
    const h = harness([new Error('provider unavailable')], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({
      membrane: h.membrane,
      retrievalModel: 'gpt-5.6-sol',
      retrievalReasoning: { effort: 'xhigh' },
    });
    h.installContext(mod);

    expect(await mod.gatherContext('sol')).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });
});
