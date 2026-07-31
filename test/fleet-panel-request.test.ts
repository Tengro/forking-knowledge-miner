/**
 * FleetModule.requestPanel — the promise-based panel-op verb the WebUI's
 * fleet-scope routing rides on (WS panels and the HTTP ?scope= proxy).
 *
 * Uses the mock headless child, which answers panel-request with:
 *   op 'hang' → nothing (timeout path)
 *   op 'fail' → {ok:false, error, status:418} (error passthrough)
 *   others    → {ok:true, data:{op, echo:params}}
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetModule, type FleetModuleConfig } from '../src/modules/fleet-module.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MOCK_CHILD_PATH = join(TEST_DIR, 'mock-headless-child.ts');

function makeFleet(overrides: Partial<FleetModuleConfig> = {}): FleetModule {
  return new FleetModule({
    childIndexPath: MOCK_CHILD_PATH,
    socketWaitTimeoutMs: 10_000,
    readyTimeoutMs: 5_000,
    gracefulShutdownMs: 3_000,
    sigtermEscalationMs: 1_000,
    ...overrides,
  });
}

describe('FleetModule.requestPanel', () => {
  let tmpDir: string;
  let fleet: FleetModule;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-panel-'));
    fleet = makeFleet();
    const res = await fleet.handleToolCall({
      id: 'launch-panelkid',
      name: 'launch',
      input: { name: 'panelkid', recipe: 'mock-recipe', dataDir: join(tmpDir, 'panelkid') },
    });
    if (!res.success) throw new Error(`launch failed: ${res.error}`);
  });

  afterAll(async () => {
    try { await fleet.stop(); } catch { /* noop */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('round-trips op + params and resolves the child data', async () => {
    const result = await fleet.requestPanel('panelkid', 'settings', { agent: 'clerk' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ op: 'settings', echo: { agent: 'clerk' } });
  });

  test('concurrent requests correlate independently', async () => {
    const [a, b] = await Promise.all([
      fleet.requestPanel('panelkid', 'health', { n: 1 }),
      fleet.requestPanel('panelkid', 'pins', { n: 2 }),
    ]);
    expect(a.ok).toBe(true);
    expect((a.data as { op: string }).op).toBe('health');
    expect(b.ok).toBe(true);
    expect((b.data as { op: string }).op).toBe('pins');
  });

  test('child-reported failure passes error and status through', async () => {
    const result = await fleet.requestPanel('panelkid', 'fail');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('mock failure');
    expect(result.status).toBe(418);
  });

  test('unanswered request resolves ok:false with 504 after timeoutMs', async () => {
    const started = Date.now();
    const result = await fleet.requestPanel('panelkid', 'hang', undefined, 400);
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(504);
    expect(result.error).toContain('timed out');
  });

  test('unknown child resolves ok:false with 404 without touching the wire', async () => {
    const result = await fleet.requestPanel('nobody', 'settings');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain('nobody');
  });
});
