import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Stub the DB graph — these tests only exercise the size guard and
// signature-verify-before-parse path; webhook event handling is out of scope.
vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
  getLineTargetByLineTargetId: vi.fn(),
  upsertLineTarget: vi.fn(),
  setLineTargetActive: vi.fn(),
  logTargetMessage: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn(),
    LineClient: vi.fn().mockImplementation(() => ({})),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn(),
  expandVariables: vi.fn(),
}));

import { verifySignature } from '@line-crm/line-sdk';
import { webhook } from './webhook.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

const baseEnv = {
  DB: {} as D1Database,
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

const baseExecutionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /webhook — DoS defenses (#104)', () => {
  test('rejects with 413 when Content-Length declares an oversized body', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(2 * 1024 * 1024), // 2 MiB > 1 MiB cap
          'X-Line-Signature': 'whatever',
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    // Signature verification must not even be attempted on an oversized body.
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('rejects with 413 when actual body exceeds the cap even if Content-Length is absent', async () => {
    const app = setupApp();
    const oversizedBody = 'x'.repeat(1024 * 1024 + 1);
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'whatever',
        },
        body: oversizedBody,
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('verifies signature before parsing JSON — malformed body with invalid signature never reaches the parser', async () => {
    vi.mocked(verifySignature).mockResolvedValue(false);

    const app = setupApp();
    // 44-char signature (valid HMAC-SHA256 base64 length) so it clears the
    // length pre-check and reaches verifySignature. Malformed JSON body: if
    // signature were verified *after* parse (old behavior), we'd hit the
    // parser-failure branch first. With signature-first, we get the invalid-
    // signature branch and never attempt to parse.
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: '{not valid json',
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // verifySignature must run; rejection happens before any parse attempt.
    expect(verifySignature).toHaveBeenCalled();
    expect(verifySignature).toHaveBeenCalledWith('env-default-secret', '{not valid json', validShapedSignature);
  });

  test('rejects unsigned or malformed-signature requests without hitting verifySignature or D1', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Missing X-Line-Signature header entirely.
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // Fast-rejected before any crypto / DB work.
    expect(verifySignature).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — group/room target events', () => {
  const signedHeaders = {
    'Content-Type': 'application/json',
    // 44 chars to pass the cheap length pre-check; verifySignature is mocked
    'X-Line-Signature': 'a'.repeat(43) + '=',
  };

  async function postEvent(event: Record<string, unknown>) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: signedHeaders,
        body: JSON.stringify({ destination: 'x', events: [event] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    // Event handling runs in waitUntil — await it so assertions see the writes
    const waitUntil = vi.mocked(baseExecutionCtx.waitUntil);
    for (const call of waitUntil.mock.calls) await call[0];
    return res;
  }

  test('join event registers the group target with its summary name', async () => {
    const { LineClient } = await import('@line-crm/line-sdk');
    const getGroupSummary = vi.fn().mockResolvedValue({
      groupId: 'Cgroup1',
      groupName: '田中家グループ',
      pictureUrl: 'https://example.com/p.png',
    });
    vi.mocked(LineClient).mockImplementation(() => ({ getGroupSummary }) as unknown as InstanceType<typeof LineClient>);

    const { getLineTargetByLineTargetId, upsertLineTarget } = await import('@line-crm/db');
    vi.mocked(getLineTargetByLineTargetId).mockResolvedValue(null);
    vi.mocked(upsertLineTarget).mockResolvedValue({
      id: 'tgt-1', target_type: 'group', line_target_id: 'Cgroup1', display_name: '田中家グループ',
      picture_url: null, is_active: 1, line_account_id: null, metadata: null,
      last_message_at: null, created_at: '', updated_at: '',
    });

    const res = await postEvent({
      type: 'join',
      replyToken: 'rt',
      source: { type: 'group', groupId: 'Cgroup1' },
      timestamp: 0,
      mode: 'active',
      webhookEventId: 'we-1',
      deliveryContext: { isRedelivery: false },
    });
    expect(res.status).toBe(200);
    expect(getGroupSummary).toHaveBeenCalledWith('Cgroup1');
    expect(upsertLineTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetType: 'group',
      lineTargetId: 'Cgroup1',
      displayName: '田中家グループ',
    }));
  });

  test('group text message is logged with sender attribution and skips friend paths', async () => {
    const { LineClient } = await import('@line-crm/line-sdk');
    const getGroupMemberProfile = vi.fn().mockResolvedValue({ userId: 'U1', displayName: '田中太郎' });
    vi.mocked(LineClient).mockImplementation(() => ({ getGroupMemberProfile }) as unknown as InstanceType<typeof LineClient>);

    const { getLineTargetByLineTargetId, upsertLineTarget, logTargetMessage, getFriendByLineUserId } = await import('@line-crm/db');
    const existing = {
      id: 'tgt-1', target_type: 'group' as const, line_target_id: 'Cgroup1', display_name: '田中家グループ',
      picture_url: null, is_active: 1, line_account_id: null, metadata: null,
      last_message_at: null, created_at: '', updated_at: '',
    };
    vi.mocked(getLineTargetByLineTargetId).mockResolvedValue(existing);
    vi.mocked(upsertLineTarget).mockResolvedValue(existing);

    const res = await postEvent({
      type: 'message',
      replyToken: 'rt',
      source: { type: 'group', groupId: 'Cgroup1', userId: 'U1' },
      message: { id: 'mid-1', type: 'text', text: '内見できますか' },
      timestamp: 0,
      mode: 'active',
      webhookEventId: 'we-2',
      deliveryContext: { isRedelivery: false },
    });
    expect(res.status).toBe(200);
    expect(getGroupMemberProfile).toHaveBeenCalledWith('Cgroup1', 'U1');
    expect(logTargetMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetId: 'tgt-1',
      direction: 'incoming',
      messageType: 'text',
      content: '内見できますか',
      senderLineUserId: 'U1',
      senderDisplayName: '田中太郎',
      // dedupe key for LINE webhook redelivery
      lineMessageId: 'mid-1',
    }));
    // Group messages must never fall through to the 1:1 friend path
    expect(getFriendByLineUserId).not.toHaveBeenCalled();
  });

  test('leave event deactivates the target', async () => {
    const { LineClient } = await import('@line-crm/line-sdk');
    vi.mocked(LineClient).mockImplementation(() => ({}) as unknown as InstanceType<typeof LineClient>);
    const { setLineTargetActive } = await import('@line-crm/db');

    const res = await postEvent({
      type: 'leave',
      source: { type: 'group', groupId: 'Cgroup1' },
      timestamp: 0,
      mode: 'active',
      webhookEventId: 'we-3',
      deliveryContext: { isRedelivery: false },
    });
    expect(res.status).toBe(200);
    expect(setLineTargetActive).toHaveBeenCalledWith(expect.anything(), 'Cgroup1', false);
  });
});
