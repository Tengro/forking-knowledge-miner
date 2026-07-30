// Identity module (archipelago-home client) + the tools↔utilities surface
// flags on mcpl-admin and observers. See docs/home-node.md §4 and the af
// utils meta-tool (Module.getUtilities).
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createPublicKey, verify as cryptoVerify } from 'node:crypto';

import { IdentityModule } from '../src/modules/identity-module.ts';
import { McplAdminModule } from '../src/modules/mcpl-admin-module.ts';
import { ObserversModule } from '../src/modules/observers-module.ts';

const call = (name: string, input: unknown) => ({ id: 't1', name, input });

function fakeHome(routes: Record<string, (body: any) => { status: number; json: unknown }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const handler = routes[path];
    if (!handler) return new Response('{}', { status: 404 });
    const body = JSON.parse(String(init?.body ?? '{}'));
    const { status, json } = handler(body);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
}

describe('identity module', () => {
  it('is utilities-only and status mints a 0600 keypair on first use', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    const mod = new IdentityModule({ keyPath: join(dir, 'identity-key.pem'), home: 'id.test' });
    expect(mod.getTools()).toEqual([]);
    expect(mod.getUtilities().map((u) => u.name)).toEqual(['status', 'enroll', 'token']);

    const res = await mod.handleToolCall(call('status', {}));
    expect(res.success).toBe(true);
    const data = res.data as { key: string; enrolled: unknown };
    expect(data.key.startsWith('ed25519:')).toBe(true);
    expect(data.enrolled).toBe(null);
    expect(existsSync(join(dir, 'identity-key.pem'))).toBe(true);
  });

  it('enroll signs the spec statement, persists the record, and is one-time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    let seen: any = null;
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      fetchImpl: fakeHome({
        '/enroll': (body) => {
          seen = body;
          return { status: 200, json: { sub: 'agent:ferro@guest', token: 'aid1.x.y' } };
        },
      }),
    });
    const res = await mod.handleToolCall(call('enroll', { invite: 'inv_1', name: 'Ferro' }));
    expect(res.success).toBe(true);
    expect((res.data as any).sub).toBe('agent:ferro@guest');

    // proof verifies against the module's own key over the exact spec statement
    const raw = Buffer.from(seen.id.slice('ed25519:'.length), 'base64url');
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
      format: 'der', type: 'spki',
    });
    const statement = `archipelago-enroll|v1|id.test|inv_1|${seen.timestamp}`;
    expect(cryptoVerify(null, Buffer.from(statement), key, Buffer.from(seen.proof, 'base64url'))).toBe(true);

    const rec = JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8'));
    expect(rec.sub).toBe('agent:ferro@guest');

    const again = await mod.handleToolCall(call('enroll', { invite: 'inv_2', name: 'Ferro2' }));
    expect(again.success).toBe(false);
    expect(again.error).toContain('Already enrolled');
  });

  it('token requires enrollment, then exchanges a key-proof', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      defaultAudience: 'eidoverse',
      fetchImpl: fakeHome({
        '/enroll': () => ({ status: 200, json: { sub: 'agent:a@guest', token: 't0' } }),
        '/token': (body) => body.audience === 'eidoverse'
          ? { status: 200, json: { token: 'aid1.fresh.tok' } }
          : { status: 400, json: { error: 'unknown audience' } },
      }),
    });
    const early = await mod.handleToolCall(call('token', {}));
    expect(early.success).toBe(false);
    expect(early.error).toContain('Not enrolled');

    await mod.handleToolCall(call('enroll', { invite: 'i', name: 'A' }));
    const res = await mod.handleToolCall(call('token', {}));
    expect(res.success).toBe(true);
    expect((res.data as any).token).toBe('aid1.fresh.tok');

    const refused = await mod.handleToolCall(call('token', { audience: 'nope' }));
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('unknown audience');
  });
});

describe('surface flags', () => {
  it('mcpl-admin: default keeps four first-class tools; utilities parks them', () => {
    const asTools = new McplAdminModule({});
    expect(asTools.getTools().length).toBe(4);
    expect(asTools.getUtilities().length).toBe(0);

    const asUtils = new McplAdminModule({ surface: 'utilities' });
    expect(asUtils.getTools().length).toBe(0);
    expect(asUtils.getUtilities().map((u) => u.name).sort()).toEqual(
      ['mcpl_deploy', 'mcpl_list', 'mcpl_restart', 'mcpl_unload'],
    );
  });

  it('observers: same flag, same definitions either way', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-'));
    const asTools = new ObserversModule({ path: join(dir, 'observers.json') });
    const asUtils = new ObserversModule({ path: join(dir, 'observers.json'), surface: 'utilities' });
    expect(asTools.getTools().map((t) => t.name)).toEqual(asUtils.getUtilities().map((u) => u.name));
    expect(asTools.getUtilities().length).toBe(0);
    expect(asUtils.getTools().length).toBe(0);
  });
});
