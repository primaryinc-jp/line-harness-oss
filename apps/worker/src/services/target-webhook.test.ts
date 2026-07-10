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
};
vi.mock('@line-crm/db', () => dbMocks);

const { handleTargetEvent } = await import('./target-webhook.js');

const db = {} as D1Database;

const groupTarget = {
  id: 'tgt-1', target_type: 'group' as const, line_target_id: 'Cgroup1', display_name: '田中家グループ',
  picture_url: null, is_active: 1, line_account_id: null, metadata: null,
  last_message_at: null, created_at: '', updated_at: '',
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
    expect(dbMocks.setLineTargetActive).toHaveBeenCalledWith(db, 'Cgroup1', true, 1751000000000);
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
    }));
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
    expect(dbMocks.setLineTargetActive).toHaveBeenCalledWith(db, 'Cgroup1', false, 1751000000000);
    expect(dbMocks.upsertLineTarget).not.toHaveBeenCalled();
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
});
