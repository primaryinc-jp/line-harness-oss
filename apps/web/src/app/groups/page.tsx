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

// Key a pending send outcome by account + target row id: the row id survives an
// ownership transfer, so the account must be part of the identity.
function scopeKey(accountId: string | null, rowId: string): string {
  return `${accountId ?? ''}::${rowId}`
}

export default function GroupsPage() {
  const {
    accounts,
    selectedAccountId,
    loading: accountLoading,
    error: accountError,
    refreshAccounts,
  } = useAccount()
  // Legacy single-tenant installs use only the environment LINE token and have
  // no account rows; their targets carry line_account_id = NULL. In that case
  // there is no cross-account leak, so an unscoped list query is correct.
  const hasAccounts = accounts.length > 0
  const [targets, setTargets] = useState<Target[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [includeInactive, setIncludeInactive] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TargetDetail | null>(null)
  const [messages, setMessages] = useState<TargetMessage[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [showAllParticipants, setShowAllParticipants] = useState(false)

  // Cap the header participant list; LINE groups can have hundreds of speakers
  // and an unbounded header would push the composer out of the overflow box.
  const PARTICIPANT_PREVIEW = 20

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
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const openedTargetRef = useRef<Target | null>(null)
  // A send outcome that completed after the operator navigated away. Keyed by
  // account + target row id (an ownership transfer keeps the row id, so the
  // account must be part of the key) and surfaced reactively when that exact
  // conversation is open again — so reopening still shows the result and the
  // operator doesn't blind-resend a group-wide message.
  const [pendingSend, setPendingSend] = useState<{ key: string; error?: string; notice?: string } | null>(null)

  const loadTargets = useCallback(async () => {
    const reqId = ++listReqRef.current
    setLoading(true)
    setListError(null)
    setMoreError(null)
    if (accountError) {
      // The account-load error branch renders its own retry; don't query.
      setLoading(false)
      return
    }
    // If accounts exist but none is selected yet (transient), stay empty rather
    // than issuing an unscoped query that would leak every account's targets.
    // With zero accounts (legacy env-token install) an unscoped query is safe.
    if (hasAccounts && !selectedAccountId) {
      setTargets([])
      setTotal(0)
      setLoading(false)
      return
    }
    try {
      const params = new URLSearchParams()
      // Empty string = legacy unbound scope (line_account_id IS NULL); a value
      // scopes to that account. Reaching here with no account means the legacy
      // install (hasAccounts && !selected already returned above).
      params.set('lineAccountId', selectedAccountId ?? '')
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
      // Surface the failure instead of rendering an empty list, which would
      // read as "no groups exist" and mislead operators into changing config.
      if (reqId === listReqRef.current) {
        setTargets([])
        setTotal(0)
        setListError('グループ一覧の取得に失敗しました。')
      }
    } finally {
      if (reqId === listReqRef.current) setLoading(false)
    }
  }, [selectedAccountId, includeInactive, hasAccounts, accountError])

  // The list is ordered by last_message_at (mutable), so appending by offset
  // would skip or duplicate rows when activity reorders the list between
  // requests. Instead re-fetch the whole prefix (offset 0, larger limit) and
  // replace, which is always internally consistent. The route caps limit at
  // 200; beyond that the button hides and we note the ceiling.
  const LIST_MAX = 200
  const loadMore = useCallback(async () => {
    if (loadingMore || targets.length >= total) return
    if (hasAccounts && !selectedAccountId) return
    const reqId = listReqRef.current
    const nextLimit = Math.min(targets.length + PAGE_SIZE, LIST_MAX)
    setLoadingMore(true)
    setMoreError(null)
    try {
      const params = new URLSearchParams()
      params.set('lineAccountId', selectedAccountId ?? '') // '' = legacy unbound scope
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
    } catch {
      // Keep the already-loaded rows; just report that loading more failed.
      if (reqId === listReqRef.current) setMoreError('追加の読み込みに失敗しました。')
    } finally {
      if (reqId === listReqRef.current) setLoadingMore(false)
    }
  }, [loadingMore, targets.length, total, selectedAccountId, includeInactive, hasAccounts])

  // Account or filter change: drop any open conversation and draft (they belong
  // to the previous scope) before reloading. Wait for the account context to
  // finish loading so the first request is always account-scoped.
  useEffect(() => {
    detailReqRef.current++ // invalidate any in-flight detail load
    openedTargetRef.current = null
    // Drop any pending send outcome on a scope change; it is re-evaluated by
    // key, but clearing keeps state tidy across account switches.
    setPendingSend(null)
    setSelectedId(null)
    setDetail(null)
    setMessages([])
    setDraft('')
    setSendError(null)
    setRefreshNotice(null)
    setDetailError(null)
    setShowAllParticipants(false)
    // The invalidated in-flight handlers skip their own cleanup on token
    // mismatch, so clear their loading flags here or the panes stay stuck.
    setDetailLoading(false)
    setLoadingMore(false)
    if (accountLoading) return
    loadTargets()
  }, [loadTargets, accountLoading])

  const fetchConversation = useCallback(
    async (target: Target): Promise<{ detail: TargetDetail | null; messages: TargetMessage[] }> => {
      // Assert the scope we loaded under: the server rejects (409) if the
      // target's ownership changed to another account, and scopes history +
      // participants to the current owner so a previous owner's rows don't leak.
      // Empty string asserts the legacy unbound (line_account_id IS NULL) scope.
      const acct = encodeURIComponent(selectedAccountId ?? '')
      const type = target.targetType
      const id = encodeURIComponent(target.targetId)
      const [detailRes, convoRes] = await Promise.all([
        fetchApi<{ success: boolean; data: TargetDetail }>(
          `/api/targets/${type}/${id}?lineAccountId=${acct}`,
        ),
        fetchApi<{ success: boolean; data: { messages: TargetMessage[] } }>(
          `/api/conversations/${type}/${id}?limit=100&lineAccountId=${acct}`,
        ),
      ])
      return {
        detail: detailRes.success ? detailRes.data : null,
        messages: convoRes.success ? convoRes.data.messages : [],
      }
    },
    [selectedAccountId],
  )

  const closeTarget = useCallback(() => {
    detailReqRef.current++ // invalidate any in-flight detail load
    openedTargetRef.current = null
    setSelectedId(null)
    setDetail(null)
    setMessages([])
    setDraft('')
    setSendError(null)
    setRefreshNotice(null)
    setDetailError(null)
    setDetailLoading(false)
    setShowAllParticipants(false)
  }, [])

  const openTarget = useCallback(
    async (target: Target) => {
      const reqId = ++detailReqRef.current
      openedTargetRef.current = target
      setSelectedId(target.id)
      setDetail(null)
      setMessages([])
      setDraft('')
      setSendError(null)
      setRefreshNotice(null)
      setDetailError(null)
      setShowAllParticipants(false)
      setDetailLoading(true)
      try {
        const { detail: d, messages: msgs } = await fetchConversation(target)
        if (reqId !== detailReqRef.current) return
        if (!d) {
          setDetailError('会話の取得に失敗しました。')
          setDetail(null)
        } else if (hasAccounts && (d.lineAccountId ?? null) !== (selectedAccountId ?? null)) {
          // Ownership changed since the list loaded — the target now belongs to
          // another account. Do not render its thread under the current scope.
          setDetail(null)
          setDetailError('この会話は別のアカウントに移動しました。一覧を再読み込みしてください。')
        } else {
          setDetail(d)
          setMessages(msgs)
          // A send outcome that completed while this target was closed is
          // surfaced by the reactive effect below (keyed by account + target).
        }
      } catch (err) {
        if (reqId === detailReqRef.current) {
          setDetail(null)
          const status = (err as { status?: number }).status
          setDetailError(
            status === 409
              ? 'この会話は別のアカウントに移動しました。一覧を再読み込みしてください。'
              : '会話の取得に失敗しました。',
          )
        }
      } finally {
        if (reqId === detailReqRef.current) setDetailLoading(false)
      }
    },
    [fetchConversation, hasAccounts, selectedAccountId],
  )

  const send = useCallback(async () => {
    if (!detail || !draft.trim()) return
    const target = detail
    const submitted = draft
    // The account this send is scoped to, captured now so a later navigation
    // can't misattribute the outcome to a different account.
    const sendAccount = selectedAccountId
    // Token as of the currently open conversation. If the operator switches
    // target or account mid-send, openTarget / the scope effect bumps this and
    // we must not touch the newer scope's state.
    const scopeToken = detailReqRef.current
    setSending(true)
    setSendError(null)
    setRefreshNotice(null)
    let outcome: 'sent' | 'failed' | 'unknown' = 'failed'
    let failMessage = '送信に失敗しました'
    try {
      const res = await fetchApi<{ success: boolean; error?: string }>(
        `/api/targets/${target.targetType}/${encodeURIComponent(target.targetId)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            content: draft,
            // Assert the scope we loaded under so the Worker rejects the send
            // if this target's ownership changed to another account meanwhile.
            lineAccountId: selectedAccountId,
            ...(senderMode === 'official' ? { senderMode: 'official' } : {}),
          }),
        },
      )
      // fetchApi throws on non-2xx, so a 200 with success:false is the only way
      // to land here on failure — keep it as a defensive branch.
      if (!res.success) {
        outcome = 'failed'
        failMessage = res.error ?? failMessage
      } else {
        outcome = 'sent'
      }
    } catch (err) {
      const status = (err as { status?: number }).status
      if (typeof status === 'number' && status >= 400 && status < 500) {
        // A definite rejection before delivery (e.g. 409 inactive target,
        // 4xx validation). Nothing was sent — show the actionable error and
        // do NOT prompt delivery verification.
        outcome = 'failed'
        const body = (err as { body?: { error?: string } }).body
        failMessage = body?.error ?? `送信できませんでした (${status})`
      } else {
        // 5xx / network: the Worker may have already pushed to the whole group
        // before failing (e.g. logging the message afterwards threw). A blind
        // retry would duplicate the group-wide delivery, so report an unknown
        // result and keep the draft.
        outcome = 'unknown'
      }
    } finally {
      setSending(false)
    }

    // The push may have succeeded even though logging it failed, in which case
    // the message was delivered to the whole group but will NOT appear in this
    // view (no log row). Do not tell the operator to judge by the in-app
    // refresh — direct them to verify in the actual LINE group.
    const uncertainNotice =
      '送信結果を確認できませんでした。すでに配信されている可能性があります（この管理画面には反映されない場合があります）。実際のLINEグループで着信を確認し、届いていない場合のみ再送してください。'

    // Only touch conversation-specific UI if this conversation is still open;
    // otherwise stash the outcome so reopening the target still surfaces it (and
    // the operator doesn't blind-resend a group-wide message).
    const scopeCurrent = detailReqRef.current === scopeToken
    if (scopeCurrent) {
      if (outcome === 'failed') {
        setSendError(failMessage)
      } else if (outcome === 'unknown') {
        setRefreshNotice(uncertainNotice)
      } else if (outcome === 'sent') {
        // Only clear the box if the operator hasn't started a new message since.
        setDraft((prev) => (prev === submitted ? '' : prev))
      }
    } else {
      const key = scopeKey(sendAccount, target.id)
      if (outcome === 'failed') {
        setPendingSend({ key, error: failMessage })
      } else if (outcome === 'unknown') {
        setPendingSend({ key, notice: uncertainNotice })
      } else if (outcome === 'sent') {
        setPendingSend({ key, notice: '送信は完了しました。' })
      }
    }

    // Refresh only if this conversation is still the selected scope.
    if ((outcome === 'sent' || outcome === 'unknown') && scopeCurrent) {
      const reqId = ++detailReqRef.current
      try {
        const { detail: d, messages: msgs } = await fetchConversation(target)
        if (reqId !== detailReqRef.current) return
        if (d && hasAccounts && (d.lineAccountId ?? null) !== (selectedAccountId ?? null)) {
          // Ownership changed under us — drop the conversation rather than
          // render another account's thread in the current scope.
          setDetail(null)
          setDetailError('この会話は別のアカウントに移動しました。一覧を再読み込みしてください。')
          return
        }
        setDetail(d)
        setMessages(msgs)
        // Reflect the refreshed target in the list. Only promote it to the top
        // (list is ordered by activity DESC) if last_message_at actually
        // advanced — for an unknown outcome that never reached the Worker the
        // timestamp is unchanged, and reordering would contradict the server.
        if (d) {
          setTargets((prev) => {
            const idx = prev.findIndex((t) => t.id === d.id)
            if (idx === -1) return prev
            const merged: Target = {
              ...prev[idx],
              displayName: d.displayName,
              isActive: d.isActive,
              metadata: d.metadata,
              lastMessageAt: d.lastMessageAt,
            }
            const prevAt = prev[idx].lastMessageAt
            const advanced =
              !!d.lastMessageAt &&
              (!prevAt || new Date(d.lastMessageAt).getTime() > new Date(prevAt).getTime())
            if (!advanced) {
              const copy = [...prev]
              copy[idx] = merged
              return copy
            }
            return [merged, ...prev.filter((_, i) => i !== idx)]
          })
        }
      } catch {
        if (reqId === detailReqRef.current && outcome === 'sent') {
          setRefreshNotice('送信は完了しましたが、会話の再読み込みに失敗しました。')
        }
      }
    }
  }, [detail, draft, senderMode, selectedAccountId, hasAccounts, fetchConversation])

  // The thread renders oldest→newest, so a freshly opened (or just-sent-to)
  // conversation must jump to the bottom to show the latest message. There is
  // no older-message pagination here, so this never fights a manual scroll-up.
  useEffect(() => {
    const el = messagesScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    // Depend on the newest message id, not the count: at the 100-message cap a
    // send replaces the oldest row so the length is unchanged, yet we still
    // need to jump to the newly appended message.
  }, [selectedId, messages.length ? messages[messages.length - 1].id : null])

  // Surface a send outcome that completed while its conversation was closed,
  // but only when that exact account+target conversation is the one now open.
  useEffect(() => {
    if (!pendingSend || !detail) return
    if (pendingSend.key !== scopeKey(selectedAccountId, detail.id)) return
    if (pendingSend.error) setSendError(pendingSend.error)
    if (pendingSend.notice) setRefreshNotice(pendingSend.notice)
    setPendingSend(null)
  }, [pendingSend, detail, selectedAccountId])

  return (
    <div className="flex flex-col">
      <Header title="グループ・複数人トーク" />
      {/* The AppShell already pads and scrolls; size to the remaining viewport
          rather than h-screen (which would overflow below the fold). */}
      <div className="mt-4 flex h-[calc(100vh-160px)] overflow-hidden rounded-lg border border-gray-200 lg:h-[calc(100vh-200px)]">
        {/* target list — full width on mobile, hidden once a target is open */}
        <aside
          className={`w-full flex-col border-r border-gray-200 bg-white lg:flex lg:w-80 ${
            selectedId ? 'hidden' : 'flex'
          }`}
        >
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
            ) : accountError ? (
              <div className="p-4 text-sm text-red-600">
                <p>アカウント情報の取得に失敗しました。</p>
                <button
                  onClick={() => refreshAccounts()}
                  className="mt-2 rounded border border-red-300 px-3 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  再試行
                </button>
              </div>
            ) : listError ? (
              <div className="p-4 text-sm text-red-600">
                <p>{listError}</p>
                <button
                  onClick={() => loadTargets()}
                  className="mt-2 rounded border border-red-300 px-3 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  再試行
                </button>
              </div>
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
                {moreError && (
                  <p className="px-4 py-2 text-xs text-red-600">{moreError}</p>
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

        {/* conversation — hidden on mobile until a target is selected */}
        <main
          className={`flex-1 flex-col bg-gray-50 lg:flex ${selectedId ? 'flex' : 'hidden'}`}
        >
          {detailLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
              読み込み中…
            </div>
          ) : detailError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-gray-500">
              <p className="text-red-600">{detailError}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => openedTargetRef.current && openTarget(openedTargetRef.current)}
                  className="rounded border border-emerald-300 px-3 py-1 text-xs text-emerald-600 hover:bg-emerald-50"
                >
                  再試行
                </button>
                <button
                  onClick={closeTarget}
                  className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  一覧に戻る
                </button>
              </div>
            </div>
          ) : !detail ? (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
              グループを選択してください
            </div>
          ) : detail ? (
            <>
              <div className="border-b border-gray-200 bg-white px-6 py-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={closeTarget}
                    className="text-gray-400 hover:text-gray-600 lg:hidden"
                    aria-label="一覧に戻る"
                  >
                    ←
                  </button>
                  <h2 className="text-base font-semibold text-gray-800">{detail.displayName}</h2>
                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-600">
                    {typeLabel[detail.targetType]}
                  </span>
                  {!detail.isActive && (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">退出済み</span>
                  )}
                </div>
                {detail.participants.length > 0 && (
                  <div className="mt-1 text-xs text-gray-500">
                    <span>発言者: </span>
                    {/* Expanded list is bounded + scrollable so a group with
                        hundreds of speakers can't push the composer out of the
                        fixed-height, overflow-hidden pane. */}
                    <div
                      className={
                        showAllParticipants ? 'mt-1 max-h-20 overflow-y-auto' : 'inline'
                      }
                    >
                      {(showAllParticipants
                        ? detail.participants
                        : detail.participants.slice(0, PARTICIPANT_PREVIEW)
                      )
                        .map((p) => p.displayName ?? p.lineUserId)
                        .join('、')}
                    </div>
                    {detail.participants.length > PARTICIPANT_PREVIEW && (
                      <button
                        onClick={() => setShowAllParticipants((v) => !v)}
                        className="ml-1 text-emerald-600 hover:underline"
                      >
                        {showAllParticipants
                          ? '折りたたむ'
                          : `他 ${detail.participants.length - PARTICIPANT_PREVIEW} 名`}
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div ref={messagesScrollRef} className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
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
