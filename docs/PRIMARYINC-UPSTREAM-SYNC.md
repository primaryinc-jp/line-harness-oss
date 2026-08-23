# PrimaryInc fork upstream sync

The `Update from upstream` workflow checks `Shudesu/line-harness-oss` every day
and can also be run manually.

## Clean merge

When upstream has new commits and Git can merge them cleanly, the workflow:

1. rebuilds the stable `upstream/automatic-update` branch from fork `main`;
2. merges the latest upstream `main`;
3. pushes the branch with `--force-with-lease`;
4. creates one update pull request, or updates the existing open pull request.

The workflow never merges or deploys the pull request automatically. The normal
review and push-to-`main` deployment gates still apply.

## Merge conflict

When Git reports a conflict, the workflow aborts the merge and records the fork and
upstream commit SHAs, the workflow run, and the exact conflicted paths in the run
summary and a 14-day `upstream-sync-conflict-*` artifact. It also emits an Actions
error annotation and fails the job, so repository workflow notifications and
Actions history show the problem. The repository has GitHub Issues disabled, so
the workflow does not depend on issue creation for durable reporting.

Resolve the issue from a new branch based on fork `main`:

```bash
git fetch origin main
git fetch upstream main
git switch -c agent/upstream-sync-YYYYMMDD origin/main
git merge --no-ff upstream/main
```

Review every conflicted shared file against
[`docs/PR-REVIEW-PLAYBOOK.md`](./PR-REVIEW-PLAYBOOK.md), run Worker CI-equivalent
checks and `pnpm -r build`, then open a pull request to fork `main`.

On later runs, an already-included upstream commit exits cleanly; a clean new merge
refreshes the single automatic update pull request.

## Fork conflict surface

Keep fork-only migrations in the `901_primaryinc_*` namespace and put substantial
fork behavior in dedicated services and tests. Shared upstream routes should keep
only the smallest dispatch or capability change needed to expose that behavior.
Do not edit `HARNESS_VERSION` independently: upstream synchronizes it with the
root package version.
