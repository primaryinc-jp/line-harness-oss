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

  async list(params?: TargetListParams): Promise<TargetListResponse> {
    const query = new URLSearchParams()
    if (params?.type) query.set('type', params.type)
    // Same default scoping as friends/conversations: LINE_HARNESS_ACCOUNT_ID
    // (config.lineAccountId) must narrow target lists too, or a scoped MCP
    // would list/reverse-look-up targets across every account.
    const accountId = params?.lineAccountId ?? this.defaultAccountId
    if (accountId) query.set('lineAccountId', accountId)
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

  async get(targetType: TargetType, targetId: string): Promise<TargetDetail> {
    const res = await this.http.get<ApiResponse<TargetDetail>>(
      `/api/targets/${targetType}/${encodeURIComponent(targetId)}`,
    )
    return res.data
  }

  async setMetadata(
    targetType: TargetType,
    targetId: string,
    fields: Record<string, unknown>,
  ): Promise<Target> {
    const res = await this.http.put<ApiResponse<Target>>(
      `/api/targets/${targetType}/${encodeURIComponent(targetId)}/metadata`,
      fields,
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
    },
  ): Promise<TargetConversation> {
    const query = new URLSearchParams()
    if (params?.limit !== undefined) query.set('limit', String(params.limit))
    if (params?.before !== undefined) query.set('before', params.before)
    if (params?.beforeId !== undefined) query.set('beforeId', params.beforeId)
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
    },
  ): Promise<{ messageId: string }> {
    const res = await this.http.post<ApiResponse<{ messageId: string }>>(
      `/api/targets/${targetType}/${encodeURIComponent(targetId)}/messages`,
      {
        messageType,
        content,
        ...(altText ? { altText } : {}),
        ...(sender ?? {}),
        ...(options?.trackLinks !== undefined ? { trackLinks: options.trackLinks } : {}),
      },
    )
    return res.data
  }
}
