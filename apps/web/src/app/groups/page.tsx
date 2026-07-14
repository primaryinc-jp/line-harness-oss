'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchApi } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'

// Group/room conversation targets admin view. Deliberately separate from the
// friend-centric /chats page: targets have no friend row, messages carry a
// speaker, and auto-reply/scenario never apply — mixing them into the 1:1 chat
// UI would tangle both flows. See docs/GROUP_TARGETS.md.

const PAGE_SIZE = 50

interface Target {
  id: string
  targetType: 'group' | 'room'
  targetId: string
  displayName: string
  pictureUrl: string | null
  isActive: boolean
  lineAccountId: string | null
  metadata: Record<string, unknown>
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
}

interface TargetParticipant {
  lineUserId: string
  displayName: string | null
  lastSpokeAt: string
}

interface TargetMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  senderLineUserId: string | null
  senderDisplayName: string | null
  senderName: string | null
  createdAt: string
}

interface TargetDetail extends Target {
  participants: TargetParticipant[]
}

const typeLabel: Record<Target['targetType'], string> = {
  group: 'グループ',
  room: '複数人トーク',
}

function formatDatetime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function renderContent(m: Pick<TargetMessage, 'messageType' | 'content'>): string {
  if (m.messageType === 'text') return m.content
  if (m.messageType === 'image') {
    try {
      const parsed = JSON.parse(m.content) as { originalContentUrl?: string }
      return parsed.originalContentUrl ? `[画像] ${parsed.originalContentUrl}` : '[画像]'
    } catch {
      return '[画像]'
    }
  }
  return `[${m.messageType}]`
}

export default function GroupsPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [targets, setTargets] = useState<Target[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [includeInactive, setIncludeInactive] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TargetDetail | null>(null)
  const [messages, setMessages] = useState<TargetMessage[]>([])
  const [detailLoading, setDetailLoading] = useState(false)

  // Send form
  const [draft, setDraft] = useState('')
  const [senderMode, setSenderMode] = useState<'staff' | 'official'>('staff')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null)

  // Monotonic request tokens. Every account switch / target switch bumps the
  // relevant ref; async handlers apply their result only if their token is
  // still current, so a slow response can never overwrite a newer selection
  // (which would otherwise let an operator send to the wrong account/group).
  const listReqRef = useRef(0)
  const detailReqRef = useRef(0)

  const loadTargets = useCallback(async () => {
    const reqId = ++listReqRef.current
    setLoading(true)
    // No account selected once loading is done means there are no accounts —
    // never issue an unscoped /api/targets request that would leak every
    // account's targets.
    if (!selectedAccountId) {
      setTargets([])
      setTotal(0)
      setLoading(false)
      return
    }
    try {
      const params = new URLSearchParams()
      params.set('lineAccountId', selectedAccountId)
      if (includeInactive) params.set('includeInactive', 'true')
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', '0')
      const res = await fetchApi<{ success: boolean; data: { items: Target[]; total: number } }>(
        `/api/targets?${params.toString()}`,
      )
      if (reqId !== listReqRef.current) return
      if (res.success) {
        setTargets(res.data.items)
        setTotal(res.data.total)
      }
    } catch {
      if (reqId === listReqRef.current) {
        setTargets([])
        setTotal(0)
      }
    } finally {
      if (reqId === listReqRef.current) setLoading(false)
    }
  }, [selectedAccountId, includeInactive])

  // The list is ordered by last_message_at (mutable), so appending by offset
  // would skip or duplicate rows when activity reorders the list between
  // requests. Instead re-fetch the whole prefix (offset 0, larger limit) and
  // replace, which is always internally consistent. The route caps limit at
  // 200; beyond that the button hides and we note the ceiling.
  const LIST_MAX = 200
  const loadMore = useCallback(async () => {
    if (loadingMore || targets.length >= total || !selectedAccountId) return
    const reqId = listReqRef.current
    const nextLimit = Math.min(targets.length + PAGE_SIZE, LIST_MAX)
    setLoadingMore(true)
    try {
      const params = new URLSearchParams()
      params.set('lineAccountId', selectedAccountId)
      if (includeInactive) params.set('includeInactive', 'true')
      params.set('limit', String(nextLimit))
      params.set('offset', '0')
      const res = await fetchApi<{ success: boolean; data: { items: Target[]; total: number } }>(
        `/api/targets?${params.toString()}`,
      )
      // A concurrent account/filter change bumps listReqRef; discard this page.
      if (reqId !== listReqRef.current) return
      if (res.success) {
        setTargets(res.data.items)
        setTotal(res.data.total)
      }
    } finally {
      if (reqId === listReqRef.current) setLoadingMore(false)
    }
  }, [loadingMore, targets.length, total, selectedAccountId, includeInactive])

  // Account or filter change: drop any open conversation and draft (they belong
  // to the previous scope) before reloading. Wait for the account context to
  // finish loading so the first request is always account-scoped.
  useEffect(() => {
    detailReqRef.current++ // invalidate any in-flight detail load
    setSelectedId(null)
    setDetail(null)
    setMessages([])
    setDraft('')
    setSendError(null)
    setRefreshNotice(null)
    // The invalidated in-flight handlers skip their own cleanup on token
    // mismatch, so clear their loading flags here or the panes stay stuck.
    setDetailLoading(false)
    setLoadingMore(false)
    if (accountLoading) return
    loadTargets()
  }, [loadTargets, accountLoading])

  const fetchConversation = useCallback(
    async (target: Target): Promise<{ detail: TargetDetail | null; messages: TargetMessage[] }> => {
      const [detailRes, convoRes] = await Promise.all([
        fetchApi<{ success: boolean; data: TargetDetail }>(
          `/api/targets/${target.targetType}/${encodeURIComponent(target.targetId)}`,
        ),
        fetchApi<{ success: boolean; data: { messages: TargetMessage[] } }>(
          `/api/conversations/${target.targetType}/${encodeURIComponent(target.targetId)}?limit=100`,
        ),
      ])
      return {
        detail: detailRes.success ? detailRes.data : null,
        messages: convoRes.success ? convoRes.data.messages : [],
      }
    },
    [],
  )

  const openTarget = useCallback(
    async (target: Target) => {
      const reqId = ++detailReqRef.current
      setSelectedId(target.id)
      setDetail(null)
      setMessages([])
      setDraft('')
      setSendError(null)
      setRefreshNotice(null)
      setDetailLoading(true)
      try {
        const { detail: d, messages: msgs } = await fetchConversation(target)
        if (reqId !== detailReqRef.current) return
        setDetail(d)
        setMessages(msgs)
      } catch {
        if (reqId === detailReqRef.current) setDetail(null)
      } finally {
        if (reqId === detailReqRef.current) setDetailLoading(false)
      }
    },
    [fetchConversation],
  )

  const send = useCallback(async () => {
    if (!detail || !draft.trim()) return
    const target = detail
    // Token as of the currently open conversation. If the operator switches
    // target or account mid-send, openTarget / the scope effect bumps this and
    // we must not touch the newer scope's state.
    const scopeToken = detailReqRef.current
    setSending(true)
    setSendError(null)
    setRefreshNotice(null)
    let outcome: 'sent' | 'failed' | 'unknown' = 'failed'
    try {
      const res = await fetchApi<{ success: boolean; error?: string }>(
        `/api/targets/${target.targetType}/${encodeURIComponent(target.targetId)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            content: draft,
            ...(senderMode === 'official' ? { senderMode: 'official' } : {}),
          }),
        },
      )
      if (!res.success) {
        // Server explicitly rejected — nothing was delivered, safe to retry.
        outcome = 'failed'
        setSendError(res.error ?? '送信に失敗しました')
      } else {
        outcome = 'sent'
        setDraft('')
      }
    } catch {
      // Transport error: the Worker may have already pushed to the whole group
      // before failing (e.g. logging the message afterwards threw). Presenting
      // this as a definite failure invites a blind retry that duplicates the
      // group-wide delivery. Report an unknown result and keep the draft.
      outcome = 'unknown'
      setRefreshNotice(
        '送信結果を確認できませんでした。会話を再読み込みして反映を確認し、届いていない場合のみ再送してください。',
      )
    } finally {
      setSending(false)
    }
    // Refresh only if this conversation is still the selected scope. A refresh
    // failure after a successful send must NOT read as a send failure.
    if (outcome === 'sent' || outcome === 'unknown') {
      if (detailReqRef.current !== scopeToken) return
      const reqId = ++detailReqRef.current
      try {
        const { detail: d, messages: msgs } = await fetchConversation(target)
        if (reqId !== detailReqRef.current) return
        setDetail(d)
        setMessages(msgs)
      } catch {
        if (reqId === detailReqRef.current && outcome === 'sent') {
          setRefreshNotice('送信は完了しましたが、会話の再読み込みに失敗しました。')
        }
      }
    }
  }, [detail, draft, senderMode, fetchConversation])

  return (
    <div className="flex h-screen flex-col">
      <Header title="グループ・複数人トーク" />
      <div className="flex flex-1 overflow-hidden">
        {/* target list */}
        <aside className="flex w-80 flex-col border-r border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <span className="text-sm font-medium text-gray-700">
              {targets.length}
              {total > targets.length ? ` / ${total}` : ''} 件
            </span>
            <label className="flex items-center gap-1.5 text-xs text-gray-500">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
              />
              退出済みも表示
            </label>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <p className="p-4 text-sm text-gray-400">読み込み中…</p>
            ) : targets.length === 0 ? (
              <p className="p-4 text-sm text-gray-400">
                グループがありません。公式アカウントをグループに招待するか、グループで発言があると登録されます。
              </p>
            ) : (
              <>
                {targets.map((target) => (
                  <button
                    key={target.id}
                    onClick={() => openTarget(target)}
                    className={`flex w-full items-start gap-3 border-b border-gray-50 px-4 py-3 text-left hover:bg-gray-50 ${
                      selectedId === target.id ? 'bg-emerald-50' : ''
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-gray-800">
                          {target.displayName}
                        </span>
                        {!target.isActive && (
                          <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                            退出済み
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-600">
                          {typeLabel[target.targetType]}
                        </span>
                        <span>{formatDatetime(target.lastMessageAt)}</span>
                      </div>
                      {typeof target.metadata.salesCustomerPageId === 'string' && (
                        <span className="mt-1 inline-block rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600">
                          顧客紐付け済み
                        </span>
                      )}
                    </div>
                  </button>
                ))}
                {targets.length < total && targets.length < LIST_MAX && (
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="w-full px-4 py-3 text-sm text-emerald-600 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {loadingMore ? '読み込み中…' : `さらに読み込む（残り ${total - targets.length} 件）`}
                  </button>
                )}
                {targets.length >= LIST_MAX && total > LIST_MAX && (
                  <p className="px-4 py-3 text-xs text-gray-400">
                    上限 {LIST_MAX} 件を表示中。絞り込みには顧客紐付けからの逆引き（API）をご利用ください。
                  </p>
                )}
              </>
            )}
          </div>
        </aside>

        {/* conversation */}
        <main className="flex flex-1 flex-col bg-gray-50">
          {!detail && !detailLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
              グループを選択してください
            </div>
          ) : detailLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
              読み込み中…
            </div>
          ) : detail ? (
            <>
              <div className="border-b border-gray-200 bg-white px-6 py-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-gray-800">{detail.displayName}</h2>
                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-600">
                    {typeLabel[detail.targetType]}
                  </span>
                  {!detail.isActive && (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">退出済み</span>
                  )}
                </div>
                {detail.participants.length > 0 && (
                  <p className="mt-1 text-xs text-gray-500">
                    発言者: {detail.participants.map((p) => p.displayName ?? p.lineUserId).join('、')}
                  </p>
                )}
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
                {messages.length === 0 ? (
                  <p className="text-sm text-gray-400">メッセージがありません</p>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      className={`flex flex-col ${m.direction === 'outgoing' ? 'items-end' : 'items-start'}`}
                    >
                      <span className="mb-0.5 text-[11px] text-gray-400">
                        {m.direction === 'outgoing'
                          ? `送信${m.senderName ? ` (${m.senderName})` : ''}`
                          : m.senderDisplayName ?? m.senderLineUserId ?? 'メンバー'}
                        {' · '}
                        {formatDatetime(m.createdAt)}
                      </span>
                      <div
                        className={`max-w-[70%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                          m.direction === 'outgoing'
                            ? 'bg-emerald-500 text-white'
                            : 'bg-white text-gray-800 shadow-sm'
                        }`}
                      >
                        {renderContent(m)}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* send box */}
              <div className="border-t border-gray-200 bg-white px-6 py-3">
                {!detail.isActive ? (
                  <p className="text-sm text-gray-400">
                    このグループから退出済みのため送信できません。
                  </p>
                ) : (
                  <>
                    {sendError && (
                      <p className="mb-2 text-xs text-red-600">{sendError}</p>
                    )}
                    {refreshNotice && (
                      <p className="mb-2 text-xs text-amber-600">{refreshNotice}</p>
                    )}
                    <div className="flex items-end gap-2">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="メッセージを入力（グループ全員に届きます）"
                        rows={2}
                        className="flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-400 focus:outline-none"
                      />
                      <div className="flex flex-col gap-1.5">
                        <select
                          value={senderMode}
                          onChange={(e) => setSenderMode(e.target.value as 'staff' | 'official')}
                          className="rounded border border-gray-300 px-2 py-1 text-xs"
                        >
                          <option value="staff">担当者として</option>
                          <option value="official">公式アカウントとして</option>
                        </select>
                        <button
                          onClick={send}
                          disabled={sending || !draft.trim()}
                          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                        >
                          {sending ? '送信中…' : '送信'}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : null}
        </main>
      </div>
    </div>
  )
}
