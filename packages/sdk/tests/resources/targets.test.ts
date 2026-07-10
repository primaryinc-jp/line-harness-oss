import { describe, it, expect, vi } from 'vitest'
import { TargetsResource } from '../../src/resources/targets.js'
import type { HttpClient } from '../../src/http.js'

function mockHttp(overrides: Partial<HttpClient> = {}): HttpClient {
  return { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), ...overrides } as unknown as HttpClient
}

const emptyList = { items: [], total: 0, limit: 50, offset: 0 }

describe('TargetsResource', () => {
  it('list() no params calls GET /api/targets', async () => {
    const http = mockHttp({ get: vi.fn().mockResolvedValue({ success: true, data: emptyList }) })
    const resource = new TargetsResource(http)
    const result = await resource.list()
    expect(http.get).toHaveBeenCalledWith('/api/targets')
    expect(result).toEqual(emptyList)
  })

  it('list() applies defaultAccountId when no lineAccountId param is given', async () => {
    const http = mockHttp({ get: vi.fn().mockResolvedValue({ success: true, data: emptyList }) })
    const resource = new TargetsResource(http, 'acc_default')
    await resource.list({ type: 'group' })
    expect(http.get).toHaveBeenCalledWith('/api/targets?type=group&lineAccountId=acc_default')
  })

  it('list() explicit lineAccountId overrides defaultAccountId', async () => {
    const http = mockHttp({ get: vi.fn().mockResolvedValue({ success: true, data: emptyList }) })
    const resource = new TargetsResource(http, 'acc_default')
    await resource.list({ lineAccountId: 'acc_explicit' })
    expect(http.get).toHaveBeenCalledWith('/api/targets?lineAccountId=acc_explicit')
  })

  it('list() with metadata filters builds ?metadata.key=value', async () => {
    const http = mockHttp({ get: vi.fn().mockResolvedValue({ success: true, data: emptyList }) })
    const resource = new TargetsResource(http)
    await resource.list({ metadata: { salesCustomerPageId: 'cust-1' }, limit: 10, offset: 20 })
    expect(http.get).toHaveBeenCalledWith('/api/targets?metadata.salesCustomerPageId=cust-1&limit=10&offset=20')
  })

  it('getConversation() calls GET /api/conversations/:targetType/:targetId', async () => {
    const data = { target: {}, messages: [] }
    const http = mockHttp({ get: vi.fn().mockResolvedValue({ success: true, data }) })
    const resource = new TargetsResource(http)
    const result = await resource.getConversation('group', 'Cg1', { limit: 30 })
    expect(http.get).toHaveBeenCalledWith('/api/conversations/group/Cg1?limit=30')
    expect(result).toEqual(data)
  })

  it('sendMessage() posts to /api/targets/:targetType/:targetId/messages', async () => {
    const http = mockHttp({ post: vi.fn().mockResolvedValue({ success: true, data: { messageId: 'm1' } }) })
    const resource = new TargetsResource(http)
    const result = await resource.sendMessage('room', 'Cr1', 'hello')
    expect(http.post).toHaveBeenCalledWith('/api/targets/room/Cr1/messages', {
      messageType: 'text',
      content: 'hello',
    })
    expect(result).toEqual({ messageId: 'm1' })
  })

  it('sendMessage() passes trackLinks through to the worker', async () => {
    const http = mockHttp({ post: vi.fn().mockResolvedValue({ success: true, data: { messageId: 'm1' } }) })
    const resource = new TargetsResource(http)
    await resource.sendMessage('group', 'Cg1', 'https://example.com', 'text', undefined, undefined, { trackLinks: false })
    expect(http.post).toHaveBeenCalledWith('/api/targets/group/Cg1/messages', {
      messageType: 'text',
      content: 'https://example.com',
      trackLinks: false,
    })
  })
})
