/**
 * Wire validation for the context-settings messages.
 *
 * These messages mutate a LIVE agent's context budget, so malformed payloads
 * must be rejected at the protocol edge rather than reaching
 * Agent.validateRuntimeSettingsPatch as strings/NaN/fractions.
 */

import { describe, it, expect } from 'bun:test';
import { isClientMessage } from '../src/web/protocol.js';

describe('settings messages — wire validation', () => {
  it('accepts a minimal budget update', () => {
    expect(isClientMessage({ type: 'settings-update', contextBudgetTokens: 120_000 })).toBe(true);
  });

  it('accepts tail-only and pace-only updates', () => {
    expect(isClientMessage({ type: 'settings-update', tailTokens: 30_000 })).toBe(true);
    expect(isClientMessage({ type: 'settings-update', transitionPaceTokens: 8_000 })).toBe(true);
  });

  it('accepts persist/notify flags and an agent name', () => {
    expect(isClientMessage({
      type: 'settings-update',
      contextBudgetTokens: 100_000,
      persist: false,
      notify: true,
      agent: 'mythos',
    })).toBe(true);
  });

  it('rejects an empty patch — it would throw downstream', () => {
    expect(isClientMessage({ type: 'settings-update' })).toBe(false);
    expect(isClientMessage({ type: 'settings-update', persist: true })).toBe(false);
  });

  it('rejects non-integer / non-positive / stringly token counts', () => {
    for (const bad of ['100000', 100.5, -1, 0, NaN, Infinity, null, {}]) {
      expect(isClientMessage({ type: 'settings-update', contextBudgetTokens: bad }))
        .toBe(false);
    }
  });

  it('rejects non-boolean flags and empty agent names', () => {
    expect(isClientMessage({ type: 'settings-update', contextBudgetTokens: 1, persist: 'yes' })).toBe(false);
    expect(isClientMessage({ type: 'settings-update', contextBudgetTokens: 1, notify: 1 })).toBe(false);
    expect(isClientMessage({ type: 'settings-update', contextBudgetTokens: 1, agent: '' })).toBe(false);
  });

  it('validates reset and cancel shapes', () => {
    expect(isClientMessage({ type: 'settings-reset' })).toBe(true);
    expect(isClientMessage({ type: 'settings-reset', keys: ['contextBudgetTokens'] })).toBe(true);
    expect(isClientMessage({ type: 'settings-reset', keys: 'contextBudgetTokens' })).toBe(false);
    expect(isClientMessage({ type: 'settings-cancel-transition' })).toBe(true);
    expect(isClientMessage({ type: 'settings-cancel-transition', persist: false })).toBe(true);
    expect(isClientMessage({ type: 'settings-cancel-transition', agent: 42 })).toBe(false);
  });

  it('validates request-settings', () => {
    expect(isClientMessage({ type: 'request-settings' })).toBe(true);
    expect(isClientMessage({ type: 'request-settings', agent: 'mythos' })).toBe(true);
    expect(isClientMessage({ type: 'request-settings', agent: 7 })).toBe(false);
  });
});
