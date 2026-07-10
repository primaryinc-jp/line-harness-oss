# Group/Room Conversation Targets

LINE グループ・複数人トーク（room）を、1:1 の友だちと同じように
一覧・取得・metadata 連携・会話取得・送信できる「target」として扱う機能。
sales-harness の P0 グループ対応要件
（`sales-harness/docs/LINE_GROUP_SUPPORT_REQUIREMENTS.md`）に対応する。

## 登録タイミング

target は次のタイミングで自動登録される（過去グループの取り込みは対象外）。

- 公式アカウントがグループ/ルームに招待された（`join` イベント）
- グループ/ルーム内でメッセージが発生した

`leave` イベントで `isActive=false` になる。join/leave の状態遷移は
`event.timestamp` でガードされ、順序が入れ替わった webhook 再配信
（leave 後に届く古い join/message）が退出済み target を再 active 化する
ことはない。未登録 target への leave は inactive の tombstone 行として
保存され、後から届く stale join の再登録もブロックする。グループ名・アイコンは
join 時と名前未取得時に LINE の group summary API から best-effort で取得する
（room には summary API がないため fallback 名になる）。

グループ内の受信メッセージは `target_messages_log` に発言者
（`senderLineUserId` / `senderDisplayName`）付きで記録される。
`created_at` には LINE の `event.timestamp`（実発言時刻）を使い、
target の `lastMessageAt` は単調増加（遅延・再配信された古い発言で
最新扱いにならない）。同時刻は `id` を tie-breaker に決定的に並ぶ。ページングは前ページ最古
メッセージの `createdAt` + `id` を `before` / `beforeId` として渡す複合
カーソル（同一時刻がページ境界をまたいでも欠落しない）。
LINE の webhook 再送（redelivery）は LINE message ID
（`(target_id, line_message_id)` の UNIQUE 制約）で冪等に排除される。
自動返信・シナリオはグループには適用されない（friend 専用のまま）。

## API

すべて既存の Bearer 認証（`/api/*`）配下。`:targetId` は harness の行 ID
または LINE の groupId/roomId のどちらでも解決される。

```text
GET  /api/targets?type=group|room&lineAccountId=&includeInactive=&limit=&offset=
GET  /api/targets?metadata.salesCustomerPageId=...   # 顧客/商談からの逆引き
GET  /api/targets/:targetType/:targetId              # 参加者（発言者由来）つき詳細
PUT  /api/targets/:targetType/:targetId/metadata     # friend metadata と同じマージ更新
GET  /api/conversations/:targetType/:targetId        # 会話取得（発言者付き、ASC）
     ?limit=&before=&beforeId=                       # ページングは (createdAt, id) の複合カーソル
POST /api/targets/:targetType/:targetId/messages     # text/image/flex 送信
```

- metadata は friends と同じ JSON マージ方式なので、sales-harness の
  `salesCustomerPageId` / `salesDealPageId` などの `sales*` フィールドを
  そのまま read/write できる
- `?metadata.key=value` フィルタ（friends と同じ contract）で
  「この顧客/商談に紐づく全 target」を逆引きできる。1顧客に
  個人トーク（friend）とグループ（target）が両方紐づくケースは、
  friends 側 `GET /api/friends?metadata.salesCustomerPageId=...` と
  合わせて集約する（送信先が複数あるときに自動選択しないのは
  呼び出し側 workflow の責務）
- 送信 body は friend 送信と同じ:
  `{ messageType?, content, altText?, senderMode?, senderStaffId?, trackLinks? }`。
  URL の計測リンク変換はサーバー側で行う（`trackLinks: false` で無効化。
  呼び出し側での pre-tracking は不要・非推奨）。作成される短縮リンクは
  target の所属アカウント（`line_account_id`）を所有者として持ち、
  LINE アプリ内クリックはそのアカウントの LIFF 経由で解決される
- bot が退出済み（`isActive=false`）の target への送信は 409
- `limit` は 1..200 の整数、`offset` は 0 以上の整数。範囲外・非数値は 400

## SDK / MCP

- SDK: `client.targets.list / get / setMetadata / getConversation / sendMessage`
- MCP: `manage_targets`（list / get / set_metadata）、
  `get_conversation` と `send_message` は `targetType` + `targetId` 指定で
  グループ/ルームに対応
- MCP の送信先/会話は exactly-one 制約: `friendId` XOR
  `targetType`+`targetId`。両方指定・不完全指定はエラーになる
- `manage_targets set_metadata` は既存の `salesCustomerPageId` /
  `salesDealPageId` を別の値へ上書きする場合 `force: true` が必須
  （1 target = 1 primary 顧客/商談の前提を無警告で壊さないため）

## Capabilities

`GET /api/capabilities` の `features` に `targets` / `group_conversations` が
含まれるかで対応可否を判定する。`identity.targets` に identity 契約がある:

- `types: ['group', 'room']` — 対応 targetType
- `primaryKey: 'target_id'` — 正規 ID は harness 行 ID（レスポンスの `id`）
- `acceptedIds` — パスの `:targetId` は harness ID に加え raw LINE
  groupId/roomId も解決される
- `friendsAddressable: false` — friend は `/api/targets` では扱えない
  （1:1 は従来どおり `/api/friends`）

## スキーマ

migration `901_primaryinc_line_targets.sql`（fork-local 900番台 prefix、`schema.sql` にも同梱）:

- `line_targets` — target 本体。`target_type`（group|room）、
  `line_target_id`（UNIQUE）、`display_name`、`metadata`、`last_message_at`、
  `membership_updated_at`（最後に適用した join/leave の event.timestamp）など
- `target_messages_log` — グループ用メッセージログ。`messages_log` は
  `friend_id NOT NULL` のため並列テーブルとして追加
