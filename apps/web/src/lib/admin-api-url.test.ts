import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadModule() {
  vi.resetModules()
  return import('./admin-api-url')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('adminApiUrl', () => {
  it('uses same-origin paths when the Pages proxy is enabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://example.workers.dev')
    vi.stubEnv('NEXT_PUBLIC_ADMIN_API_PROXY', 'true')

    const { adminApiUrl } = await loadModule()

    expect(adminApiUrl('/api/auth/session')).toBe('/api/auth/session')
    expect(adminApiUrl('admin/version')).toBe('/admin/version')
  })

  it('uses the Worker origin when the proxy is disabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://example.workers.dev/')
    vi.stubEnv('NEXT_PUBLIC_ADMIN_API_PROXY', 'false')

    const { adminApiUrl } = await loadModule()

    expect(adminApiUrl('/api/friends')).toBe(
      'https://example.workers.dev/api/friends',
    )
  })
})
