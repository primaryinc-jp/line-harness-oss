import { describe, it, expect } from 'vitest';
import { resolveState } from '../src/commands/update.js';

const WORKER_URL = 'https://line-harness.acc.workers.dev';

/** A complete config as written by current setup.ts (worker-assets install). */
function workerAssetsConfig() {
  return {
    projectName: 'line-harness',
    workerName: 'line-harness',
    cfAccountId: 'a'.repeat(32),
    cfApiToken: 'tok',
    d1DatabaseId: 'd1id',
    adminProject: 'line-harness-admin-abc123',
    adminPublicUrl: 'https://line-harness-admin-abc123.pages.dev',
    workerPublicUrl: WORKER_URL,
    // setup.ts intentionally omits liffProject and points liffPublicUrl at
    // the Worker (LIFF is served from Worker assets).
    liffPublicUrl: WORKER_URL,
  };
}

describe('resolveState — LIFF topology', () => {
  it('resolves a worker-assets install (no liffProject, liffPublicUrl == workerPublicUrl) without prompting', () => {
    const r = resolveState(workerAssetsConfig(), undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.liffProject).toBe('');
    expect(r.value.liffPublicUrl).toBe('');
  });

  it('resolves a worker-assets install when liffPublicUrl is absent entirely', () => {
    const cfg = workerAssetsConfig() as Record<string, unknown>;
    delete cfg.liffPublicUrl;
    const r = resolveState(cfg, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.liffProject).toBe('');
  });

  it('treats an explicitly-empty liffProject as "no LIFF Pages" (persisted prompt answer)', () => {
    const r = resolveState({ ...workerAssetsConfig(), liffProject: '' }, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.liffProject).toBe('');
    expect(r.value.liffPublicUrl).toBe('');
  });

  it('keeps the legacy 3-artifact topology when liffProject is present', () => {
    const r = resolveState(
      {
        ...workerAssetsConfig(),
        liffProject: 'lh-liff-abc123',
        liffPublicUrl: 'https://lh-liff-abc123.pages.dev',
      },
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.liffProject).toBe('lh-liff-abc123');
    expect(r.value.liffPublicUrl).toBe('https://lh-liff-abc123.pages.dev');
  });

  it('still asks for liffProject when a distinct LIFF URL exists without a project name', () => {
    const r = resolveState(
      {
        ...workerAssetsConfig(),
        liffPublicUrl: 'https://lh-liff-abc123.pages.dev',
      },
      undefined,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toContain('liffProject');
  });
});

describe('resolveState — credentials and legacy fallbacks', () => {
  it('falls back to the CLOUDFLARE_API_TOKEN env var', () => {
    const cfg = workerAssetsConfig() as Record<string, unknown>;
    delete cfg.cfApiToken;
    const withoutEnv = resolveState(cfg, undefined);
    expect(withoutEnv.ok).toBe(false);
    const withEnv = resolveState(cfg, 'env-token');
    expect(withEnv.ok).toBe(true);
    if (withEnv.ok) expect(withEnv.value.cfApiToken).toBe('env-token');
  });

  it('derives workerName / accountId / adminProject from legacy fields', () => {
    const r = resolveState(
      {
        projectName: 'line-harness',
        accountId: 'b'.repeat(32),
        cfApiToken: 'tok',
        d1DatabaseId: 'd1id',
        adminUrl: 'https://legacy-admin.pages.dev',
        workerUrl: WORKER_URL,
      },
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.workerName).toBe('line-harness');
    expect(r.value.cfAccountId).toBe('b'.repeat(32));
    expect(r.value.adminProject).toBe('legacy-admin');
    expect(r.value.workerPublicUrl).toBe(WORKER_URL);
    // No liffPublicUrl at all → worker-assets resolution.
    expect(r.value.liffProject).toBe('');
  });
});

// ─── normalizeLiffBindings ────────────────────────────────────────────────────

import { normalizeLiffBindings } from '../src/commands/update.js';

describe('normalizeLiffBindings', () => {
  const bindings = [
    { type: 'd1' as const, name: 'DB', database_id: 'd1id' },
    { type: 'plain_text' as const, name: 'LIFF_PAGES_PROJECT', text: 'line-harness-liff' },
    { type: 'plain_text' as const, name: 'WORKER_NAME', text: 'line-harness' },
    { type: 'assets' as const, name: 'ASSETS' },
  ];

  it('clears the stale LIFF_PAGES_PROJECT binding for worker-assets installs', () => {
    const out = normalizeLiffBindings(bindings, '');
    const liff = out.find((b) => b.name === 'LIFF_PAGES_PROJECT');
    expect(liff?.text).toBe('');
    // Everything else passes through untouched.
    expect(out.find((b) => b.name === 'WORKER_NAME')?.text).toBe('line-harness');
    expect(out.find((b) => b.name === 'ASSETS')?.type).toBe('assets');
  });

  it('sets the binding to the real project name for legacy Pages-LIFF installs', () => {
    const out = normalizeLiffBindings(bindings, 'lh-liff-abc123');
    expect(out.find((b) => b.name === 'LIFF_PAGES_PROJECT')?.text).toBe('lh-liff-abc123');
  });

  it('does not mutate the input array', () => {
    normalizeLiffBindings(bindings, '');
    expect(bindings.find((b) => b.name === 'LIFF_PAGES_PROJECT')?.text).toBe('line-harness-liff');
  });
});
