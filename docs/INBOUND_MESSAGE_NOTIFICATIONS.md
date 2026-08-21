# 受信メッセージ通知 — 引き継ぎドキュメント

お客さんから LINE メッセージが届いたときに、担当者がリアルタイムで気づけるようにする。

このドキュメントは実装前の調査結果と設計方針をまとめたもの。**まだ何も実装していない。**
調査時点: 2026-08-21 / `origin/main` = `1127518`（upstream v0.22.0 取り込み後）

---

## 1. 何を作るのか

**ゴール**: 顧客からメッセージが届いたら、担当者のスマホにプッシュ通知が飛ぶ。

**現状の問題**: 管理画面 (`/chats`) を開いていないと受信に気づけない。専用のモバイルアプリは無い。

**方針**: LINE Harness 本体は**改造しない**。既存の「送信 Webhook」から、通知先サービス（Slack / Discord / メール）の形式に変換する**中継 Worker を1つ**立てるだけにする。

```
LINE → Worker (/webhook) → fireEvent('message_received')
                              ↓ 送信Webhook (HMAC署名付きPOST)
                        中継 Worker (新規・20行程度)
                              ↓ 形式変換
                        Slack / Discord / メール → スマホ通知
```

### なぜ本体を改造しないのか

このリポジトリは upstream (`Shudesu/line-harness-oss`) のフォークで、定期的に本流を取り込んでいる。本体に手を入れるほど次回の取り込みで衝突する。実際 2026-08-21 の取り込みでは、フォーク独自の変更が理由で13ファイルが衝突した（詳細は PR #8）。

通知は本体の機能に依存しない「外付け」で実現できるので、衝突面を増やさないのが妥当。

### なぜ Slack / Discord に直結できないのか

送信 Webhook のペイロードは後述の独自形式。Slack の Incoming Webhook は `{"text": "..."}`、Discord は `{"content": "..."}` という固定形式しか受け付けないため、間に変換が要る。

---

## 2. 既に用意されているもの

作る前に、本体側に何があるかを把握しておくこと。

### 2.1 イベントバス

顧客がテキストメッセージを送ると `apps/worker/src/routes/webhook.ts` で `message_received` イベントが発火する。

```ts
await fireEvent(db, 'message_received', {
  friendId: friend.id,
  eventData: { text: incomingText, matched },
  replyToken: replyTokenConsumed ? undefined : event.replyToken,
}, lineAccessToken, lineAccountId);
```

`fireEvent` は `apps/worker/src/services/event-bus.ts` にあり、送信 Webhook・スコアリング・オートメーション・通知ルールを並行実行する。

**実際に発火するイベントタイプ（`fireEvent` 呼び出し箇所を全部 grep した結果）**:

| イベント | 発火タイミング |
|---|---|
| `message_received` | 顧客が**テキスト**メッセージを送信 |
| `postback_received` | リッチメニュー等のポストバック |
| `friend_add` | 友だち追加 |
| `tag_change` | タグの付与・削除 |
| `cv_fire` | Stripe 決済等のコンバージョン |

### 2.2 送信 Webhook

管理画面の `/webhooks` →「outgoing」タブから登録する。API は `POST /api/webhooks/outgoing`。

テーブル `outgoing_webhooks` (`packages/db/schema.sql`):

| カラム | 内容 |
|---|---|
| `name` | 表示名 |
| `url` | 送信先。**https 必須**（`validateHttpsUrl`） |
| `event_types` | JSON配列。`["message_received"]` または `["*"]` |
| `secret` | HMAC署名用。**32文字以上必須**（`MIN_SECRET_LENGTH`） |
| `is_active` | 有効フラグ |

送信されるボディ（`fireOutgoingWebhooks`）:

```json
{
  "event": "message_received",
  "timestamp": "2026-08-21T17:20:00.000+09:00",
  "data": {
    "friendId": "<uuid>",
    "eventData": { "text": "見積もりお願いします", "matched": false },
    "replyToken": "<LINEのreplyToken>"
  }
}
```

`secret` を設定すると `X-Webhook-Signature` ヘッダーに、ボディの HMAC-SHA256 を16進文字列で付与する。中継 Worker 側で必ず検証すること（後述）。

---

## 3. 実装前に知っておくべき「落とし穴」

**ここが本ドキュメントの主眼。** コードを読まないと分からない挙動を先に共有する。

### 3.1 【重要】画像・スタンプでは通知が飛ばない

`message_received` が発火するのは**テキストメッセージのときだけ**。

`apps/worker/src/routes/webhook.ts` は非テキスト（画像・スタンプ・動画・ファイル）を別の分岐で処理し、`messages_log` への記録とマイレージ付与だけして `return` する。`fireEvent` を呼ばない。

顧客が画像だけ送ってきたケースを取りこぼす。要件次第では本体側の対応が必要になるが、その場合は upstream との衝突を覚悟すること。

### 3.2 【重要】グループ/複数人トークのメッセージでも通知が飛ばない

このフォーク独自の「グループ/ルームターゲット」機能では、グループ由来のイベントは `handleEvent` の冒頭で `handleTargetEvent` に振り分けられ、そこで `return` する（1:1 の経路には落ちてこない）。

`apps/worker/src/services/target-webhook.ts` はメッセージを `logTargetMessage` で記録するだけで、**イベントバスを発火しない**。

顧客とのやりとりがグループ中心なら、この方式では通知が一切飛ばない。**着手前に「顧客からのメッセージ」が 1:1 なのかグループなのかを必ず確認すること。**

なお、グループ退出時のみ `createNotification`（`channel: 'dashboard'`）でダッシュボード通知を作る実装がある（`target-webhook.ts` の `line_target_left`）。これは管理画面内の通知であって、プッシュ通知ではない。

### 3.3 【重要】管理画面のプレースホルダー表記が実際のイベント名と違う

`/webhooks` のイベントタイプ入力欄のプレースホルダーは `friend.added, message.received`（**ドット区切り**）だが、実際に発火するのは `friend_add`, `message_received`（**アンダースコア**）。

プレースホルダー通りに入力すると**エラーも出ずに一生発火しない**。`message_received` と入力すること。

### 3.4 送信失敗はリトライされない

`fireOutgoingWebhooks` は `await fetch(...)` を try/catch で囲み、失敗時は `console.error` するだけ。リトライもデッドレターキューも無い。

通知先が一時的に落ちていたら、その通知は**永久に失われる**。取りこぼしが許容できない用途なら、中継 Worker 側でキュー（Cloudflare Queues 等）を挟む設計が要る。

### 3.5 LINE の Webhook 応答を遅くしうる

`fireEvent` は LINE Webhook のリクエスト処理中に `await` されている。中継 Worker の応答が遅いと LINE への 200 応答も遅れる。

**中継 Worker は署名検証だけしてすぐ 200 を返し、通知先への転送は `ctx.waitUntil()` に逃がすこと。**

### 3.6 ペイロードに顧客名・アカウント情報が入っていない

`data` に含まれるのは `friendId`（UUID）だけで、表示名も LINE アカウントIDも無い。「誰から来たか」を通知に載せたいなら、中継 Worker から `GET /api/friends/:id` を呼び戻す必要がある（API キーが要る）。

呼び戻しを避けるなら、通知は「新着あり + 管理画面へのリンク」に留めて、詳細は管理画面で見る割り切りもある。**まずはこの割り切りを推奨**（実装が単純で、APIキーを中継 Worker に置かずに済む）。

### 3.7 マルチアカウント時に区別できない

`getActiveOutgoingWebhooksByEvent` (`packages/db/src/webhooks.ts`) は `WHERE is_active = 1` で全件取得し、イベントタイプで絞るだけ。**LINE アカウントによる絞り込みが無い。**

複数の LINE 公式アカウントを運用している場合、すべてのアカウントのメッセージが同じ Webhook に飛ぶ。かつ 3.6 のとおりペイロードにアカウント情報が無いので、通知だけでは区別できない。

### 3.8 `matched` フラグで通知量を減らせる

`eventData.matched` は、そのメッセージが自動応答ルールにマッチしたかどうかを示す。

`matched: true` は bot が自動で返信済み＝人間の対応が不要なケースが多い。**`matched: false` のときだけ通知する**と、通知が実際に人手が要るものだけに絞れる。

※ 2026-08-21 の upstream 取り込みで「マイル」完全一致の自動応答が有効化されている（後述の未決事項）。これがマッチしたメッセージは `matched: true` になる。

### 3.9 `replyToken` が通知先に流れる

ペイロードに `replyToken` が含まれる。これは LINE の返信用トークン（短命）。中継 Worker で Slack 等に転送する内容には**含めないこと**。

---

## 4. 実装手順

### Step 1. 通知先を決める（未決 — §6 参照）

Slack / Discord / メールのどれか。以降の変換ロジックが変わる。

### Step 2. 中継 Worker を作る

新規の Cloudflare Worker。このリポジトリとは**別プロジェクト**にする（本体に混ぜない）。

処理の骨子:

1. `POST` のみ受け付ける
2. `X-Webhook-Signature` を HMAC-SHA256 で検証（一致しなければ 401）
   - タイミング攻撃を避けるため定数時間比較を使うこと
3. `event !== 'message_received'` なら 200 を返して終了
4. （任意）`eventData.matched === true` なら通知しない
5. 通知先の形式に変換
   - Slack: `{"text": "..."}`
   - Discord: `{"content": "..."}`
6. `ctx.waitUntil(fetch(通知先URL, ...))` で転送し、**即座に 200 を返す**（§3.5）

シークレットは `wrangler secret put` で設定し、コードにも wrangler.toml にも書かない。

必要なシークレット:
- `LINE_HARNESS_WEBHOOK_SECRET` — 署名検証用（Step 3 で登録するものと同一）
- `NOTIFY_WEBHOOK_URL` — Slack/Discord の Incoming Webhook URL

### Step 3. 送信 Webhook を登録する

管理画面 `/webhooks` →「outgoing」タブ →「作成」

| 項目 | 値 |
|---|---|
| 名前 | `受信メッセージ通知` など |
| URL | Step 2 の Worker の https URL |
| イベントタイプ | `message_received` （**アンダースコア**。§3.3） |
| シークレット | 32文字以上のランダム文字列 |

### Step 4. 動作確認

1. テスト用の LINE アカウントから公式アカウントにテキストを送る
2. 通知先にメッセージが届くことを確認
3. 中継 Worker のログ（`wrangler tail`）でエラーが出ていないこと
4. 署名検証が効いていること（署名なしで `curl` して 401 が返る）を確認

---

## 5. 別案（採用しなかったもの）

| 案 | 却下理由 |
|---|---|
| 本体に email チャネルを実装 | `notification_rules` の `email` チャネルは upstream でも「将来実装」のまま。実装するとフォーク差分が増え、次回の upstream 取り込みで衝突する |
| ダッシュボード通知 (`channel: 'dashboard'`) を使う | 実装済みだが管理画面を開かないと気づけない。今回の要件を満たさない |
| Slack/Discord に直結 | ペイロード形式が合わない（§1） |
| LINE 公式アカウントアプリを使う | 別途 LINE 公式アカウントアプリで受信通知は受け取れるが、担当者間の共有や CRM 側の情報と紐付かない。要件次第では最も手軽な選択肢なので、一度検討する価値はある |

---

## 6. 未決事項（着手前に決めること）

1. **通知先** — Slack / Discord / メールのどれか
2. **1:1 かグループか** — グループ中心なら §3.2 のとおりこの方式では届かない。設計からやり直しになる
3. **通知内容** — 「新着あり + 管理画面リンク」だけにするか、顧客名とメッセージ本文まで載せるか（§3.6）
4. **取りこぼし許容度** — 許容できないならキューを挟む（§3.4）
5. **`matched: true` を通知するか**（§3.8）

---

## 7. 関連する未処理の課題

**「マイル」自動応答が本番で有効になっている。**

2026-08-21 の upstream 取り込み（マイグレーション `067_mileage_keyword_auto_reply.sql`）が、`is_active = 1` で自動応答ルールを投入した。顧客が「マイル」と完全一致で送信すると、ポイント残高の Flex メッセージが自動返信される。

本番で現在**有効な自動応答はこれ1件のみ**。ポイント制度を運用しないなら管理画面 `/auto-replies` から無効化すること。通知の観点では、このルールにマッチしたメッセージは `matched: true` になる（§3.8）。

---

## 参照

- イベントバス: `apps/worker/src/services/event-bus.ts`
- LINE Webhook 受信: `apps/worker/src/routes/webhook.ts`
- グループ/ルーム処理: `apps/worker/src/services/target-webhook.ts`
- 送信 Webhook API: `apps/worker/src/routes/webhooks.ts`
- 送信 Webhook クエリ: `packages/db/src/webhooks.ts`
- 管理画面: `apps/web/src/app/webhooks/page.tsx`
- 通知ルールの仕様: `docs/wiki/15-Webhooks-and-Notifications.md`
- グループターゲット機能: `docs/GROUP_TARGETS.md`
