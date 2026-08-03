/**
 * Agent identity — the agent's own archipelago-home principal (connectome
 * docs/home-node.md §4).
 *
 * Two audiences, deliberately separated:
 *
 * HOST-FACING (this module's public methods): the deployment holds an
 * ed25519 keypair in the data dir; `accessFor(audience)` exchanges a
 * key-proof at the home node for a short-lived aid1 token, and
 * `httpAuthFor(audience)` wraps it for HTTP. This is plumbing other host
 * pieces call — the MCPL transport's per-dial credential provider, future
 * HTTP helpers. Credentials live and die HERE.
 *
 * AGENT-FACING (utilities, via the `utils` meta-tool): deliberately small
 * and deliberately boring — `status` ("who am I registered as, where is
 * that recognized") and `accept_invite` ("register with an invitation code
 * from your operator"). No tokens, keys, proofs, or signing in any
 * agent-visible name, description, or result: the agent asks for access by
 * name (`mcpl_deploy … access: "eidoverse"`); the host does the rest. This
 * is both hygiene (credentials never enter model context, so they never
 * enter chronicles, compression, or channels) and framing (an agent
 * narrating credential mechanics reads as exfiltration to safety
 * classifiers — so it simply never has them to narrate).
 *
 * Utilities-only module: enrollment is one-time; it costs no tool slots.
 * Wire statements per the home-node spec (archipelago-home
 * src/statements.ts is the source of truth — re-copy, don't fork).
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
  /** Audience assumed when none is named. */
  defaultAudience?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Persisted beside the key after a successful registration. */
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
          'Your registered identity: the name and id services know you by, and which ' +
          'identity service vouches for it. Access to networked places (worlds etc.) is ' +
          'managed by the host from this — you never handle credentials yourself.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'accept_invite',
        description:
          'Register with the identity service using an invitation code from your operator. ' +
          'One-time: it establishes the name services will know you by. After this, the ' +
          'host handles access automatically (e.g. mcpl_deploy with an `access` name).',
        inputSchema: {
          type: 'object',
          properties: {
            invite: { type: 'string', description: 'Invitation code from your operator.' },
            name: { type: 'string', description: 'The display name you want (must be unused).' },
          },
          required: ['invite', 'name'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case 'status':
          return this.status();
        case 'accept_invite':
          return await this.acceptInvite(call.input as { invite?: unknown; name?: unknown });
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

  // ────────────────────────────────────────────────────────────────────────
  // Host-facing API — credential plumbing. Nothing below ever reaches model
  // context; callers (MCPL dial provider, HTTP helpers) consume the values
  // outside the agent's view.
  // ────────────────────────────────────────────────────────────────────────

  /** True once this deployment holds a registered principal. */
  isEnrolled(): boolean {
    return this.record() !== null;
  }

  /** The registered principal id (`agent:<name>@<domain>`), if any. */
  sub(): string | null {
    return this.record()?.sub ?? null;
  }

  /**
   * Exchange a key-proof for a fresh aid1 token for `audience`. Called per
   * MCPL dial (connect + every reconnect) and by HTTP helpers — which is
   * what lets audience tokens be short-lived. Throws with an actionable
   * message when unregistered or refused.
   */
  async accessFor(audience?: string): Promise<string> {
    const aud = audience ?? this.config.defaultAudience;
    if (!aud) throw new Error('identity: no audience named and none configured');
    if (!this.record()) {
      throw new Error(
        `identity: not registered with ${this.config.home} — the agent needs to accept an operator invite first (utils run identity--accept_invite)`,
      );
    }
    const key = this.loadOrCreateKey();
    const timestamp = new Date().toISOString();
    const statement = `archipelago-token|v1|${this.config.home}|${aud}|${timestamp}`;
    const proof = cryptoSign(null, Buffer.from(statement, 'utf8'), key.privateKey).toString('base64url');
    const { status, json } = await this.post('/token', { id: key.id, audience: aud, timestamp, proof });
    if (status !== 200 || typeof json.token !== 'string') {
      throw new Error(`identity: ${this.config.home} refused access to "${aud}" (${status}): ${String(json.error ?? 'unknown')}`);
    }
    return json.token;
  }

  /** Authorization header for HTTP calls to an audience's API. */
  async httpAuthFor(audience?: string): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.accessFor(audience)}` };
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

  // ── agent-facing utilities ──

  private status(): ToolResult {
    // Key material is deliberately created lazily here too, so `status` is
    // always safe to call — but none of it surfaces in the result.
    this.loadOrCreateKey();
    const rec = this.record();
    return ok(
      rec
        ? {
            registeredAs: rec.name,
            id: rec.sub,
            recognizedBy: rec.home,
            since: rec.enrolledAt,
            note: 'Access to services is handled by the host automatically (e.g. mcpl_deploy with an `access` name).',
          }
        : {
            registeredAs: null,
            note: `Not registered with ${this.config.home} yet — ask your operator for an invitation code, then use accept_invite.`,
          },
    );
  }

  private async acceptInvite(input: { invite?: unknown; name?: unknown }): Promise<ToolResult> {
    if (typeof input.invite !== 'string' || typeof input.name !== 'string') {
      return fail('accept_invite needs { invite, name }');
    }
    const existing = this.record();
    if (existing) {
      return fail(`Already registered as "${existing.name}" (${existing.sub}) — registration is one-time.`);
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
      return fail(`Registration refused (${status}): ${String(json.error ?? 'unknown')}`);
    }
    this.saveRecord({ sub: json.sub, name: input.name, home: this.config.home, enrolledAt: timestamp });
    // Note what is NOT returned: the first token the home node minted. The
    // host fetches its own, fresh, per use — the agent never holds one.
    return ok({
      registeredAs: input.name,
      id: json.sub,
      recognizedBy: this.config.home,
      note: 'Done — the host now handles access for you automatically.',
    });
  }
}
