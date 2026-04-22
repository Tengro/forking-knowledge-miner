/**
 * Tests for FleetModule's onIdle hook: debounced auto-dispatch of a
 * slash command when a child's lifecycle:idle persists without activity.
 *
 * Uses the mock headless child, which:
 *   - Emits lifecycle:idle ~30ms after each text-command inference cycle
 *   - Has a /hang command that simulates inference without a following idle
 *   - Echoes any received command as a command-output event so tests can
 *     observe auto-dispatched arrivals
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetModule } from '../src/modules/fleet-module.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MOCK_CHILD_PATH = join(TEST_DIR, 'mock-headless-child.ts');

async function launch(fleet: FleetModule, name: string, dataDir: string): Promise<void> {
  const res = await fleet.handleToolCall({
    id: `launch-${name}`,
    name: 'launch',
    input: { name, recipe: 'mock', dataDir },
  });
  if (!res.success) throw new Error(`launch ${name} failed: ${res.error}`);
}

async function send(fleet: FleetModule, name: string, content: string): Promise<void> {
  const res = await fleet.handleToolCall({
    id: `send-${name}-${Date.now()}`,
    name: 'send',
    input: { name, content },
  });
  if (!res.success) throw new Error(`send ${name} failed: ${res.error}`);
}

async function command(fleet: FleetModule, name: string, cmd: string): Promise<void> {
  const res = await fleet.handleToolCall({
    id: `cmd-${name}-${Date.now()}`,
    name: 'command',
    input: { name, command: cmd },
  });
  if (!res.success) throw new Error(`command ${cmd} to ${name} failed: ${res.error}`);
}

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('onIdle hook', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'fkm-onidle-')); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('fires configured command after sustained idle post-activity', async () => {
    const fleet = new FleetModule({
      childIndexPath: MOCK_CHILD_PATH,
      autoStart: [],
      socketWaitTimeoutMs: 10_000,
      readyTimeoutMs: 5_000,
      gracefulShutdownMs: 3_000,
      sigtermEscalationMs: 1_000,
    });
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);

    const seen: Array<{ type: string; text?: string }> = [];
    fleet.onChildEvent('watcher', (_name, evt) => {
      seen.push({ type: evt.type, text: (evt as { text?: string }).text });
    });

    // Launch with a short debounce so the test isn't slow.  Note: auto-
    // start can't carry onIdle through here (this fleet has empty autoStart);
    // we launch ad-hoc via the tool and then inject onIdle by hand via a
    // subsequent spawn with the config.  Simpler path: use the auto-start
    // config directly on the second fleet we build below.
    await fleet.stop();

    const fleet2 = new FleetModule({
      childIndexPath: MOCK_CHILD_PATH,
      autoStart: [{
        name: 'watcher',
        recipe: 'mock',
        dataDir: join(tmpDir, 'watcher'),
        onIdle: { command: '/help', debounceMs: 300 },
      }],
      socketWaitTimeoutMs: 10_000,
      readyTimeoutMs: 5_000,
      gracefulShutdownMs: 3_000,
      sigtermEscalationMs: 1_000,
    });

    const seen2: Array<{ type: string; text?: string }> = [];
    fleet2.onChildEvent('watcher', (_name, evt) => {
      seen2.push({ type: evt.type, text: (evt as { text?: string }).text });
    });

    await fleet2.start({} as unknown as Parameters<typeof fleet2.start>[0]);
    // wait for autoStart to finish
    for (let t = 0; t < 50; t++) {
      if (fleet2.getChildren().get('watcher')?.status === 'ready') break;
      await wait(100);
    }

    // Trigger activity → mock emits lifecycle:idle ~30ms later.
    await send(fleet2, 'watcher', 'do work');

    // After idle fires, debounce is 300ms → /help auto-dispatches ~330ms later.
    await wait(700);

    const helpArrivals = seen2.filter((e) => e.type === 'command-output' && /mock help/.test(e.text ?? ''));
    expect(helpArrivals.length).toBeGreaterThan(0);

    await fleet2.stop();
  }, 30_000);

  test('activity during debounce cancels the pending dispatch', async () => {
    const fleet = new FleetModule({
      childIndexPath: MOCK_CHILD_PATH,
      autoStart: [{
        name: 'busy',
        recipe: 'mock',
        dataDir: join(tmpDir, 'busy'),
        onIdle: { command: '/help', debounceMs: 500 },
      }],
      socketWaitTimeoutMs: 10_000,
      readyTimeoutMs: 5_000,
      gracefulShutdownMs: 3_000,
      sigtermEscalationMs: 1_000,
    });

    const seen: Array<{ type: string; text?: string }> = [];
    fleet.onChildEvent('busy', (_name, evt) => {
      seen.push({ type: evt.type, text: (evt as { text?: string }).text });
    });

    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    for (let t = 0; t < 50; t++) {
      if (fleet.getChildren().get('busy')?.status === 'ready') break;
      await wait(100);
    }

    // First activity → idle arrives, 500ms timer starts.
    await send(fleet, 'busy', 'first');

    // Wait less than the debounce, then fire another activity — this should
    // reset the pending timer before it ever triggers.
    await wait(200);
    await send(fleet, 'busy', 'second');

    // If the first idle had triggered /help, we'd see "mock help" text within
    // ~550ms of the first send.  We wait ~400ms total after the second send
    // (still less than a fresh debounce window after its own idle, so /help
    // shouldn't fire from round 2 either).
    await wait(400);

    const helpArrivals = seen.filter((e) => e.type === 'command-output' && /mock help/.test(e.text ?? ''));
    expect(helpArrivals.length).toBe(0);

    // Now wait long enough for round 2's idle+debounce to actually elapse;
    // /help should fire from that one.
    await wait(500);

    const helpArrivalsAfter = seen.filter((e) => e.type === 'command-output' && /mock help/.test(e.text ?? ''));
    expect(helpArrivalsAfter.length).toBeGreaterThan(0);

    await fleet.stop();
  }, 30_000);

  test('recipe schema validation: onIdle.command must be non-empty string', async () => {
    const { validateRecipe } = await import('../src/recipe.js');

    expect(() => validateRecipe({
      name: 'x',
      agent: { systemPrompt: 'x' },
      modules: { fleet: { children: [{ name: 'a', recipe: 'r.json', onIdle: {} }] } },
    })).toThrow(/command must be a non-empty string/);

    expect(() => validateRecipe({
      name: 'x',
      agent: { systemPrompt: 'x' },
      modules: { fleet: { children: [{ name: 'a', recipe: 'r.json', onIdle: { command: '/newtopic', debounceMs: -1 } }] } },
    })).toThrow(/debounceMs must be a positive number/);

    expect(() => validateRecipe({
      name: 'x',
      agent: { systemPrompt: 'x' },
      modules: { fleet: { children: [{ name: 'a', recipe: 'r.json', onIdle: 'oops' }] } },
    })).toThrow(/onIdle must be an object/);

    expect(() => validateRecipe({
      name: 'x',
      agent: { systemPrompt: 'x' },
      modules: { fleet: { children: [{ name: 'a', recipe: 'r.json', onIdle: { command: '/newtopic', debounceMs: 60000 } }] } },
    })).not.toThrow();
  });

  test('pending timer is cleared when child is killed', async () => {
    const fleet = new FleetModule({
      childIndexPath: MOCK_CHILD_PATH,
      autoStart: [{
        name: 'victim',
        recipe: 'mock',
        dataDir: join(tmpDir, 'victim'),
        onIdle: { command: '/help', debounceMs: 5_000 },  // long enough we'd see a stuck timer
      }],
      socketWaitTimeoutMs: 10_000,
      readyTimeoutMs: 5_000,
      gracefulShutdownMs: 3_000,
      sigtermEscalationMs: 1_000,
    });

    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    for (let t = 0; t < 50; t++) {
      if (fleet.getChildren().get('victim')?.status === 'ready') break;
      await wait(100);
    }

    // Arm the timer.
    await send(fleet, 'victim', 'work');
    await wait(100);

    // Kill; the timer should get cleared internally and not fire after.
    await fleet.handleToolCall({ id: 'k', name: 'kill', input: { name: 'victim' } });

    // No observable assertion here beyond "no throws, process tests terminate
    // cleanly without a dangling setTimeout keeping them open."  The onIdleTimer
    // is cleared in proc.on('exit') + stop(); if it weren't, bun test would
    // potentially hang at the end of this test.  We also check the child's
    // internal timer field reflects cleanup.
    const child = fleet.getChildren().get('victim');
    expect(child?.onIdleTimer).toBeNull();

    await fleet.stop();
  }, 15_000);
});
