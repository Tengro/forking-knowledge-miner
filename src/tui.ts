/**
 * Custom ANSI TUI — scrolling conversation region + fixed status/input footer.
 *
 * Layout (top to bottom):
 *   ┌─────────────────────────────┐
 *   │  Scrolling conversation     │  ← ANSI scroll region, rows 1..N-2
 *   │  (tokens stream here)       │
 *   ├─────────────────────────────┤
 *   │  Status bar                 │  ← Fixed at row N-1
 *   │  > input                    │  ← Fixed at row N (readline)
 *   └─────────────────────────────┘
 *
 * Key insight: the cursor lives in the scroll region while tokens stream.
 * We only jump out to redraw status bar / input, then jump back.
 */

import { createInterface } from 'node:readline';
import type { AgentFramework } from '@connectome/agent-framework';
import type { SubagentModule, ActiveSubagent } from './modules/subagent-module.js';
import { handleCommand } from './commands.js';

// ANSI escape helpers
const ESC = '\x1b[';
const alt = (on: boolean) => ESC + (on ? '?1049h' : '?1049l');
const clearScreen = () => ESC + '2J' + ESC + 'H';
const setScrollRegion = (top: number, bottom: number) => `${ESC}${top};${bottom}r`;
const moveTo = (row: number, col: number) => `${ESC}${row};${col}H`;
const eraseLine = () => ESC + '2K';
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const FG_GREEN = `${ESC}32m`;
const FG_YELLOW = `${ESC}33m`;
const FG_CYAN = `${ESC}36m`;
const FG_MAGENTA = `${ESC}35m`;
const FG_RED = `${ESC}31m`;
const FG_GRAY = `${ESC}90m`;
const SAVE = `${ESC}s`;
const RESTORE = `${ESC}u`;
const SHOW_CURSOR = `${ESC}?25h`;
const HIDE_CURSOR = `${ESC}?25l`;

interface TuiState {
  status: string;
  tool: string | null;
  subagents: ActiveSubagent[];
  showSubagents: boolean;
}

export async function runTui(framework: AgentFramework): Promise<void> {
  const { stdout, stdin } = process;
  if (!stdout.isTTY) throw new Error('TUI requires a TTY');

  let rows = stdout.rows ?? 24;
  const scrollBot = () => rows - 2;
  const statusLine = () => rows - 1;
  const inputLine = () => rows;

  const state: TuiState = {
    status: 'idle',
    tool: null,
    subagents: [],
    showSubagents: false,
  };

  let streaming = false;

  // ── Screen setup ──────────────────────────────────────────────────────

  function initScreen() {
    stdout.write(alt(true));
    stdout.write(clearScreen());
    stdout.write(setScrollRegion(1, scrollBot()));
    // Park cursor at bottom of scroll region
    stdout.write(moveTo(scrollBot(), 1));
    redrawFooter();
  }

  function destroyScreen() {
    stdout.write(setScrollRegion(1, rows));
    stdout.write(alt(false));
  }

  // ── Footer (status + input) ───────────────────────────────────────────
  // Drawn outside the scroll region so it never scrolls.

  function redrawFooter() {
    stdout.write(SAVE + HIDE_CURSOR);

    // Status bar
    stdout.write(moveTo(statusLine(), 1) + eraseLine());
    const sColor = state.status === 'idle' ? FG_GREEN
      : state.status === 'error' ? FG_RED : FG_YELLOW;
    let bar = `${FG_GRAY}[${RESET}${sColor}${state.status}${RESET}`;
    if (state.tool) bar += `${FG_YELLOW} | ${state.tool}${RESET}`;
    const running = state.subagents.filter(s => s.status === 'running').length;
    if (running > 0) {
      bar += `${FG_MAGENTA} | ${running} sub${RESET}`;
      if (state.showSubagents) {
        const details = state.subagents
          .filter(s => s.status === 'running')
          .map(s => {
            const t = Math.floor((Date.now() - s.startedAt) / 1000);
            const msg = s.statusMessage ? ` ${s.statusMessage}` : '';
            return `${FG_CYAN}${s.name}${FG_GRAY}(${t}s${msg})${RESET}`;
          }).join(' ');
        bar += ' ' + details;
      } else {
        bar += `${DIM}${FG_GRAY} Tab:details${RESET}`;
      }
    }
    bar += `${FG_GRAY}]${RESET}`;
    stdout.write(bar);

    // Input line
    stdout.write(moveTo(inputLine(), 1) + eraseLine());
    stdout.write(`${BOLD}${FG_CYAN}> ${RESET}`);

    stdout.write(RESTORE + SHOW_CURSOR);
  }

  // ── Scroll region writing ─────────────────────────────────────────────
  // These all assume cursor is parked inside the scroll region.

  /** Write a complete line into the scroll region with a preceding newline. */
  function printLine(text: string, style?: string) {
    stdout.write(SAVE + HIDE_CURSOR);
    // Move to bottom of scroll region — newline will scroll up
    stdout.write(moveTo(scrollBot(), 1));
    stdout.write('\n');
    if (style) stdout.write(style);
    stdout.write(text);
    if (style) stdout.write(RESET);
    stdout.write(RESTORE + SHOW_CURSOR);
  }

  // Track the scroll-region cursor column so we can resume streaming mid-line.
  // The terminal maintains its own scroll cursor; we track it to know where to moveTo.
  let scrollRow = 1;
  let scrollCol = 1;

  /** Start streaming: insert a newline in the scroll region. */
  function beginStream() {
    stdout.write(SAVE + HIDE_CURSOR);
    stdout.write(moveTo(scrollBot(), 1) + '\n');
    scrollRow = scrollBot();
    scrollCol = 1;
    stdout.write(RESTORE + SHOW_CURSOR);
    streaming = true;
  }

  /** Write a token fragment into the scroll region, then return cursor to input line. */
  function streamToken(text: string) {
    stdout.write(SAVE + HIDE_CURSOR);
    stdout.write(moveTo(scrollRow, scrollCol));
    stdout.write(text);

    // Track cursor position — count characters, handle newlines and wraps
    const cols = stdout.columns ?? 80;
    for (const ch of text) {
      if (ch === '\n') {
        scrollCol = 1;
        // If at bottom of scroll region, content scrolled up (row stays)
        // If not at bottom, move down
        if (scrollRow < scrollBot()) scrollRow++;
      } else {
        scrollCol++;
        if (scrollCol > cols) {
          scrollCol = 1;
          if (scrollRow < scrollBot()) scrollRow++;
        }
      }
    }

    stdout.write(RESTORE + SHOW_CURSOR);
  }

  /** End streaming. */
  function endStream() {
    streaming = false;
  }

  // ── Trace listener ────────────────────────────────────────────────────

  function onTrace(event: Record<string, unknown>) {
    const agent = event.agentName as string | undefined;

    switch (event.type) {
      case 'inference:started': {
        if (agent === 'researcher') {
          state.status = 'thinking';
          beginStream();
          redrawFooter();
        }
        break;
      }

      case 'inference:tokens': {
        const content = event.content as string;
        if (content && agent === 'researcher' && streaming) {
          streamToken(content);
        }
        break;
      }

      case 'inference:completed': {
        if (agent === 'researcher') {
          state.status = 'idle';
          state.tool = null;
          if (streaming) endStream();
          redrawFooter();
        }
        break;
      }

      case 'inference:failed': {
        if (agent === 'researcher') {
          state.status = 'error';
          if (streaming) endStream();
          printLine(`Error: ${event.error}`, FG_RED);
          redrawFooter();
        } else {
          printLine(`[${agent}] Error: ${event.error}`, FG_RED + DIM);
        }
        break;
      }

      case 'inference:tool_calls_yielded': {
        const calls = event.calls as Array<{ name: string }>;
        const names = calls.map(c => c.name).join(', ');

        if (agent === 'researcher') {
          state.status = 'tools';
          state.tool = names;
          if (streaming) endStream();
          printLine(`[tools] ${names}`, FG_YELLOW + DIM);
        } else {
          // Subagent tool call
          const short = (agent ?? '').replace(/^(spawn|fork)-/, '').replace(/-\d+$/, '');
          printLine(`  [${short}] ${names}`, FG_GRAY);
          const sa = state.subagents.find(s => (agent ?? '').includes(s.name));
          if (sa) {
            sa.toolCallsCount += calls.length;
            sa.statusMessage = names.split(':').pop();
          }
        }
        redrawFooter();
        break;
      }

      case 'inference:stream_resumed': {
        if (agent === 'researcher') {
          state.status = 'thinking';
          state.tool = null;
          beginStream();
          redrawFooter();
        }
        break;
      }

      case 'tool:started': {
        if (agent === 'researcher') {
          state.tool = event.tool as string;
          redrawFooter();
        }
        break;
      }
    }
  }

  // ── Subagent polling ──────────────────────────────────────────────────

  const subMod = framework.getAllModules().find(m => m.name === 'subagent') as SubagentModule | undefined;
  const pollTimer = setInterval(() => {
    if (subMod) {
      state.subagents = [...subMod.activeSubagents.values()];
      redrawFooter();
    }
  }, 500);

  // ── Resize ────────────────────────────────────────────────────────────

  function onResize() {
    rows = stdout.rows ?? 24;
    stdout.write(setScrollRegion(1, scrollBot()));
    redrawFooter();
  }
  stdout.on('resize', onResize);

  // ── Input ─────────────────────────────────────────────────────────────

  stdin.setRawMode(true);
  const rl = createInterface({ input: stdin, output: stdout, prompt: '', terminal: true });

  // Tab interceptor
  stdin.on('data', (data: Buffer) => {
    if (data[0] === 0x09) {
      state.showSubagents = !state.showSubagents;
      redrawFooter();
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────

  initScreen();
  printLine('Zulip Knowledge App. Type /help for commands.', FG_GRAY);
  // Position cursor on input line for readline
  stdout.write(moveTo(inputLine(), 3));

  framework.onTrace(onTrace as (e: unknown) => void);

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    // Redraw input line (readline messes it up)
    redrawFooter();
    stdout.write(moveTo(inputLine(), 3));

    if (!trimmed) return;

    if (trimmed.startsWith('/')) {
      const result = handleCommand(trimmed, framework);
      if (result.quit) { rl.close(); return; }
      if (trimmed === '/clear') {
        // Clear scroll region
        for (let i = 1; i <= scrollBot(); i++) {
          stdout.write(moveTo(i, 1) + eraseLine());
        }
        stdout.write(moveTo(inputLine(), 3));
      } else {
        for (const l of result.lines) printLine(l.text, FG_GRAY);
      }
    } else {
      printLine(`You: ${trimmed}`, FG_GREEN);
      framework.pushEvent({
        type: 'external-message', source: 'tui',
        content: trimmed, metadata: {}, triggerInference: true,
      });
    }
    stdout.write(moveTo(inputLine(), 3));
  });

  // ── Wait for exit ─────────────────────────────────────────────────────

  await new Promise<void>(resolve => rl.on('close', resolve));

  clearInterval(pollTimer);
  stdout.removeListener('resize', onResize);
  framework.offTrace(onTrace as (e: unknown) => void);
  destroyScreen();
  await framework.stop();
}
