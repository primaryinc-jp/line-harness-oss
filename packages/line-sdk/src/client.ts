import type {
  BroadcastRequest,
  FlexContainer,
  GroupSummary,
  Message,
  MessageSender,
  MulticastRequest,
  PushMessageRequest,
  ReplyMessageRequest,
  RichMenuObject,
  UserProfile,
} from './types.js';

const LINE_API_BASE = 'https://api.line.me';

export interface FollowersInsight {
  status: string;
  followers?: number;
  targetedReaches?: number;
  blocks?: number;
}

export interface FollowerIdsPage {
  userIds: string[];
  next?: string;
}

export class LineClient {
  constructor(private readonly channelAccessToken: string) {}

  // ─── Core request helper ──────────────────────────────────────────────────

  async request(
    method: string,
    path: string,
    body?: unknown,
    requestHeaders: Record<string, string> = {},
  ): Promise<{ data: unknown; headers: Headers }> {
    const url = `${LINE_API_BASE}${path}`;

    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.channelAccessToken}`,
        ...requestHeaders,
      },
    };

    if (method !== 'GET' && method !== 'DELETE' && body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);

    // LINE returns 409 when a request with the same X-Line-Retry-Key was
    // already accepted. For a caller retrying the exact same operation this
    // is a successful idempotent outcome, not a delivery failure.
    if (res.status === 409 && requestHeaders['X-Line-Retry-Key']) {
      return { data: { retryAccepted: true }, headers: res.headers };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `LINE API error: ${res.status} ${res.statusText} — ${text}`,
      );
    }

    // Some endpoints (e.g. push, reply) return an empty body with 200.
    const contentType = res.headers.get('content-type') ?? '';
    let data: unknown;
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = undefined;
    }

    return { data, headers: res.headers };
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<UserProfile> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/profile/${encodeURIComponent(userId)}`,
    );
    return data as UserProfile;
  }

  // ─── Group / Room ─────────────────────────────────────────────────────────

  /** Group name + icon. Available to any bot that is a member of the group. */
  async getGroupSummary(groupId: string): Promise<GroupSummary> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/group/${encodeURIComponent(groupId)}/summary`,
    );
    return data as GroupSummary;
  }

  /** Profile of a group member. Works while the member is in the group. */
  async getGroupMemberProfile(
    groupId: string,
    userId: string,
  ): Promise<UserProfile> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`,
    );
    return data as UserProfile;
  }

  /** Profile of a room (multi-person chat) member. */
  async getRoomMemberProfile(
    roomId: string,
    userId: string,
  ): Promise<UserProfile> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/room/${encodeURIComponent(roomId)}/member/${encodeURIComponent(userId)}`,
    );
    return data as UserProfile;
  }

  // ─── Messaging ───────────────────────────────────────────────────────────

  private applyS(messages: Message[], sender?: MessageSender): Message[] {
    if (!sender) return messages;
    return messages.map((m) => ({ ...m, sender }));
  }

  // `sender` は末尾。upstream が retryKey / customAggregationUnits を先に取る
  // 位置引数で確定させているため、fork 固有の sender をその手前に差し込むと
  // upstream 側の呼び出しが全部ずれる。
  async pushMessage(
    to: string,
    messages: Message[],
    retryKey?: string,
    customAggregationUnits?: string[],
    sender?: MessageSender,
  ): Promise<unknown> {
    const body: PushMessageRequest = {
      to,
      messages: this.applyS(messages, sender),
      customAggregationUnits,
    };
    const { data } = await this.request(
      'POST',
      '/v2/bot/message/push',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return data;
  }

  async multicast(
    to: string[],
    messages: Message[],
    customAggregationUnits?: string[],
    retryKey?: string,
    sender?: MessageSender,
  ): Promise<{ data: unknown; requestId: string | null }> {
    const body: Record<string, unknown> = { to, messages: this.applyS(messages, sender) };
    if (customAggregationUnits) {
      body.customAggregationUnits = customAggregationUnits;
    }
    const { data, headers } = await this.request(
      'POST',
      '/v2/bot/message/multicast',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return { data, requestId: headers.get('x-line-request-id') };
  }

  async broadcast(
    messages: Message[],
    retryKey?: string,
    sender?: MessageSender,
  ): Promise<{ data: unknown; requestId: string | null }> {
    const body: BroadcastRequest = { messages: this.applyS(messages, sender) };
    const { data, headers } = await this.request(
      'POST',
      '/v2/bot/message/broadcast',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return { data, requestId: headers.get('x-line-request-id') };
  }

  async replyMessage(
    replyToken: string,
    messages: Message[],
    sender?: MessageSender,
  ): Promise<unknown> {
    const body: ReplyMessageRequest = { replyToken, messages: this.applyS(messages, sender) };
    const { data } = await this.request('POST', '/v2/bot/message/reply', body);
    return data;
  }

  // ─── Rich Menu ────────────────────────────────────────────────────────────

  async getRichMenuList(): Promise<{ richmenus: RichMenuObject[] }> {
    const { data } = await this.request('GET', '/v2/bot/richmenu/list');
    return data as { richmenus: RichMenuObject[] };
  }

  async createRichMenu(menu: RichMenuObject): Promise<{ richMenuId: string }> {
    const { data } = await this.request('POST', '/v2/bot/richmenu', menu);
    return data as { richMenuId: string };
  }

  async deleteRichMenu(richMenuId: string): Promise<unknown> {
    const { data } = await this.request(
      'DELETE',
      `/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`,
    );
    return data;
  }

  async setDefaultRichMenu(richMenuId: string): Promise<unknown> {
    const { data } = await this.request(
      'POST',
      `/v2/bot/user/all/richmenu/${encodeURIComponent(richMenuId)}`,
    );
    return data;
  }

  async linkRichMenuToUser(
    userId: string,
    richMenuId: string,
  ): Promise<unknown> {
    const { data } = await this.request(
      'POST',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu/${encodeURIComponent(richMenuId)}`,
    );
    return data;
  }

  async unlinkRichMenuFromUser(userId: string): Promise<unknown> {
    const { data } = await this.request(
      'DELETE',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu`,
    );
    return data;
  }

  async getRichMenuIdOfUser(userId: string): Promise<{ richMenuId: string }> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu`,
    );
    return data as { richMenuId: string };
  }

  async getDefaultRichMenuId(): Promise<string | null> {
    const url = `${LINE_API_BASE}/v2/bot/user/all/richmenu`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.channelAccessToken}`,
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LINE API error: ${res.status} ${res.statusText} — ${text}`);
    }
    const data = (await res.json()) as { richMenuId: string };
    return data.richMenuId;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async pushTextMessage(to: string, text: string, sender?: MessageSender): Promise<unknown> {
    return this.pushMessage(to, [{ type: 'text', text }], undefined, undefined, sender);
  }

  async pushFlexMessage(
    to: string,
    altText: string,
    contents: FlexContainer,
    sender?: MessageSender,
  ): Promise<unknown> {
    return this.pushMessage(to, [{ type: 'flex', altText, contents }], undefined, undefined, sender);
  }

  async pushImageMessage(
    to: string,
    originalContentUrl: string,
    previewImageUrl: string,
    sender?: MessageSender,
  ): Promise<unknown> {
    return this.pushMessage(
      to,
      [{ type: 'image', originalContentUrl, previewImageUrl }],
      undefined,
      undefined,
      sender,
    );
  }

  // ─── Rich Menu Image Upload ─────────────────────────────────────────────

  /** Upload image to a rich menu. Accepts PNG/JPEG binary (ArrayBuffer or Uint8Array). */
  async uploadRichMenuImage(
    richMenuId: string,
    imageData: ArrayBuffer,
    contentType: 'image/png' | 'image/jpeg' = 'image/png',
  ): Promise<void> {
    const url = `https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: `Bearer ${this.channelAccessToken}`,
      },
      body: imageData,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `LINE API error: ${res.status} ${res.statusText} — ${text}`,
      );
    }
  }

  // ─── Insight API ─────────────────────────────────────────────────────────

  /**
   * Get user interaction statistics for a broadcast message.
   * Data becomes available ~3 days after sending.
   * GET only — no messages are sent.
   */
  async getMessageEventInsight(requestId: string): Promise<unknown> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/insight/message/event?requestId=${encodeURIComponent(requestId)}`,
    );
    return data;
  }

  /**
   * Get statistics per unit for multicast messages.
   * GET only — no messages are sent.
   */
  async getUnitInsight(
    customAggregationUnit: string,
    from: string,
    to: string,
  ): Promise<unknown> {
    const params = new URLSearchParams({ customAggregationUnit, from, to });
    const { data } = await this.request(
      'GET',
      `/v2/bot/insight/message/event/aggregation?${params.toString()}`,
    );
    return data;
  }

  /**
   * Get the number of followers for a LINE Official Account on a given date.
   * GET only — no messages are sent.
   */
  async getFollowersInsight(date: string): Promise<FollowersInsight> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/insight/followers?date=${encodeURIComponent(date)}`,
    );
    return data as FollowersInsight;
  }

  /**
   * Get one page of users who currently follow the LINE Official Account.
   * Verified/premium accounts only. Pass the returned `next` value as
   * `start` until `next` is absent to retrieve the full audience.
   */
  async getFollowerIds(
    limit = 1000,
    start?: string,
  ): Promise<FollowerIdsPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (start) params.set('start', start);
    const { data } = await this.request(
      'GET',
      `/v2/bot/followers/ids?${params.toString()}`,
    );
    return data as FollowerIdsPage;
  }
}
