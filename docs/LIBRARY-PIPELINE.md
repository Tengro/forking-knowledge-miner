# The Library Pipeline

A guide to running connectome-host as a self-dispatching, three-agent knowledge pipeline: **Clerk**, **Miner**, and **Reviewer** coexisting as independent processes, coordinating through a shared filesystem.

This is a non-obvious way to use connectome-host. Most recipes are one-shot: you start a session, talk to the agent, it does the work. The library pipeline is different — three long-running sessions answer to filesystem events, each one waking when the previous one produces output. Nobody types prompts at the mining or review agents; the Clerk types prompts at them by dropping files.

## What it is

Three agents, three recipes, three roles:

| Agent | Recipe | Role |
|-------|--------|------|
| **Clerk** | `clerk.json` | Sits on a Zulip channel. Answers questions from the library. Files a ticket when the library falls short. |
| **Miner** | `knowledge-miner.json` | Deep research across Zulip / Notion / GitLab. Produces draft reports with confidence markers. |
| **Reviewer** | `knowledge-reviewer.json` | Critic pass over miner output. Produces SME checklists and review notes. |

The three are coupled by **file events**, not by IPC, HTTP, or a message queue. Each agent's output directory is another agent's watched input. A write on one end wakes an inference on the other.

```
           ┌────────────────────────── Zulip #tracker-miner-f ──────────────────────────┐
           │                                                                            │
           ▼                                                                            │
       ┌────────┐                    ┌─────────┐                    ┌──────────┐        │
       │ CLERK  │ ── ticket ──▶      │  MINER  │ ── draft ──▶       │ REVIEWER │        │
       │        │  knowledge-        │         │   output/          │          │        │
       │        │  requests/         │         │                    │          │        │
       │        │                    │         │                    │          │        │
       │        │  ◀── resolution ── │         │                    │          │        │
       │        │   knowledge-       │         │                    │          │        │
       │        │   requests/        │         │                    │          │        │
       │        │                    │         │                    │          │        │
       │        │  ◀─────────────── review ────────────────────────  │          │        │
       │        │     review-output/                                 │          │        │
       └────────┘                    └─────────┘                    └──────────┘        │
           │                                                                            │
           └────────────────────────── answer posted ──────────────────────────────────┘
```

Clerk reads both `output/` (mined drafts) and `review-output/` (reviewed material) as its "library"; writes tickets to `knowledge-requests/`. Miner reads `knowledge-requests/`, writes drafts to `output/`. Reviewer reads `output/`, writes to `review-output/`. Every pair is a one-way wake loop: the producer materializes a file, the consumer's chokidar watcher fires, the consumer's event gate matches a wake policy, the consumer infers.

## Why run it this way

- **Separation of concerns.** Mining is deep and slow (large forks, heavy context). Reviewing is skeptical and linear (goes document by document). Fronting a chat channel must be fast and sourced. Collapsing these into one agent makes every one of them worse.
- **Loose coupling.** Filesystem-mediated handoffs mean each agent runs its own process, own session, own Chronicle store. You can restart or replace any one without touching the others.
- **Auditability.** Every handoff is a file on disk. You can read the ticket the Clerk filed, the report the Miner produced, the checklist the Reviewer wrote. Nothing is hidden in agent memory.

## Prerequisites

Start by reading [`../recipes/SETUP.md`](../recipes/SETUP.md) — it covers the credentials and MCP servers used by the Miner. The library pipeline needs the same setup plus a few extras.

You need all of:

- Bun, Node 20+, an Anthropic API key (from SETUP.md).
- **Zulip**: a bot account with API credentials, subscribed to the channel you want the Clerk to staff (default: `tracker-miner-f`). `.zuliprc` in the project directory.
- **Zulip MCP server** built and reachable at the path referenced in each recipe (see SETUP.md Step 2).
- **Miner data sources** (optional but recommended): a Notion MCP server, GitLab, `gitlab-clone-mcp` for code search without Advanced Search.
- Three free terminal windows (or tmux panes, or `screen` windows) — one per agent.

## Directory layout

All three agents must launch with the **same working directory**, because their mounts all resolve relative to `process.cwd()`. They don't need to share their *data* directories — in fact they must not, because each agent's Chronicle store, sessions, and lessons are per-instance state.

A working layout:

```
connectome-host/
├── .zuliprc                        # Zulip bot credentials
├── recipes/
│   ├── clerk.json
│   ├── knowledge-miner.json
│   └── knowledge-reviewer.json
├── knowledge-requests/             # shared mount: tickets
├── output/                         # shared mount: mined drafts
├── review-output/                  # shared mount: reviewed artifacts
├── input/                          # optional: seed material for miner
├── data-frontdesk/                 # Clerk's Chronicle, sessions, lessons
├── data-miner/                     # Miner's Chronicle, sessions, lessons
└── data-reviewer/                  # Reviewer's Chronicle, sessions, lessons
```

The three `data-*` directories are created on first run; you don't need to precreate them. The three shared-mount directories can be empty — the agents will populate them.

## The wake loop, concretely

Two mechanisms work together. If either is missing, the pipeline silently does nothing.

### 1. `autoMaterialize` on the producer side

By default, workspace writes in connectome-host stay in Chronicle and never hit disk until the agent calls `workspace--materialize`. That works for single-agent sessions, but it breaks cross-agent pipelines: a chokidar watcher on the consumer can only fire when a real file is written.

The producing mount must have `autoMaterialize: true`. Each `workspace--write` / `workspace--edit` / `workspace--delete` immediately reconciles to disk; the local watcher suppresses the self-echo so the producer doesn't wake on its own writes.

Verify in the recipe JSON:

- Clerk's `knowledge-requests` mount → `autoMaterialize: true` ✓
- Miner's `products` and `tickets` mounts → `autoMaterialize: true` ✓
- Reviewer's `products` mount → `autoMaterialize: true` ✓

### 2. `watch: 'always'` + `wakeOnChange` on the consumer side

The consumer mount must be watched and must declare which op types trigger a wake:

```json
{
  "name": "knowledge-requests",
  "path": "./knowledge-requests",
  "mode": "read-only",
  "watch": "always",
  "wakeOnChange": ["created"]
}
```

`wakeOnChange` takes an array of `"created" | "modified" | "deleted"`, or `true` for all three. The WorkspaceModule emits `workspace:created` / `workspace:modified` / `workspace:deleted` events carrying mount-prefixed paths.

### 3. A matching gate policy

An event arriving at the agent still has to pass the EventGate to cause an inference. Each recipe's `modules.wake.policies` contains the match rules. The important ones for the library pipeline:

```json
{
  "name": "ticket-resolutions",
  "match": {
    "scope": ["workspace:modified"],
    "mount": "knowledge-requests",
    "pathGlob": "knowledge-requests/*.md"
  },
  "behavior": "always"
}
```

The `mount` field matches the mount name; `pathGlob` matches any of the event's paths. Both are optional but recommended — without them the policy fires on *every* file event for its scope.

The gate file (`_config/gate.json` inside the data dir) is seeded from the recipe on first start and then reconciled additively on every subsequent start: new policies from the recipe are appended by name, but policies the user added or edited via `workspace--edit _config/gate.json` are preserved. Hot-reloads land in ~1 second.

### 4. Who wakes whom

| Trigger                                            | Fires in           | Policy name             |
|----------------------------------------------------|--------------------|-------------------------|
| Someone posts in Zulip `#tracker-miner-f`          | Clerk              | `tracker-channel`       |
| Clerk creates `knowledge-requests/*.md`            | Miner              | `new-tickets`           |
| Miner modifies `knowledge-requests/*.md` (resolves)| Clerk              | `ticket-resolutions`    |
| Miner creates `output/*.md` (draft report)         | Reviewer           | `new-reports`           |
| Reviewer creates `review-output/*.md`              | Clerk              | `reviewed-responses`    |

Each agent's own wake policies are in its recipe — compare if you need to debug silent failures.

## Running the three

Launch each agent in its own terminal, same working directory, distinct `DATA_DIR`:

```bash
# Terminal 1 — Clerk (the one humans interact with through Zulip)
cd connectome-host
DATA_DIR=./data-frontdesk bun src/index.ts recipes/clerk.json

# Terminal 2 — Miner
cd connectome-host
DATA_DIR=./data-miner bun src/index.ts recipes/knowledge-miner.json

# Terminal 3 — Reviewer
cd connectome-host
DATA_DIR=./data-reviewer bun src/index.ts recipes/knowledge-reviewer.json
```

Order doesn't matter. The gate initial-scan will catch any files that were written while an agent was offline: on startup each `watch: 'always'` mount does a one-shot `syncFromFs` diff against its Chronicle tree, firing `workspace:created` for files that are on disk but new to this session. So if the Miner was offline when the Clerk filed three tickets, the Miner will wake on those three tickets the moment it starts.

If the Clerk is the only one you expect to interact with, keep the Miner and Reviewer in headless mode — their TUI is still useful for watching progress, but they don't need stdin. You can also pass `--no-tui` if you want to tail logs without OpenTUI taking over the terminal.

## The ticket contract

Agents coordinate through a schema, not a protocol. The ticket format is defined in `clerk.json`'s system prompt; the Miner and Reviewer prompts read from it but do not re-define it. Keep them in sync.

Filename: `YYYY-MM-DD-short-slug.md`, one ticket per file.

Frontmatter:

```yaml
---
filed: 2026-04-20T17:01:45Z
asker: Anton Kukushkin
asker_id: 12345
channel: tracker-miner-f
topic: general chat
message_link: <zulip message link or numeric ID>
status: open        # open | in-progress | resolved
urgency: normal     # low | normal | high
---
```

Body sections (required, in order): `## Question`, `## Search Trail`, `## Specific Unknowns`, `## Notes`.

**Ownership:** the Clerk writes tickets at `status: open` and never modifies them again. The Miner flips status to `in-progress` while working, then to `resolved` with a `resolution:` block appended. Only the Miner modifies tickets; that's what makes `workspace:modified` a reliable "resolution-ready" signal for the Clerk.

**Resolutions reach the asker via Zulip.** The Clerk, on waking from a ticket modification, reads the resolved ticket, reads any newly-created `review-output/` file that covers the topic, and posts back to the channel — citing `library-mined:` / `library-reviewed:` paths inline. The asker gets notified by Zulip's normal mention/reply mechanics.

## Confidence markers — end-to-end

Every non-trivial claim in mined or reviewed material carries a marker:

| Marker | Meaning |
|--------|---------|
| `[SRC: source]` | Directly sourced. Quote verbatim when citing. |
| `[INF]` | Inferred across sources. |
| `[GEN]` | General domain knowledge — no specific source. |
| `❓` | Knowledge gap — admission of "we don't know." |

Markers are written by the Miner, audited by the Reviewer (who looks especially for unmarked claims that *should* have been `[GEN]`), and preserved by the Clerk when citing in chat. **Never launder markers**: a `[GEN]` claim quoted without its tag becomes a confident assertion the Clerk didn't intend to make.

## Operational notes

### Adding a channel the Clerk listens to

Two layers, both required:

1. `zulip--listen { channels: ["new-stream"] }` — subscribes the bot to the Zulip stream (server-side state, persists across restarts).
2. Append a gate policy to `_config/gate.json` via `workspace--edit`:

   ```json
   {
     "name": "new-stream",
     "match": { "scope": ["mcpl:channel-incoming"], "channel": "zulip:new-stream" },
     "behavior": "always"
   }
   ```

Subscription without a policy means events arrive but don't wake. Policy without subscription means nothing arrives at all. The EventGate hot-reloads the file in ~1s — no restart.

### Removing a channel

Reverse order: remove the gate policy first (so the context doesn't fill with messages you'll never react to), then `zulip--unlisten`.

**Do not** unsubscribe the Clerk from `tracker-miner-f` or remove the `tracker-channel` policy without explicit confirmation — it silences the only channel the Clerk is supposed to staff.

### Channel subscription blast radius

The Zulip MCPL server registers every visible public stream it can see. In a large org that can be 100+ streams, and `ChannelRegistry` will open all of them by default. Quiet channels still accumulate messages in context. Symptoms: the Miner's next wake includes a 100K+ token burst of unrelated chat.

Fix: set `channelSubscription` on the zulip server in recipes that aren't meant to listen passively:

```json
"zulip": {
  "command": "node",
  "args": ["../zulip-mcp/build/index.js"],
  "env": { "...": "..." },
  "channelSubscription": "manual"
}
```

Values: `"auto"` (default, everything opens), `"manual"` (nothing opens; agent opens channels explicitly), or `string[]` (allow-list). Clerk is intentionally `"auto"` (passive listening). Miner and Reviewer, if they connect to Zulip at all, should be `"manual"` or allow-listed.

### Lessons don't cross agents

Each data dir has its own `lessons.json`. The Miner's extracted lessons are not visible to the Clerk. This is intentional — the library (files on disk) is the shared knowledge, not the lesson store. Use lessons for meta-observations about each role ("tickets about X usually need Y"), not facts that belong in the library.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Clerk files tickets but Miner never wakes | Producer missing `autoMaterialize`, or consumer missing `watch: 'always'` + `wakeOnChange` | `ls knowledge-requests/` — files on disk? If yes, check Miner's recipe for those two flags. |
| Miner wakes but never runs | Event reaching the gate but no policy matching it | In the Miner, run `gate:status`. If `defaultDecisions.byEventType["workspace:created"].skipped > 0` and no policy's `matchCount` went up, the policy's `mount` or `pathGlob` doesn't match. |
| Fresh session sees empty directories | Gate initial-scan didn't run, or the mount isn't `watch: 'always'` | Check `workspace--status` — `initialSyncDone: false` means watchers haven't started. |
| Clerk was silent through a known question | Zulip subscription or `tracker-channel` policy was removed | `zulip--listen` with no args shows subscribed streams; `workspace--read _config/gate.json` shows active policies. |
| Miner's context is flooded with Zulip chat it doesn't care about | `channelSubscription` defaulted to `"auto"` on a large Zulip | Set `"manual"` or an allow-list on the zulip server in `knowledge-miner.json`. |
| Three-agent pipeline works on one machine, breaks on another | Agents launched from different working directories | All three must share `cwd`. `./knowledge-requests` resolves to three different paths otherwise. |
| Tickets pile up, Miner is "busy" but never writes reports | Miner is context-saturated, or wedged on a long fork | `/status` in the Miner's TUI; `Tab` for fleet view to see if forks are actually progressing. |
| Clerk posts answers but cites `[GEN]` claims as facts | Prompt drift; retrain or re-read the clerk prompt | The clerk prompt explicitly forbids this — if it happens, regenerate the session with `/session new` and re-verify. |

### Diagnosing a silent wake failure

Three specific things to check, in order:

1. **Is the file on disk?** `ls` the producer's output directory. If the producer's mount lacks `autoMaterialize`, the file exists only in Chronicle and no event will ever fire.
2. **Is the watcher running?** In the consumer, `workspace--status` should show `initialSyncDone: true` for the watched mount. If it's `false`, watcher setup didn't complete.
3. **Is the gate dropping the event?** In the consumer, `gate:status` returns per-policy `matchCount` and an aggregate `defaultDecisions.byEventType`. If `workspace:created`'s `skipped` count is non-zero but the target policy's `matchCount` didn't change, the policy is there but the match fields don't cover the actual event.

A non-zero `skipped` without a matching policy is the fingerprint of a mount-name or pathGlob mismatch — the event arrived, the gate looked at it, no policy claimed it.

## Extending the pipeline

The schema-through-files pattern generalizes. A few natural extensions:

- **Miner-manager** — polls `knowledge-requests/` for `status: open`, spawns a bounded number of miner sessions, marks tickets `in-progress`, and writes resolutions. Currently the Miner fills this role itself; splitting it out makes dispatch policy (priority, concurrency, deduplication) explicit.
- **Specialist miners** — one miner per source (Zulip-only, GitLab-only, Notion-only) with distinct recipes. The manager routes tickets by `topic` or by heuristics in the request body. Each specialist's lesson store accumulates source-specific expertise.
- **Synthesis reviewer** — a second reviewer that specifically checks cross-document consistency (the current reviewer is intra-document). Would watch `review-output/` and write to `review-output/meta/`.

The constraint for any new member: one mount points at the producer's output with `watch: 'always'` + `wakeOnChange`, and one gate policy matches that scope. That's the whole protocol.
