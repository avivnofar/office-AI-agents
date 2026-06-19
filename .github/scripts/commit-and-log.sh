#!/usr/bin/env bash
# Shared commit + session-log step for scheduled-claude.yml jobs.
# Honest about outcome: only logs "completed" when claude_result.json was
# actually produced by run-claude-session.js; otherwise logs the failure
# reason so TOKEN-BUDGET.md never claims success for a no-op run.
set -uo pipefail

git config user.name 'claude-automation[bot]'
git config user.email 'claude-automation@data-center'
git add -A

STATUS="failed: no output"
if [ -f claude_result.json ]; then
  MSG=$(node -e "console.log(require('./claude_result.json').commit_message)")
  SUMMARY=$(node -e "console.log(require('./claude_result.json').summary)")
  STATUS="completed"
elif [ -f claude_error.txt ]; then
  if grep -q "authentication_error" claude_error.txt; then
    STATUS="failed: auth_error"
  else
    STATUS="failed: api_error"
  fi
  MSG="chore: automated session $SESSION_TYPE $(date -u +%Y-%m-%d-%H%M) (no changes — $STATUS)"
  SUMMARY="Session failed: $STATUS"
elif [ -f claude_summary.txt ]; then
  MSG="chore: automated session $SESSION_TYPE $(date -u +%Y-%m-%d-%H%M) (summary only, no file changes)"
  SUMMARY="No file changes — summary only"
  STATUS="completed (no changes)"
else
  MSG="chore: automated session $SESSION_TYPE $(date -u +%Y-%m-%d-%H%M) (no output)"
  SUMMARY="No output produced"
fi

git diff --cached --quiet || git commit -m "$MSG"
git pull origin master --rebase
git push origin master
echo "Status: $STATUS"
echo "Commit: $MSG"
echo "Summary: $SUMMARY"

DATE=$(date -u +"%Y-%m-%d %H:%M UTC")
echo "" >> TOKEN-BUDGET.md
echo "- [$DATE] Auto-session: $SESSION_TYPE — $STATUS" >> TOKEN-BUDGET.md
git add TOKEN-BUDGET.md
git commit -m "chore: log auto-session [skip ci]" || true
git pull origin master --rebase
git push origin master || true
