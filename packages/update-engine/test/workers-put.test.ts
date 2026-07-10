import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { putWorkerScript, type WorkerBinding } from '../src/cf-api/workers.js';

const creds = { accountId: 'acc', apiToken: 'tok' };

const BINDINGS: WorkerBinding[] = [
  { type: 'd1', name: 'DB', database_id: 'd1id' },
  { type: 'assets', name: 'ASSETS' },
];

/** Capture the metadata part of the multipart PUT body as parsed JSON. */
async function capturedMetadata(
  fetchMock: ReturnType<typeof vi.fn>,
): Promise<Record<string, unknown>> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const fd = init.body as FormData;
  const blob = fd.get('metadata') as Blob;
  return JSON.parse(await blob.text()) as Record<string, unknown>;
}

describe('putWorkerScript metadata', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('omits keep_assets and compatibility_flags by default (legacy call shape)', async () => {
    await putWorkerScript({
      creds,
      scriptName: 'w',
      scriptContent: Buffer.from('export default {}'),
      bindings: BINDINGS,
    });

    const metadata = await capturedMetadata(fetchMock);
    expect(metadata.main_module).toBe('worker.js');
    expect(metadata.compatibility_date).toBe('2024-12-01');
    expect(metadata.bindings).toEqual(BINDINGS);
    expect(metadata).not.toHaveProperty('keep_assets');
    expect(metadata).not.toHaveProperty('compatibility_flags');
  });

  it('sends keep_assets + compatibility_flags when requested', async () => {
    await putWorkerScript({
      creds,
      scriptName: 'w',
      scriptContent: Buffer.from('export default {}'),
      bindings: BINDINGS,
      keepAssets: true,
      compatibilityFlags: ['nodejs_compat'],
    });

    const metadata = await capturedMetadata(fetchMock);
    expect(metadata.keep_assets).toBe(true);
    expect(metadata.compatibility_flags).toEqual(['nodejs_compat']);
  });

  it('omits compatibility_flags when the list is empty', async () => {
    await putWorkerScript({
      creds,
      scriptName: 'w',
      scriptContent: Buffer.from('export default {}'),
      bindings: [],
      compatibilityFlags: [],
    });

    const metadata = await capturedMetadata(fetchMock);
    expect(metadata).not.toHaveProperty('compatibility_flags');
  });

  it('uploads the script bytes unchanged as the worker.js module part', async () => {
    const script = Buffer.from('export default {fetch(){}}');
    await putWorkerScript({
      creds,
      scriptName: 'w',
      scriptContent: script,
      bindings: [],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const fd = init.body as FormData;
    const blob = fd.get('worker.js') as Blob;
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(script);
    expect(blob.type).toBe('application/javascript+module');
  });
});
