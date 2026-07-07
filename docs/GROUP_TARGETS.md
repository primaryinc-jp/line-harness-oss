# Group/Room Conversation Targets

LINE グループ・複数人トーク（room）を、1:1 の友だちと同じように
一覧・取得・metadata 連携・会話取得・送信できる「target」として扱う機能。
sales-harness の P0 グループ対応要件
（`sales-harness/docs/LINE_GROUP_SUPPORT_REQUIREMENTS.md`）に対応する。

## 登録タイミング

target は次のタイミングで自動登録される（過去グループの取り込みは対象外）。

- 公式アカウントがグループ/ルームに招待された（`join` イベント）
- グループ/ルーム内でメッセージが発生した

`leave` イベントで `isActive=false` になる。グループ名・アイコンは
join 時と名前未取得時に LINE の group summary API から best-effort で取得する
（room には summary API がないため fallback 名になる）。

グループ内の受信メッセージは `target_messages_log` に発言者
（`senderLineUserId` / `senderDisplayName`）付きで記録される。
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
  `{ messageType?, content, altText?, senderMode?, senderStaffId? }`
- bot が退出済み（`isActive=false`）の target への送信は 409

対応可否は `GET /api/capabilities` の `features` に `targets` /
`group_conversations` が含まれるかで判定できる。

## SDK / MCP

- SDK: `client.targets.list / get / setMetadata / getConversation / sendMessage`
- MCP: `manage_targets`（list / get / set_metadata）、
  `get_conversation` と `send_message` は `targetType` + `targetId` 指定で
  グループ/ルームに対応

## スキーマ

migration `047_line_targets.sql`（`schema.sql` にも同梱）:

- `line_targets` — target 本体。`target_type`（group|room）、
  `line_target_id`（UNIQUE）、`display_name`、`metadata`、`last_message_at` など
- `target_messages_log` — グループ用メッセージログ。`messages_log` は
  `friend_id NOT NULL` のため並列テーブルとして追加
