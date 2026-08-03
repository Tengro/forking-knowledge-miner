// Identity module (archipelago-home client) + the tools↔utilities surface
// flags on mcpl-admin and observers. See docs/home-node.md §4 and the af
// utils meta-tool (Module.getUtilities).
//
// Design under test: the AGENT surface is credential-free (status /
// accept_invite, no tokens in any result); credentials exist only on the
// HOST-facing API (accessFor/httpAuthFor) that the MCPL dial provider
// and HTTP helpers consume outside model context.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

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
  it('is utilities-only, and the agent surface never mentions or returns credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    const mod = new IdentityModule({ keyPath: join(dir, 'identity-key.pem'), home: 'id.test' });
    expect(mod.getTools()).toEqual([]);
    expect(mod.getUtilities().map((u) => u.name)).toEqual(['status', 'accept_invite']);
    // Framing check: no crypto/credential vocabulary in agent-visible text.
    const visible = JSON.stringify(mod.getUtilities()).toLowerCase();
    for (const scary of ['token', 'key', 'sign', 'proof', 'ed25519', 'mint', 'bearer']) {
      expect(visible).not.toContain(scary);
    }

    const res = await mod.handleToolCall(call('status', {}));
    expect(res.success).toBe(true);
    const data = res.data as { registeredAs: unknown; note: string };
    expect(data.registeredAs).toBe(null);
    expect(data.note).toContain('invitation code');
    expect(JSON.stringify(res.data)).not.toContain('ed25519'); // key exists on disk, not in results
    expect(existsSync(join(dir, 'identity-key.pem'))).toBe(true);
  });

  it('accept_invite registers, echoes NO credential, and is one-time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    let seen: any = null;
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      fetchImpl: fakeHome({
        '/enroll': (body) => {
          seen = body;
          return { status: 200, json: { sub: 'agent:ferro@guest', token: 'aid1.SECRET.x' } };
        },
      }),
    });
    const res = await mod.handleToolCall(call('accept_invite', { invite: 'inv_1', name: 'Ferro' }));
    expect(res.success).toBe(true);
    expect((res.data as any).id).toBe('agent:ferro@guest');
    // The home node's response token must NOT reach the agent.
    expect(JSON.stringify(res.data)).not.toContain('aid1.');

    // Wire-level: the signed statement is the spec's, verifiable by the module's own key.
    const raw = Buffer.from(seen.id.slice('ed25519:'.length), 'base64url');
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
      format: 'der', type: 'spki',
    });
    const statement = `archipelago-enroll|v1|id.test|inv_1|${seen.timestamp}`;
    expect(cryptoVerify(null, Buffer.from(statement), key, Buffer.from(seen.proof, 'base64url'))).toBe(true);

    const rec = JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8'));
    expect(rec.sub).toBe('agent:ferro@guest');

    const again = await mod.handleToolCall(call('accept_invite', { invite: 'inv_2', name: 'Ferro2' }));
    expect(again.success).toBe(false);
    expect(again.error).toContain('Already registered');
  });

  it('host-facing accessFor: requires registration, then exchanges per call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    let mints = 0;
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      defaultAudience: 'eidoverse',
      fetchImpl: fakeHome({
        '/enroll': () => ({ status: 200, json: { sub: 'agent:a@guest', token: 't0' } }),
        '/token': (body) => body.audience === 'eidoverse'
          ? { status: 200, json: { token: `aid1.fresh.${++mints}` } }
          : { status: 400, json: { error: 'unknown audience' } },
      }),
    });
    await expect(mod.accessFor()).rejects.toThrow(/not registered/);

    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));
    expect(await mod.accessFor()).toBe('aid1.fresh.1');
    expect(await mod.accessFor('eidoverse')).toBe('aid1.fresh.2'); // fresh per call — dial-time rotation
    expect((await mod.httpAuthFor()).authorization).toBe('Bearer aid1.fresh.3');
    await expect(mod.accessFor('nope')).rejects.toThrow(/unknown audience/);
    expect(mod.isEnrolled()).toBe(true);
    expect(mod.sub()).toBe('agent:a@guest');
  });
});

describe('mcpl-admin access grants', () => {
  it('deploy with `access` requires identity wiring, and stores the NAME not a credential', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpl-'));
    const mod = new McplAdminModule({ overlayPath: join(dir, 'overlay.json') });
    // stub framework so the deploy reaches the access check
    mod.setFramework({
      listMcplServers: () => [],
      connectMcplServer: async () => {},
      restartMcplServer: async () => {},
      disconnectMcplServer: async () => {},
    } as any);

    // no identity wired → clear bounce
    const refused = await mod.handleToolCall(call('mcpl_deploy', {
      id: 'worlds', url: 'wss://example.test/mcpl', access: 'eidoverse',
    }) as any);
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('identity');
  });

  it('surface flags: default keeps four first-class tools; utilities parks them', () => {
    const asTools = new McplAdminModule({});
    expect(asTools.getTools().length).toBe(4);
    expect(asTools.getUtilities().length).toBe(0);

    const asUtils = new McplAdminModule({ surface: 'utilities' });
    expect(asUtils.getTools().length).toBe(0);
    expect(asUtils.getUtilities().map((u) => u.name).sort()).toEqual(
      ['mcpl_deploy', 'mcpl_list', 'mcpl_restart', 'mcpl_unload'],
    );
  });
});

describe('observers surface flag', () => {
  it('same definitions on either surface', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-'));
    const asTools = new ObserversModule({ path: join(dir, 'observers.json') });
    const asUtils = new ObserversModule({ path: join(dir, 'observers.json'), surface: 'utilities' });
    expect(asTools.getTools().map((t) => t.name)).toEqual(asUtils.getUtilities().map((u) => u.name));
    expect(asTools.getUtilities().length).toBe(0);
    expect(asUtils.getTools().length).toBe(0);
  });
});
