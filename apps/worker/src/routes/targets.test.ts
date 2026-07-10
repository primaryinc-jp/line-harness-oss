import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock @line-crm/db — the routes' responsibility is "resolve target →
// call DB helper / LINE client with correct args", so capturing those
// args is the meaningful assertion (same style as line-accounts.test.ts).
const dbMocks = {
  getLineTargetById: vi.fn(),
  getLineTargetByLineTargetId: vi.fn(),
  listLineTargets: vi.fn(),
  updateLineTargetMetadata: vi.fn(),
  getTargetMessages: vi.fn(),
  getTargetParticipants: vi.fn(),
  logTargetMessage: vi.fn(),
  getLineAccountById: vi.fn(),
  getStaffById: vi.fn(),
  jstNow: vi.fn(() => '2026-07-06T12:00:00.000'),
};
vi.mock('@line-crm/db', () => dbMocks);

const pushMessage = vi.fn().mockResolvedValue({});
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({ pushMessage })),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn((type: string, content: string) =>
    type === 'text' ? { type: 'text', text: content } : { type, content },
  ),
  messageToLogPayload: vi.fn((m: { type: string; text?: string; content?: string }) =>
    m.type === 'text'
      ? { messageType: 'text', content: m.text }
      : { messageType: m.type, content: m.content },
  ),
}));

vi.mock('../services/auto-track.js', () => ({
  autoTrackContent: vi.fn(async (_db: unknown, messageType: string, content: string) => ({
    messageType,
    content,
  })),
}));

const { targets } = await import('./targets.js');

type TestEnv = {
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } };
  Bindings: { DB: D1Database; LINE_CHANNEL_ACCESS_TOKEN: string; WORKER_URL?: string };
};

function setupApp(role: 'owner' | 'admin' | 'staff' = 'owner') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', name: 'テスト', role });
    c.env = {
      DB: {} as D1Database,
      LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
      WORKER_URL: 'https://worker.example.com',
    } as TestEnv['Bindings'];
    await next();
  });
  app.route('/', targets);
  return app;
}

const groupTarget = {
  id: 'tgt-1',
  target_type: 'group' as const,
  line_target_id: 'Cabcdef0123456789',
  display_name: '田中家 物件相談',
  picture_url: null,
  is_active: 1,
  line_account_id: 'acc-1',
  metadata: JSON.stringify({ salesCustomerPageId: 'notion-page-1' }),
  last_message_at: '2026-07-06T10:00:00.000',
  created_at: '2026-07-01T09:00:00.000',
  updated_at: '2026-07-06T10:00:00.000',
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.jstNow.mockReturnValue('2026-07-06T12:00:00.000');
  // Staff resolution used by resolveMessageSender (default: send as self)
  dbMocks.getStaffById.mockResolvedValue({ id: 'test-staff', name: 'テスト', is_active: 1, icon_url: null });
});

describe('GET /api/targets', () => {
  test('returns serialized target list with sales metadata', async () => {
    dbMocks.listLineTargets.mockResolvedValue({ items: [groupTarget], total: 1 });

    const app = setupApp();
    const res = await app.request('/api/targets?type=group&limit=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { items: Array<Record<string, unknown>>; total: number } };
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(1);
    expect(body.data.items[0]).toMatchObject({
      id: 'tgt-1',
      targetType: 'group',
      targetId: 'Cabcdef0123456789',
      displayName: '田中家 物件相談',
      lastMessageAt: '2026-07-06T10:00:00.000',
      metadata: { salesCustomerPageId: 'notion-page-1' },
    });
    expect(dbMocks.listLineTargets).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetType: 'group',
      limit: 10,
    }));
  });

  test('forwards ?metadata.key=value filters for customer reverse lookup', async () => {
    dbMocks.listLineTargets.mockResolvedValue({ items: [groupTarget], total: 1 });

    const app = setupApp();
    const res = await app.request('/api/targets?metadata.salesCustomerPageId=notion-page-1&metadata.salesDealPageId=deal-9');
    expect(res.status).toBe(200);
    expect(dbMocks.listLineTargets).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      metadataFilters: {
        salesCustomerPageId: 'notion-page-1',
        salesDealPageId: 'deal-9',
      },
    }));
  });

  test('rejects unsupported type', async () => {
    const app = setupApp();
    const res = await app.request('/api/targets?type=friend');
    expect(res.status).toBe(400);
  });

  test('rejects out-of-range or non-numeric pagination with 400', async () => {
    const app = setupApp();
    // negative LIMIT means "unbounded" in SQLite, NaN is a D1 binding error —
    // neither may reach the DB layer
    for (const qs of ['limit=-1', 'limit=0', 'limit=201', 'limit=abc', 'offset=-5', 'offset=x']) {
      const res = await app.request(`/api/targets?${qs}`);
      expect(res.status, qs).toBe(400);
      expect(dbMocks.listLineTargets).not.toHaveBeenCalled();
    }
  });

  test('serves a fallback display name when the group name is unknown', async () => {
    dbMocks.listLineTargets.mockResolvedValue({
      items: [{ ...groupTarget, display_name: null }],
      total: 1,
    });
    const app = setupApp();
    const res = await app.request('/api/targets');
    const body = (await res.json()) as { data: { items: Array<{ displayName: string }> } };
    expect(body.data.items[0].displayName).toContain('LINEグループ');
  });
});

describe('GET /api/targets/:targetType/:targetId', () => {
  test('resolves by LINE group id and includes participants', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(groupTarget);
    dbMocks.getTargetParticipants.mockResolvedValue([
      { lineUserId: 'U1', displayName: '田中太郎', lastSpokeAt: '2026-07-06T10:00:00.000' },
    ]);

    const app = setupApp();
    const res = await app.request('/api/targets/group/Cabcdef0123456789');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { targetId: string; participants: unknown[] } };
    expect(body.data.targetId).toBe('Cabcdef0123456789');
    expect(body.data.participants).toHaveLength(1);
  });

  test('falls back to harness row id lookup', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(null);
    dbMocks.getLineTargetById.mockResolvedValue(groupTarget);
    dbMocks.getTargetParticipants.mockResolvedValue([]);

    const app = setupApp();
    const res = await app.request('/api/targets/group/tgt-1');
    expect(res.status).toBe(200);
    expect(dbMocks.getLineTargetById).toHaveBeenCalledWith(expect.anything(), 'tgt-1');
  });

  test('404 when target type mismatches', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(groupTarget);
    const app = setupApp();
    const res = await app.request('/api/targets/room/Cabcdef0123456789');
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/targets/:targetType/:targetId/metadata', () => {
  test('merges new fields into existing metadata', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(groupTarget);
    dbMocks.getLineTargetById.mockResolvedValue({
      ...groupTarget,
      metadata: JSON.stringify({ salesCustomerPageId: 'notion-page-1', salesDealPageId: 'deal-9' }),
    });

    const app = setupApp();
    const res = await app.request('/api/targets/group/Cabcdef0123456789/metadata', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salesDealPageId: 'deal-9' }),
    });
    expect(res.status).toBe(200);

    const [, , mergedJson] = dbMocks.updateLineTargetMetadata.mock.calls[0];
    expect(JSON.parse(mergedJson as string)).toEqual({
      salesCustomerPageId: 'notion-page-1',
      salesDealPageId: 'deal-9',
    });
    const body = (await res.json()) as { data: { metadata: Record<string, unknown> } };
    expect(body.data.metadata.salesDealPageId).toBe('deal-9');
  });

  test('404 for unknown target', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(null);
    dbMocks.getLineTargetById.mockResolvedValue(null);
    const app = setupApp();
    const res = await app.request('/api/targets/group/Cunknown/metadata', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salesCustomerPageId: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/conversations/:targetType/:targetId', () => {
  test('returns target + messages in ascending order with sender attribution', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(groupTarget);
    dbMocks.getTargetMessages.mockResolvedValue([
      // DB helper returns DESC; route reverses to ASC
      {
        id: 'm2', target_id: 'tgt-1', direction: 'incoming', message_type: 'text',
        content: '内見できますか', sender_line_user_id: 'U1', sender_display_name: '田中太郎',
        source: 'user', line_account_id: 'acc-1', sender_staff_id: null, sender_name: null,
        sender_icon_url: null, created_at: '2026-07-06T10:00:00.000',
      },
      {
        id: 'm1', target_id: 'tgt-1', direction: 'outgoing', message_type: 'text',
        content: 'ご提案です', sender_line_user_id: null, sender_display_name: null,
        source: 'manual', line_account_id: 'acc-1', sender_staff_id: 'staff-1', sender_name: '営業担当',
        sender_icon_url: null, created_at: '2026-07-06T09:00:00.000',
      },
    ]);

    const app = setupApp();
    const res = await app.request('/api/conversations/group/Cabcdef0123456789?limit=50');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { target: { targetId: string }; messages: Array<{ id: string; senderDisplayName: string | null }> };
    };
    expect(body.data.target.targetId).toBe('Cabcdef0123456789');
    expect(body.data.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(body.data.messages[1].senderDisplayName).toBe('田中太郎');
  });

  test('rejects invalid limit with 400 before hitting the DB', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(groupTarget);
    const app = setupApp();
    const res = await app.request('/api/conversations/group/Cabcdef0123456789?limit=-1');
    expect(res.status).toBe(400);
    expect(dbMocks.getTargetMessages).not.toHaveBeenCalled();
  });
});

describe('POST /api/targets/:targetType/:targetId/messages', () => {
  test('pushes to the LINE group id and logs the outgoing message', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(groupTarget);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', channel_access_token: 'acc-token' });
    dbMocks.logTargetMessage.mockResolvedValue('log-1');

    const app = setupApp();
    const res = await app.request('/api/targets/group/Cabcdef0123456789/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '図面をお送りします', senderMode: 'official' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { messageId: string } };
    expect(body.data.messageId).toBe('log-1');

    expect(pushMessage).toHaveBeenCalledWith(
      'Cabcdef0123456789',
      [{ type: 'text', text: '図面をお送りします' }],
      undefined,
    );
    expect(dbMocks.logTargetMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetId: 'tgt-1',
      direction: 'outgoing',
      content: '図面をお送りします',
      source: 'manual',
      lineAccountId: 'acc-1',
    }));
  });

  test('logs the actually-pushed message, not the request body (text fallback case)', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(groupTarget);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', channel_access_token: 'acc-token' });
    dbMocks.logTargetMessage.mockResolvedValue('log-1');
    // Simulate buildMessage's broken-image fallback: the request said image,
    // but a text message was actually pushed to LINE
    const { buildMessage } = await import('../services/step-delivery.js');
    vi.mocked(buildMessage).mockReturnValueOnce({ type: 'text', text: 'not-json' });

    const app = setupApp();
    const res = await app.request('/api/targets/group/Cabcdef0123456789/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageType: 'image', content: 'not-json', senderMode: 'official' }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.logTargetMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      messageType: 'text',
      content: 'not-json',
    }));
  });

  test('tracked links are created under the target-owning account (multi-account)', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(groupTarget);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', channel_access_token: 'acc-token' });
    dbMocks.logTargetMessage.mockResolvedValue('log-1');
    const { autoTrackContent } = await import('../services/auto-track.js');

    const app = setupApp();
    const res = await app.request('/api/targets/group/Cabcdef0123456789/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'https://example.com', senderMode: 'official' }),
    });
    expect(res.status).toBe(200);
    // Upstream per-account contract: the owning account rides along so the
    // short link resolves through that account's LIFF, not the global default
    expect(autoTrackContent).toHaveBeenCalledWith(
      expect.anything(), 'text', 'https://example.com', expect.any(String),
      { lineAccountId: 'acc-1' },
    );
  });

  test('trackLinks:false skips server-side URL auto-tracking', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(groupTarget);
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', channel_access_token: 'acc-token' });
    dbMocks.logTargetMessage.mockResolvedValue('log-1');
    const { autoTrackContent } = await import('../services/auto-track.js');

    const app = setupApp();
    const res = await app.request('/api/targets/group/Cabcdef0123456789/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'https://example.com', trackLinks: false, senderMode: 'official' }),
    });
    expect(res.status).toBe(200);
    expect(autoTrackContent).not.toHaveBeenCalled();
    expect(pushMessage).toHaveBeenCalledWith(
      'Cabcdef0123456789',
      [{ type: 'text', text: 'https://example.com' }],
      undefined,
    );
  });

  test('rejects sends to inactive targets with 409', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue({ ...groupTarget, is_active: 0 });
    const app = setupApp();
    const res = await app.request('/api/targets/group/Cabcdef0123456789/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(res.status).toBe(409);
    expect(pushMessage).not.toHaveBeenCalled();
  });

  test('400 when content is missing', async () => {
    const app = setupApp();
    const res = await app.request('/api/targets/group/Cabcdef0123456789/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
