# Changelog

## Unreleased

## 0.5.2 — 2026-07-26

### Fixed

- **Settings preview reported unreachable budgets as fitting.** context-manager's
  `PreviewResult.budgetTokens` is the *rejection* budget —
  `(requested - reserve) * (1 + overBudgetGraceRatio)` — and its `fits` means
  "would not throw `OverBudgetError`", not "fits the budget you asked for". On
  Mythos (`overBudgetGraceRatio: 0.35`) those differ by a third: previewing
  250k reported `fits: true` at 273,828 tokens, a budget the picker had in fact
  exhausted trying to reach. The endpoint now returns an `accounting` block
  separating `fitsRequested` / `withinGrace` / `unreachable`, and the panel
  renders three distinct verdicts (fits / over-requested-but-graced /
  would-hard-fail) plus the full budget derivation.

## 0.5.1

### Added

- **llm-calls logging for every provider**: `LoggingProviderAdapter`, a
  provider-agnostic decorator over any `ProviderAdapter`, wraps the
  openai-codex, openrouter, and openai-responses transports — which
  previously had NO wire visibility (found post-deploy on Mica: zero
  llm-calls files, requests undiagnosable). Full raw request + response
  summary + usage + timing + error per call, size-guarded against
  pathological payloads. Anthropic/Bedrock keep their purpose-built
  logging classes.

## 0.5.0 — 2026-07-26

### Added

- **Context settings panel** (webui `Settings` tab) — live control of the
  agent's compile window, replacing the stop → edit the `framework/state`
  Chronicle slot → start dance. Edits `contextBudgetTokens`, `tailTokens` and
  `transitionPaceTokens`; Apply / reset-to-recipe / revert-edits, plus cancel
  for an in-flight descent.
  - New client messages `request-settings`, `settings-update`,
    `settings-reset`, `settings-cancel-transition`; new server frame
    `settings-state`. No protocol version bump (additive).
  - `settings-state` is **broadcast** to every welcomed client, unlike
    `mcpl-list` — these are live process values, so two operators must not see
    divergent budgets.
  - Mutations are full-auth only for free: `observerMaySend` denies by default,
    so new message types are never reachable by scoped observers.
  - `persist: false` applies ephemerally (live now, reverts on restart) for
    operator experiments. `notify: true` optionally pushes a notice to the
    agent; **off by default**, because the notice is new text in the very
    context being tuned — it invalidates the KV prefix and is itself
    classifier-visible. The agent can always pull current settings via its own
    `agent_settings` tool instead.
  - The panel is explicit about three things that would otherwise mislead:
    raising the budget applies at once but **lowering starts a paced
    convergence** (shown as `converging` / `blocked`, with the blocked reason
    spelled out); only a few keys are hot, so `targetChunkTokens`,
    `headWindowTokens`, `mergeThreshold`, `foldingStrategy` and friends are
    listed under "restart only" rather than offered as controls; and preview
    requires a context-manager with dry-run support, so an older build reports
    "preview unavailable" instead of rendering an empty result.
- **`GET /debug/context/preview?budget=&tail=[&agent=]`** — non-committing
  preview of the fold plan at a hypothetical window. Persists no fold
  resolutions, enqueues no compression, advances no transition bookkeeping
  (the guarantee lives in context-manager's dry-run select). An infeasible
  budget is reported as `fits: false` with per-component diagnostics rather
  than an error — learning a budget cannot work is the reason to preview
  instead of applying and taking the outage. Returns 501 when the resolved
  context-manager predates dry-run support. Requires the `debug` scope.

### Fixed

- `/debug/context/curve` compiled against `app.recipe.agent.contextBudgetTokens`
  — the **stale recipe** value. Runtime overrides live in the `framework/state`
  Chronicle slot and win over the recipe, so the curve was plotted at the wrong
  budget for any agent whose budget had ever been changed at runtime. Now reads
  the live `getAgentRuntimeSettings`, falling back to the recipe.

## 0.4.0

### Changed

- **context-manager ^0.6.0** — the fatal coverage invariant: a compile
  refuses (`OverBudgetError` / `UncoveredDropError`) rather than shipping a
  context with silently-dropped messages, and recall-pair pricing includes
  reasoning carriers (fixes the permanent compile wedge / silent middle loss
  on carrier-bearing stores). Default `overBudgetGraceRatio` is now 0.02.
- **agent-framework ^0.7.0** — host-side recovery for context refusals: the
  OverBudget drain breaker also kicks for `UncoveredDropError`, and a
  `context-refusal` ops alert fires immediately (fleet-watch) with the
  recovery knobs named. Plus the context-settings preview surface and the
  workspace read cap.

### Added

- `compressionMaxTokens` recipe passthrough — cap compression output for
  models with low output ceilings (2c78936).

## Unreleased

### Fixed

- **TUI bug sweep** (#64): operator-safety and observability fixes.
  - `/quit` confirm no longer treats arbitrary input as consent — only an
    explicit `y`/`yes` (or re-typed `/quit`) kills fleet children, `d`
    detaches, anything else cancels; a typed-through message is restored to
    the input (paste referents intact) instead of discarded. Ctrl+C now goes
    through the same confirmation; a second Ctrl+C force-quits.
  - `/checkpoint` records the message position and `/restore` branches back
    to it (previously restored to the branch head — rolling back nothing);
    repeat restores at the same position are a no-op, and an unreachable
    position degrades to the branch head with an explicit note.
  - Session switch fully resets TUI observability state (tree aggregator,
    stream subscriptions, per-agent caches) — fleet subtrees no longer
    freeze after `/session switch`.
  - Memory: peek logs / transcripts / scrollback capped, and detached
    renderables are `destroy()`ed so their native text buffers are actually
    freed (the fleet view leaked one buffer per line per 500ms repaint).
  - Agent-name resolution is exact (`shortAgentName`, fork `-d{depth}`
    scheme included) instead of substring matching that cross-wired agents
    with prefix-overlapping names; peek tails no longer clip the newest
    lines; fleet-view kill/restart failures are surfaced; per-round context
    size (`ctx:`) and session totals (`Σ`) are separate status segments;
    synesthete summaries moved off the render path and back off 30s after
    a failed call instead of retrying at 2 Hz.
  - Smaller UX: peek works on finished subagents (final runtime shown),
    fork `done` summaries always print a chat line, Esc/Ctrl+B work from
    the fleet view, paste placeholders survive `]` in the pasted text,
    `/help` documents `/find` and `/branchto`, `/clear` with arguments
    clears.

### Docs

- Synced stale documentation with the current build: repos marked public
  (AGENT-ONBOARDING), `forking-knowledge-miner` → `connectome-host`
  naming, webui default port corrected to 7340, DEV-ENVIRONMENT
  branch/version table refreshed (all feature branches merged),
  LOCUS-ROUTING and both root plan docs marked implemented.

### Changed

- **Tool-bloat reduction**: subscription-gc's `set_channel_idle_limit` /
  `list_channel_idle_limits` tools folded into `agent_settings` as the
  `channel_idle_limits` field (per-entry merge; number / `"off"` /
  `"default"`-or-null to clear), following the reasoning-controls
  precedent. The old tool names remain routable (undeclared), so agent
  muscle memory keeps working; agents just no longer carry the two extra
  tool schemas. `get` also reports read-only `channel_idle_default`,
  `channel_idle_counters`, and `channel_idle_pinned`, preserving what
  `list_channel_idle_limits` exposed. Updates are all-or-nothing: a patch
  with any invalid entry applies none of its entries.
- **GC pins split from agent overrides**: ChannelModeModule now holds
  debounced channels open via an internal `pin_channel_idle_limit` verb
  and a separate pins layer, instead of writing an `"off"` override.
  Consequences: a blanket `agent_settings reset` clears only agent-set
  limits — it can no longer silently re-enable auto-close on a channel in
  debounced mode — and a pre-existing agent override now survives a
  debounced→mentions round-trip rather than being reset to default.
  (Pins persisted by earlier builds as `"off"` overrides stay agent-level
  until the next mode change re-asserts them as pins.)

## 0.3.10 — 2026-07-21

### Added

- **Provider transports**: `provider: "bedrock"` for legacy Claude models
  (3.5 Sonnet 0620/1022, Opus 3) surviving on AWS APAC after Anthropic API
  retirement — AWS_* env credentials, model-ID mapping via membrane, prompt
  caching forced off (legacy models reject `cache_control`; verified live).
  `provider: "openai-codex"` (ChatGPT subscription, device-code login,
  `/fast` toggle) and `provider: "openrouter"` formalized with validation.
- **Bedrock wire logging**: `LoggingBedrockAdapter` writes
  `llm-calls.<iso>.jsonl` on the bedrock path — tool names per request,
  stop_reason + block shapes per response, raw request retained on errors.
- **Prefill-era bot migration**: recipe `agent.formatter: "anthropic-xml"`
  (membrane classic prefill) + `agent.prefillUserMessage` scaffold — together
  reproduce a chapterx borg's exact prompting structure inside a resident
  (first used for the Supreme Sonnet isekai, 2026-07-21).

- Contribution policy: `CONTRIBUTING.md` (how changes land, review process,
  AI-attribution convention, changelog rules — binding for PRs and direct
  pushes, humans and AIs alike) and a PR template.
- CI `changelog` check: PRs touching `src/` must also touch `CHANGELOG.md`,
  opt out with the `no-changelog` label. The publish workflow now refuses to
  release a `vX.Y.Z` tag with no matching `## X.Y.Z` changelog section.
- Release mechanics automated: `npm version <level>` cuts `Unreleased` into
  `## X.Y.Z — date` via the `version` hook (`scripts/release-changelog.ts`),
  and on release tags CI creates the GitHub release with that section as
  its notes — independent of the npm publish job, so notes exist for
  github-clone consumers even when a publish fails.
- **Web UI observability catch-up**: `ops:alert` traces render as persistent
  banner rows in the SPA (compression quarantine, refusal streaks,
  inference-exhausted; `<kind>-clear` stands them down); a Health sidebar tab
  polls `/healthz` for per-agent status, failure streaks, refusal stats,
  runtime settings, and quarantine, and reconciles durable-state alerts on
  connect. New protocol frames `request-branches`/`branches-list` back a
  Chronicle branch-lineage panel opened from the header branch chip, with
  checkout via the existing `/checkout` command path (read-only for
  observers; listing rides the `messages` scope). The `/curve` link now
  lives in the Context panel header.
- **TUI modernization**: `p` on an agent inside a fleet child opens an
  honest per-agent peek — the child's event stream filtered by `agentName`,
  covering the child's root agent and its subagents (sub-subagents of the
  parent), with phase/tokens/task header from the tree reducer. `ops:alert`
  traces from the local framework AND from every fleet child surface as red
  chat lines plus a persistent `⚠ N alerts` status-bar segment; all-clears
  stand alerts down. The token line now shows the session cost estimate
  when priced.

### Fixed

- Dead `PlaceholderPanel` removed from the SPA; stale doc pointers
  (`WEBUI-PLAN.md`, knowledge-miner references) corrected; README now
  documents the web UI, headless mode, and current TUI peek semantics.

## 0.3.2 — 2026-07-14

Retro-filed: 0.3.1–0.3.9 predate the changelog policy and were released
without cutting this file; only the entry below was recorded at the time.

### Breaking (recipe authors only)

- `modules.fleet.children[].recipe` paths now resolve at recipe-load time
  against the **directory of the parent recipe file** (or URL base) rather
  than `process.cwd()`. Absolute paths and `http(s)://` URLs pass through
  unchanged. This makes recipe bundles portable: a parent file and its
  sibling children can live anywhere on disk and be launched from any CWD.

  **Who needs to act**: anyone maintaining a forked or custom
  triumvirate-style recipe that hard-codes child paths with a `recipes/`
  prefix (or any prefix anchored at `connectome-host/`'s CWD). After
  upgrade, `"recipes/knowledge-miner.json"` inside
  `<somewhere>/my-recipe.json` resolves to
  `<somewhere>/recipes/knowledge-miner.json`, which is almost certainly
  not what's intended.

  **Migration**: drop the `recipes/` prefix so the child is referenced as a
  sibling of the parent file (e.g. `"knowledge-miner.json"` or
  `"./knowledge-miner.json"`). No files need to move on disk. The
  in-tree `recipes/triumvirate.json` has already been updated.

  **Unchanged**: `dataDir`, workspace mount paths, and child process CWD
  stay CWD-relative (these are runtime paths, not authoring references).
  `fleet--launch` invocations from the conductor are still matched
  CWD-relative at dispatch time, so existing system prompts that document
  CWD-relative paths continue to work.
