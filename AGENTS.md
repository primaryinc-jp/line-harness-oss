# Project Instructions

- ゴールから外れる提案をしないでください。
- ゴールに進む提案を必ずしてください。
- 回答には必ず「次のタスクはこれ」「今の進捗を全体像から整理するとこれ」を含めてください。
- 私が大学生だと思って、言語化してください。

## Git / Upstream Policy

- `upstream` は追従専用です。fetch・diff・merge/rebase 元としてのみ使ってください。
- `upstream` へ push しないでください。
- `upstream` に Pull Request を作成しないでください。
- 変更の push / PR 作成は、明示がない限り `origin` 側だけで行ってください。
- `v*.*.*` 形式のタグ / GitHub Release は upstream の名前空間です。`origin` 側では作成しないでください。
- `origin` 側のリリースは、`origin/main` へのマージと Cloudflare deploy workflow による社内環境反映を指します。
