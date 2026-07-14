import type { HttpClient } from '../http.js'
import type {
  ApiResponse,
  MessageSenderSelection,
  MessageType,
  TargetType,
  Target,
  TargetDetail,
  TargetListParams,
  TargetListResponse,
  TargetConversation,
} from '../types.js'

/**
 * Group/room conversation targets. Mirrors the friends resource for non-1:1
 * destinations: list / detail / metadata merge / conversation thread / send.
 * `targetId` accepts either the harness row id or the raw LINE groupId/roomId.
 */
export class TargetsResource {
  constructor(
    private readonly http: HttpClient,
    private readonly defaultAccountId?: string,
  ) {}

  /**
   * Resolve the account-ownership assertion: an explicit value (including the
   * documented unbound scopes `''` / `null`) wins; `undefined` falls back to the
   * configured default account. Returns `undefined` when there is nothing to
   * assert (unscoped, back-compat).
   */
  private resolveScope(explicit: string | null | undefined): string | null | undefined {
    return explicit !== undefined ? explicit : this.defaultAccountId
  }

  async list(params?: TargetListParams): Promise<TargetListResponse> {
    const query = new URLSearchParams()
    if (params?.type) query.set('type', params.type)
    // Same default scoping as friends/conversations: LINE_HARNESS_ACCOUNT_ID
    // (config.lineAccountId) must narrow target lists too, or a scoped MCP
    // would list/reverse-look-up targets across every account.
    // Empty string selects the unbound (legacy) scope; a value scopes to that
    // account; omitted falls back to the default. Only skip when there is
    // nothing to assert at all.
    const acct = this.resolveScope(params?.lineAccountId)
    if (acct !== undefined) query.set('lineAccountId', acct ?? '')
    if (params?.includeInactive) query.set('includeInactive', 'true')
    for (const [key, value] of Object.entries(params?.metadata ?? {})) {
      query.set(`metadata.${key}`, value)
    }
    if (params?.limit !== undefined) query.set('limit', String(params.limit))
    if (params?.offset !== undefined) query.set('offset', String(params.offset))
    const qs = query.toString()
    const path = qs ? `/api/targets?${qs}` : '/api/targets'
    const res = await this.http.get<ApiResponse<TargetListResponse>>(path)
    return res.data
  }

  async get(
    targetType: TargetType,
    targetId: string,
    params?: {
      /**
       * Assert the owning account. Defaults to LINE_HARNESS_ACCOUNT_ID
       * (config.lineAccountId); the server rejects (409) if the target has
       * since moved to another account, so a scoped client can't read another
       * account's thread via a stale target id.
       */
      lineAccountId?: string | null
    },
  ): Promise<TargetDetail> {
    const acct = this.resolveScope(params?.lineAccountId)
    // Empty string in the query asserts the unbound (legacy) scope; a value
    // asserts that account; omitted means no assertion.
    const path = `/api/targets/${targetType}/${encodeURIComponent(targetId)}${
      acct !== undefined ? `?lineAccountId=${encodeURIComponent(acct ?? '')}` : ''
    }`
    const res = await this.http.get<ApiResponse<TargetDetail>>(path)
    return res.data
  }

  async setMetadata(
    targetType: TargetType,
    targetId: string,
    fields: Record<string, unknown>,
    params?: {
      /**
       * Assert the owning account (defaults to LINE_HARNESS_ACCOUNT_ID); the
       * server rejects (409) if the target moved accounts, so a scoped client
       * can't rewrite another account's metadata via a stale target id. Sent as
       * a reserved key, not stored as metadata.
       */
      lineAccountId?: string | null
    },
  ): Promise<Target> {
    const acct = this.resolveScope(params?.lineAccountId)
    // Body assertions represent the unbound scope as null (the server compares
    // against line_account_id, which is NULL for legacy targets).
    const body =
      acct !== undefined ? { ...fields, lineAccountId: acct === '' ? null : acct } : fields
    const res = await this.http.put<ApiResponse<Target>>(
      `/api/targets/${targetType}/${encodeURIComponent(targetId)}/metadata`,
      body,
    )
    return res.data
  }

  async getConversation(
    targetType: TargetType,
    targetId: string,
    params?: {
      limit?: number
      before?: string
      /** Id of the message `before` came from — composite cursor so messages sharing a timestamp are not skipped across pages. */
      beforeId?: string
      /** Assert the owning account (defaults to LINE_HARNESS_ACCOUNT_ID); 409 if the target moved accounts. Empty string asserts the unbound (legacy) scope. */
      lineAccountId?: string | null
    },
  ): Promise<TargetConversation> {
    const query = new URLSearchParams()
    if (params?.limit !== undefined) query.set('limit', String(params.limit))
    if (params?.before !== undefined) query.set('before', params.before)
    if (params?.beforeId !== undefined) query.set('beforeId', params.beforeId)
    const acct = this.resolveScope(params?.lineAccountId)
    if (acct !== undefined) query.set('lineAccountId', acct ?? '')
    const qs = query.toString()
    const base = `/api/conversations/${targetType}/${encodeURIComponent(targetId)}`
    const res = await this.http.get<ApiResponse<TargetConversation>>(qs ? `${base}?${qs}` : base)
    return res.data
  }

  async sendMessage(
    targetType: TargetType,
    targetId: string,
    content: string,
    messageType: MessageType = 'text',
    altText?: string,
    sender?: MessageSenderSelection,
    options?: {
      /**
       * Wrap URLs in the message with per-account tracked short links on the
       * worker (default true). Tracking happens server-side — callers must not
       * pre-track content themselves.
       */
      trackLinks?: boolean
      /**
       * Assert the owning account. Defaults to LINE_HARNESS_ACCOUNT_ID
       * (config.lineAccountId); the server rejects (409) if the target has
       * since moved to another account, so a scoped client can't push under
       * another account's token via a stale target id. Empty string / null
       * asserts the unbound (legacy) scope.
       */
      lineAccountId?: string | null
    },
  ): Promise<{ messageId: string }> {
    const acct = this.resolveScope(options?.lineAccountId)
    const res = await this.http.post<ApiResponse<{ messageId: string }>>(
      `/api/targets/${targetType}/${encodeURIComponent(targetId)}/messages`,
      {
        messageType,
        content,
        ...(altText ? { altText } : {}),
        ...(sender ?? {}),
        ...(options?.trackLinks !== undefined ? { trackLinks: options.trackLinks } : {}),
        // Body assertions use null for the unbound scope.
        ...(acct !== undefined ? { lineAccountId: acct === '' ? null : acct } : {}),
      },
    )
    return res.data
  }
}
