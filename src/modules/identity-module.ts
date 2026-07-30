/**
 * Agent identity — the agent's own archipelago-home principal (connectome
 * docs/home-node.md §4). An ed25519 keypair generated in the agent's data
 * dir IS the identity; the home node binds it to a name via an operator
 * invite, and thereafter the agent exchanges key-proofs for fresh short
 * aid1 tokens itself — no human in the renewal loop, nothing bearer-shaped
 * at rest.
 *
 * Deliberately a utilities-only module (Module.getUtilities): enrollment
 * happens once and token refresh maybe weekly — this must not tax every
 * inference with schemas. Reached via `utils`:
 *
 *   utils run identity--status
 *   utils run identity--enroll {invite: "inv_…", name: "Fable"}
 *   utils run identity--token  {audience: "eidoverse"}
 *
 * The wire statements are the home-node spec's, inlined here (spec-stable;
 * archipelago-home src/statements.ts is the source of truth — re-copy, do
 * not fork semantics).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import type {
  Module,
  ModuleContext,
  ToolCall,
  ToolResult,
  ToolDefinition,
} from '@animalabs/agent-framework';

export interface IdentityModuleConfig {
  /** ed25519 PKCS#8 PEM, generated on first use, 0600. dataDir-anchored:
   *  identity is per-deployment, not per-session. */
  keyPath: string;
  /** Home node domain (the trust anchor), e.g. `id.animalabs.ai`. */
  home: string;
  /** Audience assumed when `token` is called without one. */
  defaultAudience?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Persisted beside the key after a successful enroll. */
interface IdentityRecord {
  sub: string;
  name: string;
  home: string;
  enrolledAt: string;
}

function ok(data: unknown): ToolResult {
  return { success: true, data };
}
function fail(text: string): ToolResult {
  return { success: false, error: text, isError: true };
}

export class IdentityModule implements Module {
  readonly name = 'identity';
  private readonly recordPath: string;

  constructor(private readonly config: IdentityModuleConfig) {
    this.recordPath = config.keyPath.replace(/\.pem$/, '') + '.json';
  }

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return []; // utilities-only, by design — see module header
  }

  getUtilities(): ToolDefinition[] {
    return [
      {
        name: 'status',
        description:
          'Your archipelago identity: key fingerprint, home node, and enrollment (sub) if any. ' +
          'Generates your keypair on first call if none exists.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'enroll',
        description:
          'Claim an operator-issued invite code: binds your key to a durable principal at the ' +
          'home node (sub like agent:<name>@guest) and returns your first token. One-time; ' +
          'thereafter use `token` for fresh credentials.',
        inputSchema: {
          type: 'object',
          properties: {
            invite: { type: 'string', description: 'Invite code from the operator.' },
            name: { type: 'string', description: 'Desired display name (uniqueness enforced by the home node).' },
          },
          required: ['invite', 'name'],
        },
      },
      {
        name: 'token',
        description:
          'Exchange a key-proof for a fresh aid1 identity token for an audience (e.g. ' +
          '"eidoverse"). Use the returned token wherever that service takes one — e.g. ' +
          'mcpl_deploy url "wss://…/mcpl?token=<it>". Requires prior enrollment.',
        inputSchema: {
          type: 'object',
          properties: {
            audience: { type: 'string', description: 'Audience id. Defaults to the recipe-configured one.' },
          },
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case 'status':
          return this.status();
        case 'enroll':
          return await this.enroll(call.input as { invite?: unknown; name?: unknown });
        case 'token':
          return await this.token(call.input as { audience?: unknown });
        default:
          return fail(`Unknown identity utility: ${call.name}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  async onProcess(): Promise<Record<string, never>> {
    return {};
  }

  // ── key material ──

  private loadOrCreateKey(): { privateKey: KeyObject; id: string } {
    let privateKey: KeyObject;
    if (existsSync(this.config.keyPath)) {
      privateKey = createPrivateKey(readFileSync(this.config.keyPath, 'utf8'));
    } else {
      privateKey = generateKeyPairSync('ed25519').privateKey;
      mkdirSync(dirname(this.config.keyPath), { recursive: true });
      writeFileSync(this.config.keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    }
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
    return { privateKey, id: `ed25519:${spki.subarray(spki.length - 32).toString('base64url')}` };
  }

  private record(): IdentityRecord | null {
    try {
      return JSON.parse(readFileSync(this.recordPath, 'utf8')) as IdentityRecord;
    } catch {
      return null;
    }
  }

  private saveRecord(rec: IdentityRecord): void {
    writeFileSync(this.recordPath + '.tmp', JSON.stringify(rec, null, 2) + '\n');
    renameSync(this.recordPath + '.tmp', this.recordPath);
  }

  private async post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const f = this.config.fetchImpl ?? fetch;
    const res = await f(`https://${this.config.home}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  // ── utilities ──

  private status(): ToolResult {
    const key = this.loadOrCreateKey();
    const rec = this.record();
    return ok({
      key: key.id,
      home: this.config.home,
      enrolled: rec ? { sub: rec.sub, name: rec.name, enrolledAt: rec.enrolledAt } : null,
      hint: rec
        ? 'Use `token` for fresh audience credentials.'
        : 'Not enrolled — ask your operator for an invite code, then run `enroll`.',
    });
  }

  private async enroll(input: { invite?: unknown; name?: unknown }): Promise<ToolResult> {
    if (typeof input.invite !== 'string' || typeof input.name !== 'string') {
      return fail('enroll needs { invite, name }');
    }
    const existing = this.record();
    if (existing) {
      return fail(`Already enrolled as ${existing.sub} — enrollment is one-time (a new invite mints a NEW principal).`);
    }
    const key = this.loadOrCreateKey();
    const timestamp = new Date().toISOString();
    const statement = `archipelago-enroll|v1|${this.config.home}|${input.invite}|${timestamp}`;
    const proof = cryptoSign(null, Buffer.from(statement, 'utf8'), key.privateKey).toString('base64url');
    const { status, json } = await this.post('/enroll', {
      invite: input.invite,
      id: key.id,
      name: input.name,
      timestamp,
      proof,
    });
    if (status !== 200 || typeof json.sub !== 'string') {
      return fail(`Enrollment refused (${status}): ${String(json.error ?? 'unknown')}`);
    }
    this.saveRecord({ sub: json.sub, name: input.name, home: this.config.home, enrolledAt: timestamp });
    return ok({ sub: json.sub, token: json.token, note: 'Enrolled. Your key is your identity now; use `token` to renew.' });
  }

  private async token(input: { audience?: unknown }): Promise<ToolResult> {
    const audience = typeof input.audience === 'string' ? input.audience : this.config.defaultAudience;
    if (!audience) return fail('No audience given and none configured — pass { audience }.');
    if (!this.record()) return fail('Not enrolled — run `enroll` with an operator invite first (see `status`).');
    const key = this.loadOrCreateKey();
    const timestamp = new Date().toISOString();
    const statement = `archipelago-token|v1|${this.config.home}|${audience}|${timestamp}`;
    const proof = cryptoSign(null, Buffer.from(statement, 'utf8'), key.privateKey).toString('base64url');
    const { status, json } = await this.post('/token', { id: key.id, audience, timestamp, proof });
    if (status !== 200 || typeof json.token !== 'string') {
      return fail(`Token refused (${status}): ${String(json.error ?? 'unknown')}`);
    }
    return ok({ audience, token: json.token });
  }
}
