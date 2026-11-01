#!/usr/bin/env bash
# Check a merge from resolve-sync.sh, run full CI on it, and fast-forward the target branch.
# A fast-forward keeps upstream's ancestry, which a squash or rebase merge loses. This job holds
# the write credential, so it treats the merge as data and never runs its code.
#
# Usage: land-sync.sh <input-dir> <branch>
#   PUSH_TOKEN  contents and workflows write. Its push starts CI on the sync branch.
#   GH_TOKEN    pull requests write and actions read. A pull request from GITHUB_TOKEN starts no
#               CI, so the pull request only shows the merge and keeps a failed one open.
set -euo pipefail

IN="$1"
BRANCH="$2"
UPSTREAM="https://github.com/pingdotgg/t3code.git"
PUSH_URL="https://x-access-token:${PUSH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
fail() { echo "::error::$1"; exit 1; }

git fetch --quiet --no-tags "$UPSTREAM" main:refs/remotes/upstream/main
git fetch --quiet "$IN/sync.bundle" HEAD:refs/sync/resolved
merge="$(git rev-parse refs/sync/resolved)"
ours="$(git rev-parse "$merge^1")"
theirs="$(git rev-parse "$merge^2")"

[[ "$(git rev-list --parents -n 1 "$merge" | wc -w)" -eq 3 ]] || fail "The result is not a merge commit."
[[ "$ours" == "$(git rev-parse HEAD)" ]] || fail "$BRANCH moved after the merge started."
git merge-base --is-ancestor "$theirs" upstream/main || fail "The second parent is not an upstream commit."

# The automatic merge shows what the agent changed, independent of what the agent reports.
auto="$(git merge-tree --write-tree --name-only "$ours" "$theirs" || true)"
tree="$(head -n 1 <<<"$auto")"
conflicts="$(sed -n '2,/^$/p' <<<"$auto" | sed '/^$/d')"
changed="$(git diff --name-only "$tree" "$merge")"

while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  if git cat-file -e "$merge:$file" 2>/dev/null && git show "$merge:$file" | grep -qE '^(<<<<<<<|>>>>>>>) '; then
    fail "$file still has conflict markers."
  fi
done <<<"$conflicts"

while IFS= read -r file; do
  [[ "$file" == .github/* && "$file" != .github/hardened/hardened.patch ]] || continue
  grep -qxF "$file" <<<"$conflicts" || fail "The agent changed $file, which was not conflicted."
done <<<"$changed"

git diff --quiet "$theirs" "$merge" -- \
  apps/server/src/persistence/Migrations.ts \
  apps/server/src/persistence/Migrations \
  apps/server/src/provider/agentContextBudget.json ||
  fail "Migrations and agentContextBudget.json must match upstream."

index="$(mktemp -u)"
GIT_INDEX_FILE="$index" git read-tree "$merge"
git show "$merge:.github/hardened/hardened.patch" | GIT_INDEX_FILE="$index" git apply --cached --check ||
  fail "hardened.patch does not apply to the merge."
rm -f "$index"

sync_branch="sync/upstream-${GITHUB_RUN_ID}"
git push --quiet "$PUSH_URL" "$merge:refs/heads/$sync_branch"
{
  echo "The daily sync resolved a merge conflict with upstream. It lands by itself when CI passes."
  echo
  echo "Run: ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  echo
  echo "## Agent summary"
  echo
  cat "$IN/summary.md"
  echo
  echo "## Files that differ from the automatic merge"
  echo
  sed "s/.*/- \`&\`/" <<<"$changed"
  echo
  echo "Claude Opus 5.5 via Claude Code."
} >"$IN/pr.md"
pr="$(gh pr create --base "$BRANCH" --head "$sync_branch" --title "chore: merge upstream pingdotgg/t3code main" --body-file "$IN/pr.md")"
echo "Opened $pr"

run=""
for _ in {1..40}; do
  run="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$merge&event=push" \
    --jq '.workflow_runs[] | select(.path == ".github/workflows/ci.yml") | .id' | head -n 1)"
  [[ -n "$run" ]] && break
  sleep 15
done
[[ -n "$run" ]] || fail "CI did not start for $pr."
gh run watch "$run" --exit-status --interval 30 >/dev/null || fail "CI failed. Finish the merge in $pr."

git push --quiet "$PUSH_URL" "$merge:refs/heads/$BRANCH"
echo "Landed $merge on $BRANCH."
