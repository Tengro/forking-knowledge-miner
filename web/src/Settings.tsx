/**
 * Context settings panel — live control of the agent's compile window.
 *
 * Replaces the stop → edit the `framework/state` Chronicle slot → start dance.
 * Three things this panel is deliberately honest about, because getting any of
 * them wrong would mislead an operator into an outage:
 *
 *  1. RAISING the budget applies at once; LOWERING starts a PACED convergence
 *     that can sit in `converging` for many turns, and can be cancelled. Apply
 *     is not "done" the moment it returns.
 *  2. Only a few keys are hot. Chunk size, head window, merge threshold and
 *     friends are recipe-and-restart-only — shown, but not offered as controls.
 *  3. Preview requires a context-manager build with dry-run support. When the
 *     resolved build lacks it we say so, rather than rendering an empty result
 *     that looks like "nothing would change".
 */

import { createSignal, Show, For, onCleanup } from 'solid-js';

export interface SettingsSnapshot {
  contextBudgetTokens: number;
  tailTokens?: number;
  transitionPaceTokens?: number;
  sameRoundThinkTextPolicy?: string;
  sameRoundThinkTextPolicySource?: string;
  transition: 'stable' | 'converging' | 'blocked';
  transitionReason?: string;
}

export interface SettingsState {
  agent: string;
  settings: SettingsSnapshot;
  overrides: string[];
  hotKeys: string[];
  hotConfigurable: boolean;
  previewAvailable: boolean;
}

/**
 * Honest budget accounting from the server.
 *
 * `preview.fits` from context-manager means "would not throw OverBudgetError",
 * which on a recipe with a grace ratio is NOT the same as "fits the budget you
 * typed". These three flags keep the questions separate.
 */
interface PreviewAccounting {
  requestedBudgetTokens: number;
  reserveForResponseTokens: number;
  effectiveBudgetTokens: number;
  rejectionBudgetTokens?: number;
  fitsRequested: boolean;
  withinGrace?: boolean;
  /** Picker exhausted AND still over the request — this budget cannot be reached. */
  unreachable: boolean;
}

interface PreviewResult {
  finalTokens: number;
  budgetTokens: number;
  fits: boolean;
  exhausted: boolean;
  headTokens: number;
  tailTokens: number;
  middleTokens: number;
  middleChunkCount: number;
  deepestLevel: number;
  resolutions: Record<string, number>;
  appliedCount: number;
  producedCount: number;
}

/** Settings the strategy reads only at construction — surfaced so an operator
 *  can see them without being invited to "change" them from here. */
const RESTART_ONLY = [
  'targetChunkTokens',
  'headWindowTokens',
  'mergeThreshold',
  'foldingStrategy',
  'maxSpeculativeL1s',
  'adaptiveResolution',
  'compressionSlackRatio',
];

const TRANSITION_HELP: Record<string, string> = {
  transition_pace_too_small:
    'the per-turn pace is below the floor — raise transitionPaceTokens or the descent cannot progress',
  protected_context_exceeds_target:
    'head + tail alone exceed the target — the verbatim window must shrink before this budget is reachable',
};

export function SettingsPanel(props: {
  loaded: boolean;
  state: SettingsState | null;
  onRefresh(): void;
  onApply(patch: {
    contextBudgetTokens?: number;
    tailTokens?: number;
    transitionPaceTokens?: number;
    persist: boolean;
    notify: boolean;
  }): void;
  onReset(keys: string[] | undefined, persist: boolean): void;
  onCancelTransition(): void;
}) {
  const [budget, setBudget] = createSignal<string>('');
  const [tail, setTail] = createSignal<string>('');
  const [pace, setPace] = createSignal<string>('');
  const [persist, setPersist] = createSignal(true);
  const [notify, setNotify] = createSignal(false);

  const [preview, setPreview] = createSignal<PreviewResult | null>(null);
  const [acct, setAcct] = createSignal<PreviewAccounting | null>(null);
  const [previewErr, setPreviewErr] = createSignal<string | null>(null);
  const [previewing, setPreviewing] = createSignal(false);

  let debounce: number | undefined;
  onCleanup(() => { if (debounce) window.clearTimeout(debounce); });

  const s = () => props.state?.settings;
  const isHot = (k: string) => props.state?.hotKeys.includes(k) ?? false;

  /** Prefill the inputs from live values so the operator edits from reality. */
  const syncFromLive = () => {
    const cur = s();
    if (!cur) return;
    setBudget(String(cur.contextBudgetTokens));
    setTail(cur.tailTokens !== undefined ? String(cur.tailTokens) : '');
    setPace(cur.transitionPaceTokens !== undefined ? String(cur.transitionPaceTokens) : '');
  };

  const num = (v: string): number | undefined => {
    if (v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };

  /** Debounced: an operator dragging a value should not fire a compile per keystroke.
   *  The request itself is non-committing, but it is still real CPU on a live agent. */
  const runPreview = () => {
    if (!props.state?.previewAvailable) return;
    const b = num(budget());
    if (b === undefined) { setPreview(null); setPreviewErr(null); return; }
    if (debounce) window.clearTimeout(debounce);
    debounce = window.setTimeout(async () => {
      setPreviewing(true);
      setPreviewErr(null);
      try {
        const qs = new URLSearchParams({ budget: String(b), agent: props.state!.agent });
        const t = num(tail());
        if (t !== undefined) qs.set('tail', String(t));
        const res = await fetch(`/debug/context/preview?${qs}`, { credentials: 'same-origin' });
        const body = await res.json();
        if (!res.ok) {
          setPreview(null);
          setAcct(null);
          setPreviewErr(body?.error ?? `HTTP ${res.status}`);
          return;
        }
        setPreview(body.preview as PreviewResult);
        setAcct((body.accounting ?? null) as PreviewAccounting | null);
      } catch (e) {
        setPreview(null);
        setAcct(null);
        setPreviewErr(e instanceof Error ? e.message : String(e));
      } finally {
        setPreviewing(false);
      }
    }, 350) as unknown as number;
  };

  const apply = () => {
    const patch: Record<string, number> = {};
    const b = num(budget());
    const t = num(tail());
    const p = num(pace());
    const cur = s();
    if (b !== undefined && b !== cur?.contextBudgetTokens) patch.contextBudgetTokens = b;
    if (t !== undefined && t !== cur?.tailTokens) patch.tailTokens = t;
    if (p !== undefined && p !== cur?.transitionPaceTokens) patch.transitionPaceTokens = p;
    if (Object.keys(patch).length === 0) return;
    props.onApply({ ...patch, persist: persist(), notify: notify() });
  };

  const lowering = () => {
    const b = num(budget());
    const cur = s();
    return b !== undefined && cur !== undefined && b < cur.contextBudgetTokens;
  };

  const dirty = () => {
    const cur = s();
    if (!cur) return false;
    const b = num(budget()), t = num(tail()), p = num(pace());
    return (b !== undefined && b !== cur.contextBudgetTokens)
      || (t !== undefined && t !== cur.tailTokens)
      || (p !== undefined && p !== cur.transitionPaceTokens);
  };

  return (
    <div class="h-full overflow-y-auto px-3 py-2 text-xs">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold">
          context settings
        </span>
        <Show when={props.state}>
          <span class="text-neutral-600 text-[10px] font-mono">{props.state!.agent}</span>
        </Show>
        <button
          type="button"
          class="ml-auto px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
          onClick={() => { props.onRefresh(); setTimeout(syncFromLive, 150); }}
        >
          refresh
        </button>
      </div>

      <Show when={!props.loaded}>
        <div class="text-neutral-600 italic">Loading…</div>
      </Show>

      <Show when={props.loaded && !props.state}>
        <div class="text-amber-400/80">Runtime settings unavailable on this build.</div>
      </Show>

      <Show when={props.state}>
        {/* ---- transition status: the thing an operator most needs to see ---- */}
        <Show when={s()!.transition !== 'stable'}>
          <div
            class={`mb-2 px-2 py-1.5 rounded border text-[11px] ${
              s()!.transition === 'blocked'
                ? 'bg-red-950/40 border-red-800 text-red-300'
                : 'bg-amber-950/40 border-amber-800 text-amber-200'
            }`}
          >
            <div class="font-semibold">
              {s()!.transition === 'blocked' ? 'descent BLOCKED' : 'descent converging'}
            </div>
            <Show when={s()!.transitionReason}>
              <div class="mt-0.5 text-[10px] opacity-90">
                {TRANSITION_HELP[s()!.transitionReason!] ?? s()!.transitionReason}
              </div>
            </Show>
            <button
              type="button"
              class="mt-1 px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded font-mono"
              onClick={() => props.onCancelTransition()}
            >
              cancel transition (hold current frontier)
            </button>
          </div>
        </Show>

        <Show when={!props.state!.hotConfigurable}>
          <div class="mb-2 px-2 py-1 rounded bg-neutral-900 border border-neutral-800 text-[10px] text-neutral-400">
            This strategy is not hot-configurable — only the budget can be changed live.
          </div>
        </Show>

        {/* ---- live values ---- */}
        <table class="w-full mb-3 font-mono text-[11px]">
          <tbody>
            <For each={[
              ['contextBudgetTokens', s()!.contextBudgetTokens],
              ['tailTokens', s()!.tailTokens],
              ['transitionPaceTokens', s()!.transitionPaceTokens],
              ['sameRoundThinkTextPolicy', s()!.sameRoundThinkTextPolicy],
            ] as Array<[string, unknown]>}>
              {([k, v]) => (
                <tr>
                  <td class="text-neutral-500 pr-2">{k}</td>
                  <td class="text-neutral-200 text-right tabular-nums">
                    {v === undefined ? '–' : String(v)}
                  </td>
                  <td class="pl-2 w-16">
                    <Show when={props.state!.overrides.includes(k)}>
                      <span class="text-[9px] px-1 rounded bg-cyan-900/50 text-cyan-300">override</span>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>

        {/* ---- editors ---- */}
        <div class="space-y-1.5 mb-2">
          <For each={[
            ['budget', 'contextBudgetTokens', budget, setBudget] as const,
            ['tail', 'tailTokens', tail, setTail] as const,
            ['pace', 'transitionPaceTokens', pace, setPace] as const,
          ]}>
            {([label, key, get, set]) => (
              <label class="flex items-center gap-2">
                <span class="text-neutral-500 w-12">{label}</span>
                <input
                  type="number"
                  disabled={!isHot(key)}
                  value={get()}
                  placeholder={isHot(key) ? 'tokens' : 'restart only'}
                  onInput={(e) => { set(e.currentTarget.value); runPreview(); }}
                  class="flex-1 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5
                         font-mono text-[11px] text-neutral-100 disabled:opacity-40"
                />
              </label>
            )}
          </For>
        </div>

        <div class="flex items-center gap-3 mb-2 text-[10px] text-neutral-400">
          <label class="flex items-center gap-1">
            <input type="checkbox" checked={persist()} onChange={(e) => setPersist(e.currentTarget.checked)} />
            persist
          </label>
          <label class="flex items-center gap-1" title="Injects a notice into the agent's context. This perturbs the very context being tuned — it invalidates the KV prefix and is classifier-visible. The agent can always read settings itself via agent_settings.">
            <input type="checkbox" checked={notify()} onChange={(e) => setNotify(e.currentTarget.checked)} />
            notify agent
          </label>
        </div>
        <div class="text-[10px] text-neutral-600 mb-2 leading-relaxed">
          <Show when={!persist()}>
            <div>ephemeral — live now, reverts on restart.</div>
          </Show>
          <Show when={lowering()}>
            <div class="text-amber-500/90">
              lowering the budget converges gradually, not instantly — it will report
              <span class="font-mono"> converging</span> until it settles.
            </div>
          </Show>
        </div>

        <div class="flex items-center gap-2 mb-3">
          <button
            type="button"
            disabled={!dirty()}
            class="px-2 py-0.5 text-[10px] rounded font-mono bg-cyan-900/50 hover:bg-cyan-900/70
                   text-cyan-200 disabled:opacity-30 disabled:hover:bg-cyan-900/50"
            onClick={apply}
          >
            apply
          </button>
          <button
            type="button"
            class="px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
            onClick={() => { props.onReset(undefined, persist()); setTimeout(syncFromLive, 200); }}
          >
            reset to recipe
          </button>
          <button
            type="button"
            class="px-2 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
            onClick={syncFromLive}
          >
            revert edits
          </button>
        </div>

        {/* ---- preview ---- */}
        <div class="border-t border-neutral-800 pt-2">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold">
              preview
            </span>
            <Show when={previewing()}>
              <span class="text-neutral-600 text-[10px]">computing…</span>
            </Show>
          </div>

          <Show when={!props.state!.previewAvailable}>
            <div class="text-[10px] text-neutral-500 leading-relaxed">
              Preview unavailable on this build — the resolved context-manager has no
              dry-run support. Apply still works; you just won't see the plan first.
            </div>
          </Show>

          <Show when={props.state!.previewAvailable && previewErr()}>
            <div class="text-[10px] text-amber-400/90">{previewErr()}</div>
          </Show>

          <Show when={preview()}>
            {(p) => (
              <div>
                {/* Three distinct verdicts. Collapsing "fits your budget" into
                    "wouldn't throw" is how a 35%-grace recipe reports an
                    unreachable budget as fine — so they are kept apart. */}
                <div
                  class={`px-2 py-1 rounded mb-1.5 text-[11px] border ${
                    acct()?.fitsRequested
                      ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
                      : acct()?.withinGrace
                        ? 'bg-amber-950/40 border-amber-800 text-amber-200'
                        : 'bg-red-950/40 border-red-800 text-red-300'
                  }`}
                >
                  <Show when={acct()?.fitsRequested}>
                    <div>
                      fits — {p().finalTokens.toLocaleString()} of{' '}
                      {acct()!.effectiveBudgetTokens.toLocaleString()} usable tok
                    </div>
                  </Show>
                  <Show when={!acct()?.fitsRequested && acct()?.withinGrace}>
                    <div>
                      OVER REQUESTED BUDGET — {p().finalTokens.toLocaleString()} tok vs{' '}
                      {acct()!.effectiveBudgetTokens.toLocaleString()} usable
                    </div>
                    <div class="text-[10px] opacity-90 mt-0.5">
                      it would not hard-fail, but only because the grace margin absorbs the
                      overshoot (ceiling {acct()!.rejectionBudgetTokens?.toLocaleString()}).
                      The context would run above your target indefinitely.
                    </div>
                  </Show>
                  <Show when={acct() && !acct()!.fitsRequested && acct()!.withinGrace === false}>
                    <div>
                      WOULD HARD-FAIL — {p().finalTokens.toLocaleString()} tok exceeds even the
                      grace ceiling {acct()!.rejectionBudgetTokens?.toLocaleString()}
                    </div>
                  </Show>
                  <Show when={acct()?.unreachable}>
                    <div class="text-[10px] opacity-90 mt-0.5">
                      <b>unreachable:</b> the picker exhausted — nothing further can be folded,
                      so this budget cannot be reached no matter how long you wait.
                    </div>
                  </Show>
                </div>

                <table class="w-full font-mono text-[10px]">
                  <tbody>
                    <For each={[
                      ['requested budget', acct()?.requestedBudgetTokens],
                      ['− reserve for response', acct()?.reserveForResponseTokens],
                      ['= usable for context', acct()?.effectiveBudgetTokens],
                      ['grace ceiling (hard fail above)', acct()?.rejectionBudgetTokens],
                      ['head (verbatim)', p().headTokens],
                      ['tail (verbatim)', p().tailTokens],
                      ['middle (foldable)', p().middleTokens],
                      ['middle chunks', p().middleChunkCount],
                      ['deepest fold level', `L${p().deepestLevel}`],
                      ['folds applied', p().appliedCount],
                    ] as Array<[string, unknown]>}>
                      {([k, v]) => (
                        <tr>
                          <td class="text-neutral-500 pr-2">{k}</td>
                          <td class="text-neutral-300 text-right tabular-nums">
                            {typeof v === 'number'
                              ? v.toLocaleString()
                              : v === undefined || v === null
                                ? '–'
                                : String(v)}
                          </td>
                        </tr>
                      )}
                    </For>
                    <tr>
                      <td class="text-neutral-500 pr-2">summaries to produce</td>
                      <td
                        class={`text-right tabular-nums ${
                          p().producedCount > 0 ? 'text-amber-400' : 'text-neutral-300'
                        }`}
                      >
                        {p().producedCount}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <Show when={p().producedCount > 0}>
                  <div class="text-[10px] text-amber-500/80 mt-1 leading-relaxed">
                    {p().producedCount} summar{p().producedCount === 1 ? 'y' : 'ies'} do not exist
                    yet — reaching this layout costs that many compression calls first.
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </div>

        {/* ---- restart-only knobs, shown but not offered ---- */}
        <div class="border-t border-neutral-800 mt-3 pt-2">
          <div class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold mb-1">
            restart only
          </div>
          <div class="text-[10px] text-neutral-600 leading-relaxed">
            These come from the recipe and are read at construction — changing them needs a
            restart, not this panel:
            <span class="font-mono text-neutral-500"> {RESTART_ONLY.join(', ')}</span>
          </div>
        </div>
      </Show>
    </div>
  );
}
