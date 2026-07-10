# 手動アップデートガイド

LINE Harness を手動で最新版に更新する手順です。

自動アップデート（管理画面のバナー / `create-line-harness update`）は、**公式リリースと構成が一致するインストール**（vanilla ビルド）でのみ利用できます。以下のような場合は自動更新の対象外になり、このガイドの手動手順で更新します:

- コードをカスタマイズしている（フォーク運用）
- 自前の CI/CD（GitHub Actions 等）でデプロイしている

> カスタマイズ版であること自体は問題ではありません。自動更新が「勝手にあなたの変更を上書きしない」ための安全装置として無効になるだけです。

## 方法 1: create-line-harness でインストールした場合

```bash
npx create-line-harness@latest update
```

vanilla ビルドであれば自動更新されます。

### バージョンが `v0.0.0-dev` と表示される場合（旧 CLI インストール）

旧バージョンの CLI でセットアップした環境は、公式リリースと同一でもバージョン情報が埋め込まれておらず `v0.0.0-dev` と表示されます。この場合も上記コマンドを実行してください — **公式リリースへの引き上げ（導入）を提案するプロンプト**が表示されます。

- 承認すると、最新の公式リリースを導入し、以後は通常の自動アップデートが使えるようになります
- DB のデータ・管理画面上の設定・シークレットはそのまま残ります
- **Worker / 管理画面のソースコードをカスタマイズしている場合は上書きされる**ため、承認せず方法 3 で更新してください
- マイグレーションは全件を再確認します。適用済みのものは「スキップ」と表示されます（正常です）

## 方法 2: git クローンして運用している場合

```bash
# 1. 最新を取得
git pull origin main

# 2. 依存を更新
pnpm install

# 3. DB マイグレーションを適用
#    packages/db/migrations/ の SQL を番号順に 1 ファイルずつ適用します。
#    適用済みのファイルは "already exists" / "duplicate column" エラーに
#    なりますが、これは「適用済み」の意味なので無視して次に進んで構いません。
cd apps/worker
for f in ../../packages/db/migrations/*.sql; do
  npx wrangler d1 execute <your-database> --remote --file "$f" || true
done

# 4. デプロイ
npx wrangler deploy                      # Worker
pnpm --filter web build                  # 管理画面（Pages にデプロイ）
```

> **注意:** 以前このガイドに記載していた `wrangler d1 migrations apply` は、
> `create-line-harness` でセットアップした環境では機能しません（wrangler の
> マイグレーション管理テーブルを使わずにセットアップされるため、全マイグレー
> ションが「未適用」扱いになります）。上記の `d1 execute --file` 方式を使って
> ください。LINE Harness のマイグレーションは追加専用（additive-only）+
> `INSERT OR IGNORE` 方針のため、適用済みファイルの再実行は安全です。

自前の CI/CD がある場合は main を pull / merge して push すれば通常のデプロイフローで反映されます。

## 方法 3: フォークして独自変更がある場合

1. upstream を remote に追加して取り込みます:

```bash
git remote add upstream https://github.com/Shudesu/line-harness-oss.git
git fetch upstream
git merge upstream/main   # コンフリクトがあれば解消
```

2. その後は方法 2 の手順 2〜4 と同じです。

## リリース情報

- 最新リリースと変更内容: [GitHub Releases](https://github.com/Shudesu/line-harness-oss/releases)
- リリースノート: [Release-Notes](Release-Notes.md)
