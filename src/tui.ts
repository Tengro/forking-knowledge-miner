/**
 * OpenTUI-based terminal interface.
 *
 * Layout (top to bottom):
 *   ┌─────────────────────────────┐
 *   │  ScrollBox (conversation)   │  ← flexGrow, stickyScroll
 *   │  └─ TextRenderable per msg  │
 *   ├─────────────────────────────┤
 *   │  Status bar (1 row)         │  ← [status | tool | N sub]
 *   ├─────────────────────────────┤
 *   │  InputRenderable            │  ← user input
 *   └─────────────────────────────┘
 *
 * Tab toggles between conversation and agent fleet tree view.
 * Fleet view uses a single TextRenderable (no child churn).
 */

import {
  createCliRenderer,
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  bold,
  dim,
  fg,
} from '@opentui/core';
import type { AgentFramework } from '@connectome/agent-framework';
import type { Membrane, NormalizedRequest } from 'membrane';
import type { SubagentModule, ActiveSubagent } from './modules/subagent-module.js';
import { handleCommand } from './commands.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface TuiState {
  status: string;
  tool: string | null;
  subagents: ActiveSubagent[];
  viewMode: 'chat' | 'fleet';
  tokens: TokenUsage;
}

// ---------------------------------------------------------------------------
// Colours (hex strings for OpenTUI)
// ---------------------------------------------------------------------------

const GREEN = '#00cc00';
const YELLOW = '#cccc00';
const CYAN = '#00cccc';
const MAGENTA = '#cc00cc';
const RED = '#cc0000';
const GRAY = '#888888';
const DIM_GRAY = '#555555';
const WHITE = '#cccccc';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runTui(framework: AgentFramework, membrane: Membrane): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });

  // Set terminal title
  process.stdout.write('\x1b]0;Zulip Knowledge Miner\x07');

  const state: TuiState = {
    status: 'idle',
    tool: null,
    subagents: [],
    viewMode: 'chat',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  let streaming = false;
  let currentStreamText: TextRenderable | null = null;
  let currentStreamBuffer = '';  // Track accumulated text (TextRenderable.content is StyledText, not string)

  // ── Layout ────────────────────────────────────────────────────────────

  const rootBox = new BoxRenderable(renderer, {
    id: 'root',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  });

  const scrollBox = new ScrollBoxRenderable(renderer, {
    id: 'conversation',
    flexGrow: 1,
    stickyScroll: true,
  });

  // Fleet view: a Box containing a single TextRenderable whose content is rebuilt.
  // Using a Box wrapper so we can toggle .visible without layout issues.
  const fleetText = new TextRenderable(renderer, {
    id: 'fleet-text',
    content: '',
    fg: GRAY,
  });
  const fleetBox = new BoxRenderable(renderer, {
    id: 'fleet',
    flexGrow: 1,
    flexDirection: 'column',
    paddingLeft: 1,
    paddingTop: 1,
  });
  fleetBox.add(fleetText);

  const statusLeft = new TextRenderable(renderer, {
    id: 'status-left',
    content: formatStatusLeft(state),
    fg: GRAY,
  });

  const statusRight = new TextRenderable(renderer, {
    id: 'status-right',
    content: formatTokens(state.tokens),
    fg: DIM_GRAY,
  });

  const statusBox = new BoxRenderable(renderer, {
    id: 'status-box',
    height: 1,
    paddingLeft: 1,
    paddingRight: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
  });

  const input = new InputRenderable(renderer, {
    id: 'input',
    placeholder: 'Type a message or /help...',
  });

  const inputBox = new BoxRenderable(renderer, {
    id: 'input-box',
    height: 1,
    paddingLeft: 1,
  });

  // Assembly — both views always present; fleet starts hidden
  statusBox.add(statusLeft);
  statusBox.add(statusRight);
  inputBox.add(input);
  rootBox.add(scrollBox);
  rootBox.add(fleetBox);
  fleetBox.visible = false;
  rootBox.add(statusBox);
  rootBox.add(inputBox);
  renderer.root.add(rootBox);

  input.focus();

  // ── Agent stream transcripts & synesthete summaries ────────────────

  /** Accumulated transcript per agent (text output + tool calls). */
  const agentTranscripts = new Map<string, string>();

  /** Synesthete summary per agent, keyed by agent name. */
  const summaryCache = new Map<string, string>();
  /** Transcript length at time of last summary generation. */
  const summarySnapshotLen = new Map<string, number>();
  const summaryPending = new Set<string>();

  /** Minimum transcript growth before re-summarizing. */
  const SUMMARY_DELTA = 2000;
  /** Max transcript chars to send to Haiku. */
  const SUMMARY_WINDOW = 10_000;

  function appendTranscript(agent: string, text: string) {
    const prev = agentTranscripts.get(agent) ?? '';
    agentTranscripts.set(agent, prev + text);
  }

  async function generateSummary(agentName: string) {
    if (summaryPending.has(agentName)) return;
    const transcript = agentTranscripts.get(agentName);
    if (!transcript || transcript.length < 50) return;

    // Only re-summarize if transcript has grown enough
    const lastLen = summarySnapshotLen.get(agentName) ?? 0;
    if (transcript.length - lastLen < SUMMARY_DELTA && summaryCache.has(agentName)) return;

    summaryPending.add(agentName);
    try {
      const window = transcript.slice(-SUMMARY_WINDOW);
      const request: NormalizedRequest = {
        messages: [{
          participant: 'user',
          content: [{ type: 'text', text: `Here is the recent activity stream of an AI agent:\n\n${window}\n\nDescribe what this agent is currently doing in a single concise sentence (max 80 chars). Be specific about the content, not the mechanics.` }],
        }],
        system: 'You are a synesthete observer. You perceive an agent\'s stream of work and distill it into a vivid, concise status line. Be specific and evocative. One sentence only.',
        config: { model: 'claude-haiku-4-5-20251001', maxTokens: 80, temperature: 0.3 },
      };
      const response = await membrane.complete(request);
      const text = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text).join('').trim();
      summaryCache.set(agentName, text);
      summarySnapshotLen.set(agentName, transcript.length);
      if (state.viewMode === 'fleet') updateFleetView();
    } catch {
      // Summary generation is best-effort
    } finally {
      summaryPending.delete(agentName);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  let messageCounter = 0;

  function addLine(text: string, color: string = WHITE) {
    const line = new TextRenderable(renderer, {
      id: `msg-${++messageCounter}`,
      content: text,
      fg: color,
    });
    scrollBox.add(line);
  }

  function updateStatus() {
    statusLeft.content = formatStatusLeft(state);
    statusRight.content = formatTokens(state.tokens);
  }

  function beginStream() {
    currentStreamBuffer = '';
    currentStreamText = new TextRenderable(renderer, {
      id: `stream-${++messageCounter}`,
      content: '',
      fg: WHITE,
    });
    scrollBox.add(currentStreamText);
    streaming = true;
  }

  function streamToken(text: string) {
    if (currentStreamText) {
      currentStreamBuffer += text;
      currentStreamText.content = currentStreamBuffer;
    }
  }

  function endStream() {
    streaming = false;
    currentStreamText = null;
    currentStreamBuffer = '';
  }

  // ── Fleet tree view ────────────────────────────────────────────────

  function updateFleetView() {
    const lines: string[] = [];

    lines.push('─── Agent Fleet ───────────────────────────');
    lines.push('');

    // Researcher (root of tree)
    const resStatus = state.status === 'idle' ? '✓ idle'
      : state.status === 'error' ? '✗ error'
      : `… ${state.status}`;
    lines.push(`  researcher                          [${resStatus}]`);
    if (state.tool) {
      lines.push(`  │  tool: ${state.tool}`);
    }
    const resSummary = summaryCache.get('researcher');
    if (resSummary) {
      lines.push(`  │  ┈ ${resSummary}`);
    }
    generateSummary('researcher');

    const running = state.subagents.filter(s => s.status === 'running');
    const completed = state.subagents.filter(s => s.status !== 'running');
    const all = [...running, ...completed];

    if (all.length === 0) {
      lines.push('');
      lines.push('  (no subagents)');
    }

    all.forEach((s, i) => {
      const isLast = i === all.length - 1;
      const branch = isLast ? '└─' : '├─';
      const cont = isLast ? '   ' : '│  ';

      const elapsed = Math.floor((Date.now() - s.startedAt) / 1000);
      let tag: string;
      if (s.status === 'running') {
        tag = `running ${elapsed}s`;
      } else if (s.status === 'completed') {
        tag = `done ${elapsed}s`;
      } else {
        tag = 'failed';
      }

      lines.push('  │');
      lines.push(`  ${branch} ${s.name}  ${s.type}                [${tag}]`);
      lines.push(`  ${cont}  task: ${s.task}`);

      if (s.statusMessage) {
        lines.push(`  ${cont}  tool: ${s.statusMessage} (${s.toolCallsCount} calls)`);
      }

      // Synesthete summary — match full agent name from transcripts
      const fullName = [...agentTranscripts.keys()].find(k => k.includes(s.name));
      if (fullName) {
        const summary = summaryCache.get(fullName);
        if (summary) {
          lines.push(`  ${cont}  ┈ ${summary}`);
        } else if (summaryPending.has(fullName)) {
          lines.push(`  ${cont}  ┈ …`);
        }
        generateSummary(fullName);
      }
    });

    lines.push('');
    lines.push('                                  Tab: back to chat');

    fleetText.content = lines.join('\n');
  }

  function switchView(mode: 'chat' | 'fleet') {
    state.viewMode = mode;
    scrollBox.visible = mode === 'chat';
    fleetBox.visible = mode === 'fleet';
    if (mode === 'fleet') updateFleetView();
    input.focus();
  }

  // ── Trace listener ──────────────────────────────────────────────────

  function onTrace(event: Record<string, unknown>) {
    const agent = event.agentName as string | undefined;

    switch (event.type) {
      case 'inference:started': {
        if (agent === 'researcher') {
          state.status = 'thinking';
          beginStream();
          updateStatus();
        }
        break;
      }

      case 'inference:tokens': {
        const content = event.content as string;
        if (content) {
          if (agent === 'researcher' && streaming) {
            streamToken(content);
          }
          if (agent) appendTranscript(agent, content);
        }
        break;
      }

      case 'inference:completed': {
        // Track tokens for all agents (researcher + subagents)
        const usage = event.tokenUsage as { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } | undefined;
        if (usage) {
          state.tokens.input += usage.input ?? 0;
          state.tokens.output += usage.output ?? 0;
          state.tokens.cacheRead += usage.cacheRead ?? 0;
          state.tokens.cacheWrite += usage.cacheCreation ?? 0;
        }

        if (agent === 'researcher') {
          state.status = 'idle';
          state.tool = null;
          if (streaming) endStream();
        }
        updateStatus();
        break;
      }

      case 'inference:failed': {
        if (agent === 'researcher') {
          state.status = 'error';
          if (streaming) endStream();
          addLine(`Error: ${event.error}`, RED);
          updateStatus();
        } else {
          addLine(`[${agent}] Error: ${event.error}`, DIM_GRAY);
        }
        break;
      }

      case 'inference:tool_calls_yielded': {
        const calls = event.calls as Array<{ name: string; input?: unknown }>;
        const names = calls.map(c => c.name).join(', ');

        if (agent) {
          const toolSnippet = calls.map(c => {
            const inp = c.input ? JSON.stringify(c.input) : '';
            return `[tool: ${c.name}${inp ? ' ' + inp.slice(0, 200) : ''}]`;
          }).join('\n');
          appendTranscript(agent, '\n' + toolSnippet + '\n');
        }

        if (agent === 'researcher') {
          state.status = 'tools';
          state.tool = names;
          if (streaming) endStream();
          addLine(`[tools] ${names}`, YELLOW);
        } else {
          const short = (agent ?? '').replace(/^(spawn|fork)-/, '').replace(/-\d+$/, '');
          addLine(`  [${short}] ${names}`, DIM_GRAY);
          const sa = state.subagents.find(s => (agent ?? '').includes(s.name));
          if (sa) {
            sa.toolCallsCount += calls.length;
            sa.statusMessage = names.split(':').pop();
          }
        }
        updateStatus();
        break;
      }

      case 'inference:stream_resumed': {
        if (agent === 'researcher') {
          state.status = 'thinking';
          state.tool = null;
          beginStream();
          updateStatus();
        }
        break;
      }

      case 'tool:started': {
        if (agent === 'researcher') {
          state.tool = event.tool as string;
          updateStatus();
        }
        break;
      }
    }
  }

  // ── Subagent polling ────────────────────────────────────────────────

  const subMod = framework.getAllModules().find(m => m.name === 'subagent') as SubagentModule | undefined;
  const pollTimer = setInterval(() => {
    if (subMod) {
      state.subagents = [...subMod.activeSubagents.values()];
      updateStatus();
      if (state.viewMode === 'fleet') updateFleetView();
    }
  }, 500);

  // ── Keyboard ───────────────────────────────────────────────────────

  renderer.keyInput.on('keypress', (key: { name?: string; ctrl?: boolean }) => {
    if (key.name === 'tab') {
      switchView(state.viewMode === 'chat' ? 'fleet' : 'chat');
      updateStatus();
    }
    if (key.ctrl && key.name === 'c') {
      cleanup();
    }
  });

  // ── Input handling ─────────────────────────────────────────────────

  let resolveExit: (() => void) | null = null;

  input.on(InputRenderableEvents.ENTER, () => {
    const text = input.value.trim();
    // Clear input
    input.deleteLine();

    if (!text) return;

    if (text.startsWith('/')) {
      const result = handleCommand(text, framework);
      if (result.quit) {
        cleanup();
        return;
      }
      if (text === '/clear') {
        // Remove all children from scroll box
        const children = [...scrollBox.getChildren()];
        for (const child of children) {
          scrollBox.remove(child.id);
        }
      } else {
        for (const l of result.lines) {
          addLine(l.text, GRAY);
        }
      }
    } else {
      addLine(`You: ${text}`, GREEN);
      framework.pushEvent({
        type: 'external-message', source: 'tui',
        content: text, metadata: {}, triggerInference: true,
      });
    }
  });

  // ── Init ───────────────────────────────────────────────────────────

  addLine('Zulip Knowledge App. Type /help for commands.', GRAY);
  framework.onTrace(onTrace as (e: unknown) => void);

  // ── Cleanup ────────────────────────────────────────────────────────

  function cleanup() {
    clearInterval(pollTimer);
    framework.offTrace(onTrace as (e: unknown) => void);
    renderer.destroy();
    // Restore terminal title
    process.stdout.write('\x1b]0;\x07');
    framework.stop().then(() => {
      resolveExit?.();
    });
  }

  // ── Wait for exit ──────────────────────────────────────────────────

  await new Promise<void>(resolve => {
    resolveExit = resolve;
  });
}

// ---------------------------------------------------------------------------
// Status bar formatter
// ---------------------------------------------------------------------------

function formatStatusLeft(state: TuiState): string {
  const sColor = state.status === 'idle' ? '✓' : state.status === 'error' ? '✗' : '…';
  let bar = `[${sColor} ${state.status}`;
  if (state.tool) bar += ` | ${state.tool}`;
  const running = state.subagents.filter(s => s.status === 'running').length;
  if (running > 0) {
    bar += ` | ${running} sub`;
  }
  if (state.viewMode === 'fleet') {
    bar += ' | fleet view';
  } else if (running > 0) {
    bar += ' Tab:fleet';
  }
  bar += ']';
  return bar;
}

function formatTokens(tokens: TokenUsage): string {
  const total = tokens.input + tokens.output;
  if (total === 0) return '';

  const fmt = (n: number) => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  };

  let s = `${fmt(tokens.input)}in ${fmt(tokens.output)}out`;
  if (tokens.cacheRead > 0) s += ` ${fmt(tokens.cacheRead)}cache`;
  return s;
}
