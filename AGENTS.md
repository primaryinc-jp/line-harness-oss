# Project Instructions

- ゴールから外れる提案をしないでください。
- ゴールに進む提案を必ずしてください。
- 回答には必ず「次のタスクはこれ」「今の進捗を全体像から整理するとこれ」を含めてください。
- 私が大学生だと思って、言語化してください。
- 大きな変更や PR をレビューするときは `docs/PR-REVIEW-PLAYBOOK.md` を使い、状態遷移・アカウント分離・契約伝播・upstream 追従・本番確認まで評価してください。
- L Harness Proxy から担当者として1対1返信する場合は、`X-Line-Harness-Source: manual` を必ず付けてください。予約通知などの自動送信には付けないでください。
- Google Meetの個別相談を確定・変更した場合は、カレンダー更新だけで終えず、`POST /api/meet-consultations` にGoogle Calendar event ID・LINE friend ID・日時・Meet URLを登録してください。前日・1時間前のLINEリマインドを必須セットにします。キャンセル時は `DELETE /api/meet-consultations/:externalEventId` も実行してください。

## Git / Upstream Policy

- `upstream` は追従専用です。fetch・diff・merge/rebase 元としてのみ使ってください。
- `upstream` へ push しないでください。
- `upstream` に Pull Request を作成しないでください。
- 変更の push / PR 作成は、明示がない限り `origin` 側だけで行ってください。
- `v*.*.*` 形式のタグ / GitHub Release は upstream の名前空間です。`origin` 側では作成しないでください。
- `origin` 側のリリースは、`origin/main` へのマージと Cloudflare deploy workflow による社内環境反映を指します。
