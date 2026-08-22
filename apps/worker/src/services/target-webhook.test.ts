import { describe, expect, test, vi, beforeEach } from 'vitest';
import type { LineClient } from '@line-crm/line-sdk';
import type { WebhookEvent } from '@line-crm/line-sdk';

// The handler's responsibility is "resolve target → call DB helpers / LINE
// client with correct args", so capturing those args is the meaningful
// assertion (schema behavior is covered in packages/db tests).
const dbMocks = {
  getLineTargetByLineTargetId: vi.fn(),
  upsertLineTarget: vi.fn(),
  setLineTargetActive: vi.fn(),
  logTargetMessage: vi.fn(),
  createNotification: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);
const eventBusMocks = { fireOutgoingWebhooks: vi.fn() };
vi.mock('./event-bus.js', () => eventBusMocks);

const { handleTargetEvent } = await import('./target-webhook.js');

const db = {} as D1Database;

const groupTarget = {
  id: 'tgt-1', target_type: 'group' as const, line_target_id: 'Cgroup1', display_name: '田中家グループ',
  picture_url: null, is_active: 1, line_account_id: null, metadata: null,
  // Fresh far-future refresh time so message-event tests that don't care about
  // name refresh don't spuriously trigger a summary fetch (event timestamps in
  // those tests are small); name-refresh tests override this explicitly.
  last_message_at: null, membership_updated_at: null, name_refreshed_at: 9_000_000_000_000,
  created_at: '', updated_at: '',
};

function lineClient(overrides: Record<string, unknown> = {}): LineClient {
  return overrides as unknown as LineClient;
}

function event(e: Record<string, unknown>): WebhookEvent {
  return {
    replyToken: 'rt',
    timestamp: 0,
    mode: 'active',
    webhookEventId: 'we-1',
    deliveryContext: { isRedelivery: false },
    ...e,
  } as unknown as WebhookEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.upsertLineTarget.mockResolvedValue(groupTarget);
  dbMocks.logTargetMessage.mockResolvedValue('message-log-1');
});

describe('handleTargetEvent', () => {
  test('join registers the group target with its summary name', async () => {
    const getGroupSummary = vi.fn().mockResolvedValue({
      groupId: 'Cgroup1',
      groupName: '田中家グループ',
      pictureUrl: 'https://example.com/p.png',
    });
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(null);

    await handleTargetEvent(
      db, lineClient({ getGroupSummary }),
      event({ type: 'join', timestamp: 1751000000000, source: { type: 'group', groupId: 'Cgroup1' } }),
      'token', 'acc-1',
    );
    expect(getGroupSummary).toHaveBeenCalledWith('Cgroup1');
    expect(dbMocks.upsertLineTarget).toHaveBeenCalledWith(db, expect.objectContaining({
      targetType: 'group',
      lineTargetId: 'Cgroup1',
      displayName: '田中家グループ',
      lineAccountId: 'acc-1',
    }));
    // Reactivation goes through the event-timestamp-guarded membership update
    expect(dbMocks.setLineTargetActive).toHaveBeenCalledWith(db, {
      targetType: 'group', lineTargetId: 'Cgroup1', isActive: true, eventTimestamp: 1751000000000, lineAccountId: 'acc-1',
    });
  });

  test('group summary failure is best-effort: target is still registered', async () => {
    const getGroupSummary = vi.fn().mockRejectedValue(new Error('403'));
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(null);

    await handleTargetEvent(
      db, lineClient({ getGroupSummary }),
      event({ type: 'join', source: { type: 'group', groupId: 'Cgroup1' } }),
      'token', null,
    );
    expect(dbMocks.upsertLineTarget).toHaveBeenCalledWith(db, expect.objectContaining({
      lineTargetId: 'Cgroup1',
      displayName: null,
    }));
  });

  test('text message logs sender attribution and the LINE message id (dedupe key)', async () => {
    const getGroupMemberProfile = vi.fn().mockResolvedValue({ userId: 'U1', displayName: '田中太郎' });
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(groupTarget);

    await handleTargetEvent(
      db, lineClient({ getGroupMemberProfile }),
      event({
        type: 'message',
        source: { type: 'group', groupId: 'Cgroup1', userId: 'U1' },
        message: { id: 'mid-1', type: 'text', text: '内見できますか' },
      }),
      'token', null,
    );
    expect(getGroupMemberProfile).toHaveBeenCalledWith('Cgroup1', 'U1');
    expect(dbMocks.logTargetMessage).toHaveBeenCalledWith(db, expect.objectContaining({
      targetId: 'tgt-1',
      direction: 'incoming',
      messageType: 'text',
      content: '内見できますか',
      senderLineUserId: 'U1',
      senderDisplayName: '田中太郎',
      lineMessageId: 'mid-1',
      // real occurrence time drives created_at / last_message_at
      occurredAt: 0,
    }));
    expect(eventBusMocks.fireOutgoingWebhooks).not.toHaveBeenCalled();
  });

  test('linked group message emits an outgoing-only notification event with routing metadata', async () => {
    const linkedTarget = {
      ...groupTarget,
      line_account_id: 'acc-1',
      metadata: JSON.stringify({ salesCustomerPageId: 'customer-7', salesDealPageId: 'deal-9' }),
    };
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(linkedTarget);
    dbMocks.upsertLineTarget.mockResolvedValue(linkedTarget);

    await handleTargetEvent(
      db,
      lineClient({ getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: '田中太郎' }) }),
      event({
        type: 'message',
        timestamp: 1751000000000,
        source: { type: 'group', groupId: 'Cgroup1', userId: 'U1' },
        message: { id: 'mid-1', type: 'text', text: '内見できますか' },
      }),
      'token',
      'acc-1',
    );

    expect(eventBusMocks.fireOutgoingWebhooks).toHaveBeenCalledWith(
      db,
      'target_message_received',
      {
        eventId: 'we-1',
        conversation: {
          type: 'group',
          id: 'tgt-1',
          lineTargetId: 'Cgroup1',
          displayName: '田中家グループ',
          lineAccountId: 'acc-1',
          salesCustomerPageId: 'customer-7',
          salesDealPageId: 'deal-9',
        },
        sender: { lineUserId: 'U1', displayName: '田中太郎' },
        message: { id: 'mid-1', type: 'text', text: '内見できますか' },
      },
    );
  });

  test('a stale account event never emits group notification metadata owned by another account', async () => {
    const linkedTarget = {
      ...groupTarget,
      line_account_id: 'acc-2',
      metadata: JSON.stringify({ salesDealPageId: 'deal-private' }),
    };
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(linkedTarget);
    dbMocks.upsertLineTarget.mockResolvedValue(linkedTarget);

    await handleTargetEvent(
      db,
      lineClient({ getGroupMemberProfile: vi.fn().mockRejectedValue(new Error('unavailable')) }),
      event({
        type: 'message',
        deliveryContext: { isRedelivery: true },
        source: { type: 'group', groupId: 'Cgroup1', userId: 'U1' },
        message: { id: 'mid-1', type: 'image' },
      }),
      'token',
      'acc-1',
    );

    expect(dbMocks.logTargetMessage).toHaveBeenCalled();
    expect(eventBusMocks.fireOutgoingWebhooks).not.toHaveBeenCalled();
  });

  test('redelivery re-emits the same event id so the receiver can deduplicate it', async () => {
    const linkedTarget = {
      ...groupTarget,
      line_account_id: 'acc-1',
      metadata: JSON.stringify({ salesDealPageId: 'deal-9' }),
    };
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(linkedTarget);
    dbMocks.upsertLineTarget.mockResolvedValue(linkedTarget);

    await handleTargetEvent(
      db,
      lineClient({ getGroupMemberProfile: vi.fn().mockRejectedValue(new Error('unavailable')) }),
      event({
        type: 'message',
        deliveryContext: { isRedelivery: true },
        source: { type: 'group', groupId: 'Cgroup1', userId: 'U1' },
        message: { id: 'mid-1', type: 'image' },
      }),
      'token',
      'acc-1',
    );

    expect(eventBusMocks.fireOutgoingWebhooks).toHaveBeenCalledWith(
      db,
      'target_message_received',
      expect.objectContaining({ eventId: 'we-1' }),
    );
  });

  test('room message uses the room member profile API', async () => {
    const getRoomMemberProfile = vi.fn().mockResolvedValue({ userId: 'U1', displayName: '田中太郎' });
    const roomTarget = { ...groupTarget, id: 'tgt-2', target_type: 'room' as const, line_target_id: 'Rroom1', display_name: null };
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(roomTarget);
    dbMocks.upsertLineTarget.mockResolvedValue(roomTarget);

    await handleTargetEvent(
      db, lineClient({ getRoomMemberProfile }),
      event({
        type: 'message',
        source: { type: 'room', roomId: 'Rroom1', userId: 'U1' },
        message: { id: 'mid-2', type: 'text', text: 'こんにちは' },
      }),
      'token', null,
    );
    expect(getRoomMemberProfile).toHaveBeenCalledWith('Rroom1', 'U1');
    expect(dbMocks.logTargetMessage).toHaveBeenCalledWith(db, expect.objectContaining({
      targetId: 'tgt-2',
      lineMessageId: 'mid-2',
    }));
  });

  test('leave deactivates the target without upserting', async () => {
    await handleTargetEvent(
      db, lineClient(),
      event({ type: 'leave', timestamp: 1751000000000, source: { type: 'group', groupId: 'Cgroup1' } }),
      'token', null,
    );
    expect(dbMocks.setLineTargetActive).toHaveBeenCalledWith(db, {
      targetType: 'group', lineTargetId: 'Cgroup1', isActive: false, eventTimestamp: 1751000000000, lineAccountId: null,
    });
    expect(dbMocks.upsertLineTarget).not.toHaveBeenCalled();
  });

  test('leave notifies sales when a customer-linked target is deactivated', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue({
      ...groupTarget, is_active: 1, membership_updated_at: null,
      metadata: JSON.stringify({ salesCustomerPageId: 'cust-1', salesDealPageId: 'deal-9' }),
    });
    await handleTargetEvent(
      db, lineClient(),
      event({ type: 'leave', timestamp: 1751000000000, source: { type: 'group', groupId: 'Cgroup1' } }),
      'token', 'acc-1',
    );
    expect(dbMocks.createNotification).toHaveBeenCalledTimes(1);
    const arg = dbMocks.createNotification.mock.calls[0][1];
    expect(arg.eventType).toBe('line_target_left');
    expect(JSON.parse(arg.metadata).salesCustomerPageId).toBe('cust-1');
  });

  test('leave from a non-owner account does not notify (no cross-account CRM leak)', async () => {
    // Target owned by acc-B with B's customer link; the leave webhook belongs to
    // acc-A. A's leave must not emit a notification carrying B's customer id.
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue({
      ...groupTarget, is_active: 1, membership_updated_at: null, line_account_id: 'acc-B',
      metadata: JSON.stringify({ salesCustomerPageId: 'cust-B' }),
    });
    await handleTargetEvent(
      db, lineClient(),
      event({ type: 'leave', timestamp: 1751000000000, source: { type: 'group', groupId: 'Cgroup1' } }),
      'token', 'acc-A',
    );
    expect(dbMocks.createNotification).not.toHaveBeenCalled();
  });

  test('leave does not notify for an unlinked target', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue({ ...groupTarget, is_active: 1, metadata: null });
    await handleTargetEvent(
      db, lineClient(),
      event({ type: 'leave', timestamp: 1751000000000, source: { type: 'group', groupId: 'Cgroup1' } }),
      'token', null,
    );
    expect(dbMocks.createNotification).not.toHaveBeenCalled();
  });

  test('redelivered leave (already inactive) does not re-notify', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue({
      ...groupTarget, is_active: 0, membership_updated_at: 1751000000000,
      metadata: JSON.stringify({ salesCustomerPageId: 'cust-1' }),
    });
    await handleTargetEvent(
      db, lineClient(),
      event({ type: 'leave', timestamp: 1751000000000, source: { type: 'group', groupId: 'Cgroup1' } }),
      'token', null,
    );
    expect(dbMocks.createNotification).not.toHaveBeenCalled();
  });

  test('message events never call the membership update (cannot reactivate a left target)', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue(groupTarget);
    await handleTargetEvent(
      db, lineClient({ getGroupMemberProfile: vi.fn().mockRejectedValue(new Error('n/a')) }),
      event({
        type: 'message',
        source: { type: 'group', groupId: 'Cgroup1', userId: 'U1' },
        message: { id: 'mid-9', type: 'text', text: '過去メッセージのredelivery' },
      }),
      'token', null,
    );
    expect(dbMocks.setLineTargetActive).not.toHaveBeenCalled();
    expect(dbMocks.logTargetMessage).toHaveBeenCalled();
  });

  test('message refreshes a stale group name and records the refresh time', async () => {
    // Name last fetched long ago → refetch on this message.
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue({
      ...groupTarget, display_name: '旧名', name_refreshed_at: 1000,
    });
    const getGroupSummary = vi.fn().mockResolvedValue({ groupId: 'Cgroup1', groupName: '新名', pictureUrl: null });
    const now = 1000 + 8 * 24 * 60 * 60 * 1000; // 8 days later (> 7d threshold)
    await handleTargetEvent(
      db, lineClient({ getGroupSummary, getGroupMemberProfile: vi.fn().mockRejectedValue(new Error('n/a')) }),
      event({ type: 'message', timestamp: now, source: { type: 'group', groupId: 'Cgroup1', userId: 'U1' }, message: { id: 'm1', type: 'text', text: 'hi' } }),
      'token', null,
    );
    expect(getGroupSummary).toHaveBeenCalledWith('Cgroup1');
    const upsertArg = dbMocks.upsertLineTarget.mock.calls[0][1];
    expect(upsertArg.displayName).toBe('新名');
    expect(upsertArg.nameRefreshedAt).toBe(now);
  });

  test('message does not refetch a recently-refreshed group name', async () => {
    dbMocks.getLineTargetByLineTargetId.mockResolvedValue({
      ...groupTarget, display_name: '田中家グループ', name_refreshed_at: 1_000_000,
    });
    const getGroupSummary = vi.fn();
    const now = 1_000_000 + 60_000; // 1 minute later (< 7d threshold)
    await handleTargetEvent(
      db, lineClient({ getGroupSummary, getGroupMemberProfile: vi.fn().mockRejectedValue(new Error('n/a')) }),
      event({ type: 'message', timestamp: now, source: { type: 'group', groupId: 'Cgroup1', userId: 'U1' }, message: { id: 'm2', type: 'text', text: 'hi' } }),
      'token', null,
    );
    expect(getGroupSummary).not.toHaveBeenCalled();
    const upsertArg = dbMocks.upsertLineTarget.mock.calls[0][1];
    expect(upsertArg.nameRefreshedAt).toBeUndefined();
  });
});
