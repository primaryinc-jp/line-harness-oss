'use client'

import { useCallback, useRef, useState } from 'react'
import { api } from '@/lib/api'

export type ImageUploaderMode = 'url' | 'line-image' | 'line-sender-icon'

export type ImageUploaderValue =
  | { mode: 'url'; url: string }
  | { mode: 'line-image'; originalContentUrl: string; previewImageUrl: string }

export interface ImageUploaderProps {
  mode: ImageUploaderMode
  value: ImageUploaderValue | null
  onChange: (next: ImageUploaderValue | null) => void
  label?: string
}

/**
 * 汎用画像アップローダー: ボタン + D&D + クリップボードペースト + プレビュー。
 *
 * mode='url' は単一 URL を返す (Event / Staff など)。
 * mode='line-image' は {originalContentUrl, previewImageUrl} を返す (Broadcast / Auto-reply / Template / Chats)。
 * mode='line-sender-icon' は LINE sender.iconUrl 用に PNG / 1:1 / 1MB 以下へ正規化した URL を返す。
 * 初版は preview = original の同 URL。後段で本格 resize が必要になれば worker 側で対応。
 */
export default function ImageUploader({ mode, value, onChange, label }: ImageUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [manualUrlMode, setManualUrlMode] = useState(false)

  const normalizeSenderIcon = useCallback(async (file: File): Promise<File> => {
    const objectUrl = URL.createObjectURL(file)
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('画像を読み込めませんでした'))
        img.src = objectUrl
      })

      const sourceSize = Math.min(image.naturalWidth, image.naturalHeight)
      const sourceX = Math.floor((image.naturalWidth - sourceSize) / 2)
      const sourceY = Math.floor((image.naturalHeight - sourceSize) / 2)

      for (const size of [512, 384, 256, 192, 128]) {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('画像を変換できませんでした')
        ctx.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size)

        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (!blob) throw new Error('画像を変換できませんでした')
        if (blob.size <= 1024 * 1024) {
          const baseName = file.name.replace(/\.[^.]*$/, '') || 'sender-icon'
          return new File([blob], `${baseName}.png`, { type: 'image/png' })
        }
      }
    } finally {
      URL.revokeObjectURL(objectUrl)
    }

    throw new Error('1MB 以下の PNG に変換できませんでした')
  }, [])

  const upload = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setError('画像ファイルのみアップロードできます')
        return
      }
      let uploadFile = file
      if (mode === 'line-sender-icon') {
        try {
          uploadFile = await normalizeSenderIcon(file)
        } catch (err) {
          setError(err instanceof Error ? err.message : '画像を変換できませんでした')
          return
        }
      }
      if (mode === 'line-image' && !['image/jpeg', 'image/png'].includes(file.type)) {
        setError('LINE 送信用は JPEG または PNG のみ対応')
        return
      }
      if (mode === 'line-image' && file.size > 1024 * 1024) {
        setError('LINE 送信用は 1MB 以下にしてください (preview サイズ制限)')
        return
      }
      if (uploadFile.size > 10 * 1024 * 1024) {
        setError('10MB 以下にしてください')
        return
      }
      setBusy(true)
      setError('')
      try {
        const res = await api.uploads.image(uploadFile)
        if (!res.success) {
          setError(res.error ?? 'アップロード失敗')
          return
        }
        const url = res.data.url
        if (mode === 'line-image') {
          onChange({ mode: 'line-image', originalContentUrl: url, previewImageUrl: url })
        } else {
          onChange({ mode: 'url', url })
        }
      } catch {
        setError('アップロード失敗')
      } finally {
        setBusy(false)
      }
    },
    [mode, normalizeSenderIcon, onChange],
  )

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const f = files?.[0]
      if (f) void upload(f)
    },
    [upload],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      handleFiles(e.dataTransfer.files)
    },
    [handleFiles],
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) void upload(file)
    },
    [upload],
  )

  const previewUrl =
    value === null
      ? null
      : value.mode === 'url'
        ? value.url
        : value.previewImageUrl

  return (
    <div className="space-y-2">
      {label && <div className="text-sm font-medium text-gray-700">{label}</div>}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setManualUrlMode((v) => !v)}
          className="text-xs text-emerald-700 underline"
        >
          {manualUrlMode ? '画像アップロードに戻す' : 'URL を直接入力'}
        </button>
      </div>
      {manualUrlMode ? (
        <input
          type="url"
          value={
            value === null
              ? ''
              : value.mode === 'url'
                ? value.url
                : value.originalContentUrl
          }
          onChange={(e) => {
            const url = e.target.value
            if (!url) {
              onChange(null)
              return
            }
            if (mode === 'url') {
              onChange({ mode: 'url', url })
            } else {
              onChange({ mode: 'line-image', originalContentUrl: url, previewImageUrl: url })
            }
          }}
          placeholder="https://... (外部 CDN / R2 URL)"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
      ) : (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          onPaste={onPaste}
          tabIndex={0}
          className="rounded-lg border-2 border-dashed border-gray-300 bg-white p-4 transition-colors hover:border-gray-400 focus:border-emerald-500 focus:outline-none"
        >
          {previewUrl ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="" className="h-24 w-24 rounded object-cover ring-1 ring-gray-200" />
              <div className="flex-1 space-y-2">
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="text-xs font-medium text-gray-700 underline"
                >
                  差し替え
                </button>
                <button
                  type="button"
                  onClick={() => onChange(null)}
                  className="ml-3 text-xs font-medium text-rose-600 underline"
                >
                  取り消し
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-4 text-sm text-gray-500">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? 'アップロード中…' : '📎 画像を選択'}
              </button>
              <div className="text-xs text-gray-400">またはドラッグ&ドロップ / Cmd+V でペースト</div>
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={mode === 'line-image' ? 'image/jpeg,image/png' : 'image/*'}
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      )}
      {error && <div className="text-xs text-rose-600">{error}</div>}
    </div>
  )
}
