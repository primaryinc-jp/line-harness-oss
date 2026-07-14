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
- **アカウント所有権の表明（`lineAccountId`）**: read（詳細・会話）は query
  `?lineAccountId=`、送信は body の `lineAccountId` で「この target を所有する
  はずのアカウント」を表明できる。指定した値が現在の所有者と異なる場合は 409
  （グループが別アカウントに移った後に古い target ID で読取り・送信するのを防ぐ）。
  空文字は「未紐付け（`line_account_id IS NULL`＝env トークンのみのレガシー）」の
  表明。省略した場合は表明なし＝後方互換（SDK/MCP で `LINE_HARNESS_ACCOUNT_ID`
  未設定のとき）。会話・参加者は常に target の現在の所有者で絞り込まれるため、
  所有者交代後に前アカウント時代のメッセージ・発言者が混ざることはない。
  所有権は単調（monotonic）で、message/join は未紐付け target を初回バインド
  するのみ、既にバインド済みの所有者を再割り当てしない。真の交代は新しい
  membership イベント（join/leave の timestamp 比較）でのみ発生する
- `list` の `lineAccountId` は 3 値: 省略＝全アカウント、値＝そのアカウント、
  空文字＝未紐付け（レガシー）のみ

## Known limitations（backlog: 安定チャネル識別子）

アカウント所有権は line_accounts の内部 ID で表現される。この ID はアカウント
削除で失われるため、以下は現状「安全側（漏洩なし）に倒す」挙動になっている。
恒久対応には削除をまたいで安定するチャネル識別子（channel_id ベース）の導入が
必要で、別タスクとして backlog 管理する。

- **アカウント削除**: 削除された account の target と履歴は dangling ID のまま
  残り「orphaned」になる（NULL 化しない）。orphaned は全 scope で不可視になり、
  legacy（NULL）scope にも現れず env トークン送信にもフォールバックしない。
  代償として、削除後にその target へは UI/API からアクセスできなくなる
- **同一チャネル再作成**: 同じ LINE チャネルを新 account として作り直しても、
  orphaned target は新 account へ自動再アタッチされない（安定識別子が必要）
- **レガシー履歴の非移管**: env トークン（NULL 所有）運用から account 登録へ
  移行しても、NULL 期の履歴は account scope へ移管されない（NULL scope でのみ
  参照可能）。異なるチャネルの account が同一グループに同席するケースでの
  誤移管（漏洩）を防ぐための保守的な仕様

## SDK / MCP

- SDK: `client.targets.list / get / setMetadata / getConversation / sendMessage`
  — `LINE_HARNESS_ACCOUNT_ID`（`config.lineAccountId`）を設定すると list だけで
  なく get / getConversation / sendMessage も自動でその所有権を表明する
  （移動後の target への読取り・送信は 409）。呼び出し時に `lineAccountId` を
  明示すると上書きできる
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
