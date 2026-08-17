# 外部automation向け安全配送capability

## 目的

外部automationからLINE Harnessを使う目的は、業務workflowをLINE Harnessへ移植することではない。上流で確定した1つの配送意図を、所有権を検証した公式LINE宛先へ高々1回渡し、再試行可能性をreceiptで証明することである。

## 責務境界

LINE Harnessが所有するもの:

- API keyが操作できるLINE accountとfriendの所有権検証
- `clientRequestId`の全account横断一意性
- account、friend、message type、contentから得たrequest hash
- provider dispatchの状態とprovider referenceを含むdelivery receipt
- 同じkey・同じrequestのreplay、異なるrequestの409拒否
- dispatch結果が不明な場合のfail-closedな`uncertain`状態

呼出し元が所有するもの:

- なぜ送るか、誰が承認したか、どのrevisionを送るか
- 顧客、案件、物件、文面生成、添付生成などのdomain state
- Slack、AI session、schedule、retry policy、下流記録

LINE Harnessは上流の業務概念を解釈せず、approvalやproposalを保存しない。呼出し元もLINE providerの成功を推測せず、receiptだけを配送結果として扱う。

## capability契約

外部automationは `POST /api/friends/:id/messages` に次を同時指定する。

```json
{
  "lineAccountId": "account-owned-by-api-key",
  "clientRequestId": "stable-intent-key",
  "messageType": "text",
  "content": "承認済みの固定内容"
}
```

- `lineAccountId`: friendの現在accountと一致しなければ409
- `clientRequestId`: providerへ渡したい論理配送1件から決定的に生成し、再試行で変えない
- `content`: 上流で承認されたimmutableな内容。画像も同じ原則で別の決定的keyを使う

成功時はdelivery receiptを保存して返す。同じkey・同じrequestならproviderを再呼出しせず元receiptを返す。同じkeyでaccount、friend、type、contentのいずれかが違えば409にする。

## 呼出し側のシーケンス

1. 上流で宛先、内容、承認revisionを確定する。
2. 論理配送IDからtext/imageごとの`clientRequestId`を決定する。
3. account assertion付きでLINE Harnessを呼ぶ。
4. receiptのrequest hashとprovider referenceを上流の配送台帳へ保存する。
5. network failure時は同じkey・同じrequestだけを再試行する。
6. `in_progress`または`uncertain`は別keyで迂回せず、人がproviderログを照合して明示解決する。

この契約により、物件提案、予約通知、督促など異なる業務目的が、LINE Harnessへdomain依存を追加せず同じ安全配送capabilityを利用できる。

詳細APIは [API Reference](./20-API-Reference.md)、運用上のstale/uncertain解決は [Friends](./Friends.md) を参照する。
