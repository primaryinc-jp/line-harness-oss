import { afterEach, describe, expect, it, vi } from 'vitest'
// The deployed Pages Function intentionally lives in public/ as plain module JS.
// @ts-expect-error -- no declaration file is shipped with the runtime script.
import pagesWorker from '../../public/_worker.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('Pages admin API proxy', () => {
  it('forwards API method, query, headers, and body to the configured Worker', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        'https://__lh_worker_url__/api/auth/login?source=mobile',
      )
      expect(request.method).toBe('POST')
      expect(request.headers.get('cookie')).toBe('lh_admin_session=session-key')
      expect(await request.json()).toEqual({ apiKey: 'secret' })
      return new Response('{"success":true}', {
        headers: { 'Set-Cookie': 'lh_admin_session=session-key; HttpOnly; Secure' },
      })
    })
    globalThis.fetch = fetchMock as typeof fetch

    const request = new Request(
      'https://admin.pages.dev/api/auth/login?source=mobile',
      {
        method: 'POST',
        headers: {
          Cookie: 'lh_admin_session=session-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ apiKey: 'secret' }),
      },
    )
    const response = await pagesWorker.fetch(request, {
      ASSETS: { fetch: vi.fn() },
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(response.headers.get('set-cookie')).toContain('lh_admin_session=')
  })

  it('serves non-API paths from Pages static assets', async () => {
    const assetResponse = new Response('<html>admin</html>')
    const assetsFetch = vi.fn(async () => assetResponse)

    const response = await pagesWorker.fetch(
      new Request('https://admin.pages.dev/login'),
      { ASSETS: { fetch: assetsFetch } },
    )

    expect(response).toBe(assetResponse)
    expect(assetsFetch).toHaveBeenCalledOnce()
  })
})
