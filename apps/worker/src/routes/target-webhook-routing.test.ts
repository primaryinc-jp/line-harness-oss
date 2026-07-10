import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Routing contract only: group/room events must be delegated to the
// target-webhook service and never fall through to the 1:1 friend paths.
// Handler details live in services/target-webhook.test.ts. This is a separate
// file (not webhook.test.ts) so the upstream-owned shared test stays untouched
// and private→OSS syncs don't conflict here.
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

vi.mock('../services/target-webhook.js', () => ({
  handleTargetEvent: vi.fn().mockResolvedValue(undefined),
}));

import { verifySignature } from '@line-crm/line-sdk';
import { webhook } from './webhook.js';

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

describe('POST /webhook — group/room target routing', () => {
  test('group event is delegated to handleTargetEvent and skips friend paths', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    const { handleTargetEvent } = await import('../services/target-webhook.js');
    const { getFriendByLineUserId } = await import('@line-crm/db');

    const app = new Hono();
    app.route('/', webhook);
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 44 chars to pass the cheap length pre-check; verifySignature is mocked
          'X-Line-Signature': 'a'.repeat(43) + '=',
        },
        body: JSON.stringify({
          destination: 'x',
          events: [{
            type: 'message',
            replyToken: 'rt',
            source: { type: 'group', groupId: 'Cgroup1', userId: 'U1' },
            message: { id: 'mid-1', type: 'text', text: '内見できますか' },
            timestamp: 1751000000000,
            mode: 'active',
            webhookEventId: 'we-1',
            deliveryContext: { isRedelivery: false },
          }],
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    // Event handling runs in waitUntil — await it so assertions see the calls
    for (const call of vi.mocked(baseExecutionCtx.waitUntil).mock.calls) await call[0];

    expect(res.status).toBe(200);
    expect(handleTargetEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handleTargetEvent).mock.calls[0][2]).toMatchObject({
      source: { type: 'group', groupId: 'Cgroup1' },
    });
    expect(getFriendByLineUserId).not.toHaveBeenCalled();
  });
});
