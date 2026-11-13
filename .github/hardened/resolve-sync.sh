#!/usr/bin/env bash
# Merge upstream into this checkout and let Claude Code resolve the conflicts.
# Run by hardened-sync-resolve.yml in a job that holds no write credential. land-sync.sh
# checks the result and pushes it in a separate job.
#
# Usage: resolve-sync.sh <output-dir>
#   writes sync.bundle and summary.md to output-dir
#   sets resolved=true in GITHUB_OUTPUT when there is a merge to land
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
OUT="$1"
UPSTREAM="https://github.com/pingdotgg/t3code.git"
MODEL="claude-opus-5-5"
MAX_BUDGET_USD="25"
READ_ONLY_GIT="Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git status*)"
VP="Bash(vp i*),Bash(vp fmt *),Bash(vp run typecheck*),Bash(vp test run *),Bash(cd *)"

mkdir -p "$OUT"
git config user.name "hyrmedia-t3code-sync[bot]"
git config user.email "hyrmedia-t3code-sync[bot]@users.noreply.github.com"
git fetch --quiet --no-tags "$UPSTREAM" main:refs/remotes/upstream/main
base="$(git rev-parse HEAD)"

if git merge-base --is-ancestor upstream/main HEAD; then
  echo "This branch is not behind upstream."
  exit 0
fi

# The tests the fork added or changed since the last upstream commit it merged. Upstream can break
# them in files that merge without a conflict, so the agent runs all of them, not only the tests
# beside the files it edits. Browser tests need Chromium, which this job does not install.
fork_tests="$(git diff --name-only --diff-filter=AM "$(git merge-base HEAD upstream/main)" HEAD -- \
  '*.test.ts' '*.test.tsx' ':!*.browser.test.tsx')"

summary="Upstream merged without a conflict."
if ! git merge --no-ff --no-commit upstream/main >/dev/null; then
  conflicts="$(git diff --name-only --diff-filter=U)"
  [[ -n "$conflicts" ]] || { echo "::error::The merge failed with no conflicted files."; exit 1; }
  printf 'Conflicted files:\n%s\n' "$conflicts"
  # A conflicted lockfile cannot install. The agent resolves it and runs vp i.
  vp i || true
  {
    cat "$TOOLS/resolve-sync-prompt.md"
    printf '\n## Conflicted files\n\n%s\n' "$conflicts"
    printf '\n## Fork tests\n\n%s\n' "${fork_tests:-None.}"
  } | CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 claude -p --bare --restricted --strict-mcp-config \
    --no-session-persistence --model "$MODEL" --effort high --max-budget-usd "$MAX_BUDGET_USD" \
    --tools "Read,Edit,Write,Glob,Grep,Bash" \
    --allowedTools "Read,Edit,Write,Glob,Grep,$READ_ONLY_GIT,$VP" | tee "$OUT/agent.md"
  summary="$(cat "$OUT/agent.md")"
  rm "$OUT/agent.md"
fi

# git add -u leaves out stray files, and it stages deletions that a resolution made.
git add -u
git commit --quiet --no-verify -m "chore: merge upstream pingdotgg/t3code main

Claude Opus 5.5 via Claude Code."
git bundle create "$OUT/sync.bundle" HEAD "^$base" "^upstream/main"
printf '%s\n' "$summary" >"$OUT/summary.md"
echo "resolved=true" >>"${GITHUB_OUTPUT:-/dev/null}"
