import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getFriends: vi.fn(), getFriendById: vi.fn(), getFriendCount: vi.fn(),
  addTagToFriend: vi.fn(), removeTagFromFriend: vi.fn(), getFriendTags: vi.fn(),
  getScenarios: vi.fn(), enrollFriendInScenario: vi.fn(), getLineAccountById: vi.fn(),
  jstNow: vi.fn(() => '2026-08-04T07:00:00+09:00'),
};
vi.mock('@line-crm/db', () => dbMocks);

const pushMessage = vi.fn().mockResolvedValue({});
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({ pushMessage })),
}));
vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn((_type: string, content: string) => ({ type: 'text', text: content })),
}));
vi.mock('../services/auto-track.js', () => ({
  autoTrackContent: vi.fn(async (_db: unknown, messageType: string, content: string) => ({ messageType, content })),
  appendFriendToTrackedLinks: vi.fn(async (_db: unknown, content: string) => content),
}));
vi.mock('../utils/message-sender.js', () => ({
  MessageSenderError: class MessageSenderError extends Error { status = 400; },
  resolveMessageSender: vi.fn(async () => ({ staffId: null, name: null, iconUrl: null, lineSender: undefined })),
}));

const deliveryMocks = {
  reserveMessageDelivery: vi.fn(),
  finishMessageDelivery: vi.fn(),
  claimMessageDeliveryDispatch: vi.fn(),
  reconcileStaleMessageDelivery: vi.fn(),
  resolveClaimedMessageDelivery: vi.fn(),
  sha256Hex: vi.fn(async () => 'request-hash'),
};
vi.mock('../services/message-delivery-idempotency.js', () => deliveryMocks);

const { friends } = await import('./friends.js');

type TestEnv = {
  Variables: { staff: { id: string; name: string; role: 'owner' } };
  Bindings: { DB: D1Database; LINE_CHANNEL_ACCESS_TOKEN: string; WORKER_URL: string };
};

const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
const fakeDb = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run })) })) } as unknown as D1Database;

function app() {
  const instance = new Hono<TestEnv>();
  instance.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '担当', role: 'owner' });
    c.env = { DB: fakeDb, LINE_CHANNEL_ACCESS_TOKEN: 'fallback', WORKER_URL: 'https://worker.test' };
    await next();
  });
  instance.route('/', friends);
  return instance;
}

const friend = {
  id: 'friend-1', line_user_id: 'U123', display_name: '山田', line_account_id: 'acc-1',
  is_following: 1, metadata: '{}', picture_url: null, status_message: null,
  user_id: null, created_at: '2026-08-01', updated_at: '2026-08-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  pushMessage.mockResolvedValue({});
  dbMocks.getFriendById.mockResolvedValue(friend);
  dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', channel_access_token: 'account-token' });
  deliveryMocks.reserveMessageDelivery.mockResolvedValue({ kind: 'reserved' });
  deliveryMocks.finishMessageDelivery.mockResolvedValue(undefined);
  deliveryMocks.claimMessageDeliveryDispatch.mockResolvedValue(true);
  deliveryMocks.reconcileStaleMessageDelivery.mockResolvedValue('reconciled_uncertain');
  deliveryMocks.resolveClaimedMessageDelivery.mockResolvedValue('resolved');
});

describe('POST /api/friends/:id/messages idempotency', () => {
  test('owner can mark a stale in-progress delivery uncertain without resending', async () => {
    const response = await app().request('/api/message-deliveries/proposal%3A1/reconcile-stale', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccountId: 'acc-1' }),
    });
    expect(response.status).toBe(200);
    expect(deliveryMocks.reconcileStaleMessageDelivery).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ clientRequestId: 'proposal:1', lineAccountId: 'acc-1' }),
    );
    expect(pushMessage).not.toHaveBeenCalled();
  });

  test('owner can close a provider-verified crashed dispatch without resending', async () => {
    const response = await app().request('/api/message-deliveries/proposal%3A1/resolve-dispatch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1', resolution: 'sent', providerReference: 'line-provider-log-123',
      }),
    });
    expect(response.status).toBe(200);
    expect(deliveryMocks.resolveClaimedMessageDelivery).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({
        clientRequestId: 'proposal:1', lineAccountId: 'acc-1', resolution: 'sent', resolvedByStaffId: 'staff-1',
      }),
    );
    expect(pushMessage).not.toHaveBeenCalled();
  });

  test('requires account and request id together', async () => {
    const response = await app().request('/api/friends/friend-1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '提案です', clientRequestId: 'proposal:1' }),
    });
    expect(response.status).toBe(400);
    expect(pushMessage).not.toHaveBeenCalled();
  });

  test('rejects a stale account assertion before reserving', async () => {
    const response = await app().request('/api/friends/friend-1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '提案です', lineAccountId: 'acc-2', clientRequestId: 'proposal:1' }),
    });
    expect(response.status).toBe(409);
    expect(deliveryMocks.reserveMessageDelivery).not.toHaveBeenCalled();
    expect(pushMessage).not.toHaveBeenCalled();
  });

  test('returns the original receipt without pushing again', async () => {
    deliveryMocks.reserveMessageDelivery.mockResolvedValue({
      kind: 'existing', status: 'sent', messageLogId: 'message-1', errorCode: null,
    });
    const response = await app().request('/api/friends/friend-1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '提案です', lineAccountId: 'acc-1', clientRequestId: 'proposal:1' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: {
      messageId: 'message-1', clientRequestId: 'proposal:1', lineAccountId: 'acc-1',
      requestHash: 'request-hash', idempotent: true,
    } });
    expect(pushMessage).not.toHaveBeenCalled();
  });

  test('refuses to retry an in-progress or uncertain delivery', async () => {
    for (const status of ['in_progress', 'uncertain'] as const) {
      deliveryMocks.reserveMessageDelivery.mockResolvedValueOnce({
        kind: 'existing', status, messageLogId: null, errorCode: null,
      });
      const response = await app().request('/api/friends/friend-1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '提案です', lineAccountId: 'acc-1', clientRequestId: 'proposal:1' }),
      });
      expect(response.status).toBe(409);
    }
    expect(pushMessage).not.toHaveBeenCalled();
  });

  test('pushes once and finalizes the reservation with the message receipt', async () => {
    const response = await app().request('/api/friends/friend-1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '提案です', lineAccountId: 'acc-1', clientRequestId: 'proposal:1',
        senderMode: 'official', trackLinks: false,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: {
      clientRequestId: 'proposal:1', lineAccountId: 'acc-1', requestHash: 'request-hash', idempotent: false,
    } });
    expect(pushMessage).toHaveBeenCalledTimes(1);
    expect(deliveryMocks.finishMessageDelivery).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ status: 'sent', clientRequestId: 'proposal:1' }),
    );
  });

  test('does not push when reconciliation wins before provider dispatch', async () => {
    deliveryMocks.claimMessageDeliveryDispatch.mockResolvedValueOnce(false);
    const response = await app().request('/api/friends/friend-1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '提案です', lineAccountId: 'acc-1', clientRequestId: 'proposal:1' }),
    });
    expect(response.status).toBe(500);
    expect(pushMessage).not.toHaveBeenCalled();
  });

  test('marks provider errors uncertain and never reports a receipt', async () => {
    pushMessage.mockRejectedValueOnce(new Error('provider timeout'));
    const response = await app().request('/api/friends/friend-1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '提案です', lineAccountId: 'acc-1', clientRequestId: 'proposal:1' }),
    });
    expect(response.status).toBe(500);
    expect(deliveryMocks.finishMessageDelivery).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ status: 'uncertain', errorCode: 'provider_result_unknown' }),
    );
  });
});
