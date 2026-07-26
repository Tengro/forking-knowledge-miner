/**
 * DryContext — the context a hypothetical settings change WOULD produce,
 * rendered in the main pane.
 *
 * Distinct from `ContextDocument`, which shows the agent's live context. This
 * one shows the output of a dry run: nothing here has been applied, and the
 * agent is still running the settings shown in the sidebar. The banner says so,
 * because a rendered context that looks exactly like the real thing is a good
 * way for an operator to lose track of which is which.
 *
 * Entries come straight from context-manager's dry-run select, so this is the
 * actual layout that budget would produce — not an approximation.
 */

import { createSignal, For, Show } from 'solid-js';

interface Seg { messages: number; tokens: number }
interface DryStats {
  head: Seg; tail: Seg; middleRaw: Seg;
  summaries?: Record<string, { count: number; tokens: number }>;
  total: Seg;
}

export interface DryContextData {
  entries: unknown[];
  stats?: unknown;
  label: string;
}

const fmt = (n: number) => n.toLocaleString();

function textOf(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!b || typeof b !== 'object') return String(b ?? '');
        const t = (b as { type?: string }).type;
        if (t === 'text') return (b as { text?: string }).text ?? '';
        if (t === 'image') return '[image]';
        if (t === 'thinking' || t === 'redacted_thinking') return '[thinking]';
        if (t === 'tool_use') return `[tool_use ${(b as { name?: string }).name ?? ''}]`;
        if (t === 'tool_result') return '[tool_result]';
        return '';
      })
      .join('');
  }
  return String(content ?? '');
}

/** Recall pairs render as a CM prompt followed by the summary text. */
const RECALL_MARKERS = ['what do you remember', 'recall memory', '[cm]'];
const isRecallPrompt = (s: string) =>
  s.length < 400 && RECALL_MARKERS.some((m) => s.toLowerCase().includes(m));

export function DryContext(props: { data: DryContextData | null; onClose(): void }) {
  const [expanded, setExpanded] = createSignal<Set<number>>(new Set());
  const toggle = (i: number) => {
    const next = new Set(expanded());
    next.has(i) ? next.delete(i) : next.add(i);
    setExpanded(next);
  };

  const rows = () =>
    (props.data?.entries ?? []).map((e, i) => {
      const o = (e ?? {}) as { participant?: string; role?: string; content?: unknown };
      const body = textOf(o.content);
      return {
        i,
        who: o.participant ?? o.role ?? '?',
        body,
        recall: isRecallPrompt(body),
        chars: body.length,
      };
    });

  const stats = () => props.data?.stats as DryStats | undefined;

  return (
    <div class="h-full overflow-y-auto">
      <Show
        when={props.data}
        fallback={
          <div class="p-6 text-neutral-500 text-sm">
            No dry run yet. Open <span class="font-mono text-neutral-400">Settings</span> in the
            sidebar, set a budget, and press{' '}
            <span class="font-mono text-cyan-300">dry run + show context</span>.
          </div>
        }
      >
        {/* Unmissable: this is NOT the live context. */}
        <div class="sticky top-0 z-10 bg-amber-950/80 backdrop-blur border-b border-amber-800
                    px-4 py-2 text-[11px] text-amber-200 flex items-center gap-3 flex-wrap">
          <span class="font-semibold uppercase tracking-wider">dry run — not applied</span>
          <span class="font-mono text-amber-300/90">{props.data!.label}</span>
          <span class="text-amber-300/70">
            the agent is still running its current settings
          </span>
          <button
            type="button"
            class="ml-auto px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700
                   text-neutral-300 font-mono text-[10px]"
            onClick={() => props.onClose()}
          >
            close
          </button>
        </div>

        <Show when={stats()}>
          <div class="px-4 py-2 border-b border-neutral-800 text-[11px] font-mono
                      text-neutral-400 flex gap-4 flex-wrap">
            <span>entries <span class="text-neutral-200">{fmt(rows().length)}</span></span>
            <span>head <span class="text-neutral-200">{fmt(stats()!.head?.tokens ?? 0)}</span></span>
            <span>middle <span class="text-neutral-200">{fmt(stats()!.middleRaw?.tokens ?? 0)}</span></span>
            <span>tail <span class="text-neutral-200">{fmt(stats()!.tail?.tokens ?? 0)}</span></span>
            <span>total <span class="text-neutral-200">{fmt(stats()!.total?.tokens ?? 0)}</span></span>
          </div>
        </Show>

        <div class="px-4 py-3 space-y-2">
          <For each={rows()}>
            {(r) => (
              <div
                class={`rounded border px-2.5 py-1.5 ${
                  r.recall
                    ? 'border-orange-900/60 bg-orange-950/20'
                    : 'border-neutral-800 bg-neutral-900/40'
                }`}
              >
                <div class="flex items-baseline gap-2 mb-0.5">
                  <span class="text-[10px] font-mono text-neutral-500">#{r.i}</span>
                  <span
                    class={`text-[11px] font-mono ${
                      r.recall ? 'text-orange-300' : 'text-cyan-300'
                    }`}
                  >
                    {r.who}
                  </span>
                  <span class="text-[10px] text-neutral-600">{fmt(r.chars)} chars</span>
                  <Show when={r.chars > 600}>
                    <button
                      type="button"
                      class="ml-auto text-[10px] font-mono text-neutral-500 hover:text-neutral-300"
                      onClick={() => toggle(r.i)}
                    >
                      {expanded().has(r.i) ? 'collapse' : 'expand'}
                    </button>
                  </Show>
                </div>
                <div
                  class="text-[12px] text-neutral-300 whitespace-pre-wrap break-words leading-relaxed"
                >
                  {expanded().has(r.i) || r.chars <= 600
                    ? r.body
                    : r.body.slice(0, 600) + ' …'}
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
