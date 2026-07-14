# PR Review Playbook

この文書は、機能追加や大きな変更を「テストが通ったか」だけで終わらせず、
本番でデータ欠落・誤送信・アカウント混線・upstream 競合を起こさないための
レビュー手順である。

PR #3 の LINE group/room 対応で見つかった問題を一般化している。特定機能に
依存しないため、Webhook、API、SDK、MCP、D1 migration、fork sync のレビューに
そのまま使える。

## 1. 最初に「できること / できないこと」を固定する

コードを読む前に、変更後の能力を表にする。曖昧な項目は仕様不足として扱う。

| 項目 | 確認すること | PR #3 の例 |
|---|---|---|
| 対象 | 何を識別し、操作できるか | friend とは別に group / room を target として扱う |
| 入力 | どのイベント・API・画面から入るか | join / leave / message Webhook、API、SDK、MCP |
| 出力 | 何が外部へ送られるか | LINE group への text / image / flex push |
| 保存 | 何をどの時刻・IDで残すか | target、発言者、実発言時刻、実際に送ったpayload |
| 制限 | 意図的に未対応なこと | 全メンバー取得、自動返信、scenario は group では未対応 |
| 失敗時 | 何を拒否し、何を再試行できるか | leave済みtargetへの送信は409、Webhook再送は冪等 |

レビューコメントでは「実装されていない」だけでなく、それが仕様上の非対応か、
実装漏れかを区別する。

## 2. 状態変更の正しさ

### 2.1 並行実行は原子的か

**問い:** read -> 判断 -> write が分かれておらず、DB制約を含む1操作で確定するか。

- 悪い例: `SELECT` で不存在確認後に `INSERT`。同時Webhookで両方が不存在を読み、
  一方が UNIQUE 違反になってイベントを落とす。
- 良い例: `INSERT ... ON CONFLICT DO UPDATE` で登録と更新を原子的に行う。
- 必要なテスト: 同じ未登録IDへ `Promise.all` で同時書き込みし、行数と最終状態を確認。

### 2.2 再送・リトライは冪等か

**問い:** 外部サービスが同じイベントを再送したとき、二重登録・二重課金・
二重配信にならないか。

- PR #3 の例: LINEの `message.id` を `(target_id, line_message_id)` のUNIQUEキーにし、
  redeliveryを1件として保存する。
- `eventId`、決済ID、予約IDなど、外部が保証する安定IDを優先する。
- `created_at` や本文の一致をdedupeキーにしない。

### 2.3 到着順と発生順を混同していないか

**問い:** 遅延イベントや古い再送が、現在の状態を巻き戻さないか。

- PR #3 の例: `leave(t=200)` 後に `join(t=100)` が届いてもactiveへ戻さない。
- 未登録targetへのleaveも捨てず、inactive tombstoneとして保存する。
- メッセージは受信時刻ではなくLINEの `event.timestamp` を `created_at` に使う。
- `last_message_at` は単調増加にし、古いイベントで小さくしない。
- 必要なテスト: 新しいイベントを先、古いイベントを後に投入して状態を確認。

### 2.4 並び順とページングカーソルは同じキーか

**問い:** `ORDER BY` の全キーがカーソル条件にも含まれているか。

- 悪い例: `ORDER BY created_at DESC, id DESC` なのに `before=created_at` だけを使う。
  同一時刻の2件がページ境界をまたぐと、次ページから1件が消える。
- 良い例: `(createdAt, id)` の複合カーソルを使い、
  `created_at < time OR (created_at = time AND id < idCursor)` とする。
- 必要なテスト: 同一timestampの3件を作り、`limit=2` で欠落・重複なく全件取得。

### 2.5 ログはリクエストではなく実結果を表すか

**問い:** 変換・fallback・短縮後に、実際に外部へ送った内容を保存しているか。

- PR #3 の例: 壊れたimage/flexがtextへfallbackした場合、元の `messageType` ではなく
  実際にpushしたtextを記録する。
- 本番確認で見つかった例: friend送信は正しいアカウントで配送できても、
  `messages_log.line_account_id` をINSERTしなければ監査ログは不完全になる。

## 3. テナント・アカウント・権限の分離

### 3.1 スコープが入口から保存先まで伝播するか

**問い:** account/tenant IDが、一覧、詳細、送信、派生データ、redirect、ログの
全経路で同じ値になっているか。

- SDKのdefault accountがtarget一覧にも適用されるか。
- friend/targetが所属するアカウントのaccess tokenで送信するか。
- 自動生成したtracked linkにも同じ `line_account_id` を保存するか。
- `/t/` redirectがglobal fallbackではなく、リンク所有アカウントのLIFFを使うか。
- メッセージ監査ログにもaccount IDが残るか。

mockで「引数を渡した」だけでは不十分。実DBへ保存し、redirectの最終URLまで確認する。

### 3.2 IDの意味がAPI間で一貫しているか

**問い:** 内部UUID、外部ID、表示名を混同していないか。

- PR #3 の例: canonical IDはtarget row ID、API入力はraw LINE groupId/roomIdも許容。
- capabilityに `primaryKey`、`acceptedIds`、対象typeを宣言する。
- 名前検索で送信する場合は完全一致かつ候補1件を確認し、曖昧なら送信しない。

### 3.3 重要な関連付けを無言で上書きできないか

**問い:** customer/deal/accountなどの主関連を、LLMや一般ユーザーが誤って変更できないか。

- PR #3 の例: 既存の `salesCustomerPageId` / `salesDealPageId` を別値へ変える場合は
  `force=true` と明示確認を要求する。
- 同値の再設定と初回設定は許可し、意図的な変更だけを強くする。

## 4. API・SDK・MCP・Docsの契約

### 4.1 宛先や動作が曖昧な入力を拒否するか

**問い:** 複数の指定方法が同時に来たとき、暗黙の優先順位で誤操作しないか。

- PR #3 の例: `friendId XOR (targetType + targetId)` を要求する。
- friendとtargetの両方、targetTypeだけ、targetIdだけ、宛先なしは送信前にエラー。
- 数値queryは整数・範囲を検証する。SQLiteの負数LIMITなどDB固有挙動へ流さない。

### 4.2 危険な名称・説明が実動作と一致するか

**問い:** `test`、`preview`、`dryRun` などが、実配送しないと誤解されないか。

- PR #3 の例: `isTest` はdry runではなく、ラベル付きで全メンバーへ実配送され、
  通知・課金も通常どおり発生するとMCP descriptionへ明記する。
- binary設定はdefault値と、false時にどこまで無効になるかを明記する。

### 4.3 変更した契約が全レイヤーに届いているか

以下を縦に追跡する。

1. DB schema / helper
2. Worker route / validation
3. OpenAPI / capability
4. SDK type / query / body
5. MCP schema / description / forwarding
6. 利用ドキュメント
7. 各レイヤーのテスト

PR #3 の `beforeId` は、DBだけ直しても不十分だった。Worker、SDK、MCP、OpenAPI、
docsまで公開して初めて利用者が複合カーソルを使える。

## 5. forkとupstream追従性

### 5.1 upstream所有の名前空間を使っていないか

- upstreamの連番migrationへfork固有migrationを置かない。
- PR #3 の例: upstreamの047-049と衝突しないよう `901_primaryinc_*` を使う。
- route名、設定名、package version、release tagにも同じ所有境界を適用する。

### 5.2 共有ファイルへの変更面積を小さくできるか

- 巨大なWebhookへ機能本体と大量のテストを追加せず、専用service/testへ分離する。
- 共有routeにはsource判定と1回の委譲だけを残す。
- upstreamと同じ契約を使える箇所は独自引数・独自処理を作らない。
- generated bootstrapやlockfileは手編集せず、既存generator/package managerで再生成する。

### 5.3 現在のupstreamと実際に統合できるか

- `git fetch upstream` 後、merge-baseと差分を確認する。
- 仮想mergeまたは実mergeで競合ファイルを列挙する。
- 競合解消後は「ビルドできる」だけでなく、upstream機能とfork機能の両方が残るか確認。
- PR差分がupstream同期を含む場合、feature差分を `upstream/main...HEAD` でも読む。

## 6. テストの強さ

### 6.1 mockテストと実体テストを使い分ける

| テスト | 向いている確認 |
|---|---|
| Unit / mock | validation、分岐、外部APIへ渡す引数 |
| 実SQLite/D1互換 | UNIQUE、UPSERT、cursor、migration、保存値 |
| Route integration | auth、serialization、HTTP status、query/body転送 |
| Production smoke | migration適用、Webhook疎通、実DB、実配送 |

「mockが期待引数を受けた」だけで、DB列が存在する、値が永続化される、redirectが
正しいことまでは証明できない。

### 6.2 正常系だけでなく境界を作る

- 同時初回登録
- 同一イベント再送
- leave後の古いjoin/message
- 未登録targetへのleave
- 同一timestampのページ境界
- account A/Bで生成・保存・redirectが混線しないこと
- 無効なlimit/offset
- friendとtargetを同時指定した誤送信入力
- fallback後の実payload

### 6.3 workspace依存順を含めて検証する

- package単体のtest/typecheckだけで終わらせない。
- SDKのsourceを変更した場合、SDKをbuildしてからSDKを参照するMCPをtypecheck/buildする。
- 最終的に `pnpm -r build` でworkspaceの依存順を含むproduction buildを確認する。

## 7. リリース後の確認

CI greenは本番動作の証明ではない。以下を読み取り中心で確認する。

1. merge commitとdeploy対象SHAが一致する。
2. migrationが対象D1へAppliedになっている。
3. live capability/OpenAPIが新機能を返す。
4. 外部Webhook endpointが有効で、リリース先URLと一致する。
5. incomingイベントがtarget/message/actor/account付きで保存される。
6. APIから一覧・詳細・会話・参加者を取得できる。
7. 明示承認後にoutgoingを1件だけ送り、外部API成功と監査ログを確認する。
8. 本文や完全な外部IDを不要に表示せず、件数・方向・時刻・紐付けを先に確認する。

PR #3 の本番smokeでは、最初の確認時点でtargetが0件だったため「未到達」と判断し、
ユーザーが送った `1722` でincoming、API返信でoutgoingを個別に確認できた。

## 8. レビューの進め方

1. **能力表を作る:** できること、非対応、失敗時の挙動を整理する。
2. **状態遷移を描く:** 未登録、active、inactive、再参加、再送を並べる。
3. **縦に追う:** Webhook/APIからDB、SDK、MCP、docsまで同じ値を追跡する。
4. **横に比較する:** friendなど既存の類似機能と契約・監査項目を比較する。
5. **upstreamと比較する:** 名前空間、共有ファイル、最新契約、競合を確認する。
6. **境界テストを実行する:** happy pathでは出ない競合・順序・ページ境界を作る。
7. **指摘を直した差分も再レビューする:** 修正が新しい契約漏れを作っていないか見る。
8. **リリース後に実データで閉じる:** incomingとoutgoingを別々に確認する。

## 9. レビューコメントの型

```text
[P1] <何を直すべきか>

<現在のコードで何が起きるか>。
例えば <最小の再現条件> では <利用者・データへの影響> が発生します。
<推奨する実装方針> とし、<追加すべきテスト> を入れてください。
```

優先度の目安:

- **P0:** 情報漏えい、広範囲な誤配信、データ破壊など、即時停止が必要。
- **P1:** マージ前に直すべきデータ欠落、誤送信、tenant混線、状態破壊。
- **P2:** 条件付きの不整合、運用事故、保守性低下。原則このPRで対応。
- **P3:** 非blockingな改善。根拠と費用対効果を明示する。

## 10. マージ判定チェックリスト

- [ ] できること / できないことが説明されている
- [ ] 並行書き込みが原子的である
- [ ] 再送が冪等である
- [ ] 古いイベントが現在状態を巻き戻さない
- [ ] ORDER BYとcursorが同じ一意キーを使う
- [ ] 実際の外部出力をログしている
- [ ] account/tenant IDが一覧・送信・派生データ・ログまで伝播する
- [ ] 曖昧な宛先や危険な上書きを送信前に拒否する
- [ ] API / SDK / MCP / OpenAPI / docsの契約が一致する
- [ ] fork固有の名前空間と小さい競合面積を保っている
- [ ] mockだけでなく実DBの境界テストがある
- [ ] workspace依存順を含むbuildが通る
- [ ] deploy SHA、migration、live API、incoming、outgoingを確認できる
- [ ] 残る非対応・テストgap・rollback方法が明記されている
