import { Hono } from 'hono';
import type { Env } from '../index.js';

export const HARNESS_VERSION = '0.13.0';
export const API_VERSION = 1;
export const CONNECTOR_VERSION = '2026-08-17';
export const MIN_APP_VERSION = '1.0.0';
export const FEATURES = [
  'friends',
  'broadcasts',
  'scenarios',
  'tracked_links',
  'forms',
  'staff',
  'tags',
  'templates',
  'scoring',
  'automations',
  'conversions',
  'affiliates',
  'chats',
  'conversations',
  // Group/room conversation targets (list/detail/metadata/conversation/send).
  // External integrations check these slugs to decide whether group workflows
  // are available on this harness.
  'targets',
  'group_conversations',
  'auto_replies',
  'rich_menus',
  'webhooks',
  'stripe',
  'line_accounts',
  // Account-scoped, request-hash-bound idempotency for 1:1 messages.
  'message_delivery_idempotency_v1',
  'line-cross-link',
  'x-cross-link',
  'ig-cross-link',
] as const;

export const capabilities = new Hono<Env>();

capabilities.get('/api/capabilities', async (c) => {
  return c.json({
    success: true,
    data: {
      harness_kind: 'line',
      harness_version: HARNESS_VERSION,
      api_version: API_VERSION,
      features: FEATURES,
      min_app_version: MIN_APP_VERSION,
      product: 'line-harness',
      platform: 'line',
      version: HARNESS_VERSION,
      connectorVersion: CONNECTOR_VERSION,
      identity: {
        primaryKey: 'line_friend_id',
        supportedLinks: ['x_user_id', 'ig_igsid'],
        // Identity contract for group/room conversation targets (the
        // `targets` / `group_conversations` features). Friends are NOT
        // addressable through /api/targets — 1:1 conversations stay on the
        // /api/friends surface keyed by line_friend_id.
        targets: {
          // Supported values of :targetType (and the `targetType` field).
          types: ['group', 'room'],
          // Canonical identifier: the harness row id returned as `id`.
          primaryKey: 'target_id',
          // :targetId path segments additionally resolve raw LINE ids
          // (groupId/roomId, returned as `targetId`) as a convenience.
          acceptedIds: ['target_id', 'line_group_id', 'line_room_id'],
          friendsAddressable: false,
        },
      },
      endpoints: {
        health: '/api/health',
        staffMe: '/api/staff/me',
        lineAccounts: '/api/line-accounts',
        friends: '/api/friends',
        idempotentFriendMessages: '/api/friends/:id/messages',
        broadcasts: '/api/broadcasts',
        scenarios: '/api/scenarios',
        trackedLinks: '/api/tracked-links',
        trackedLinkClicks: '/api/tracked-links/:id/clicks',
        forms: '/api/forms',
        tags: '/api/tags',
        chats: '/api/chats',
        targets: '/api/targets',
        targetConversations: '/api/conversations/:targetType/:targetId',
        liff: '/liff',
      },
    },
  });
});
