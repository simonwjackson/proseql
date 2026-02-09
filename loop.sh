#!/usr/bin/env bash
set -euo pipefail

MAX_ITERATIONS=${1:-0}
ITERATION=0

echo "Starting Ralph Wiggum loop for effect-foundation-migration"
echo "Max iterations: ${MAX_ITERATIONS:-unlimited}"
echo ""

while true; do
  if [ "$MAX_ITERATIONS" -gt 0 ] && [ "$ITERATION" -ge "$MAX_ITERATIONS" ]; then
    echo "Reached max iterations ($MAX_ITERATIONS). Stopping."
    break
  fi

  ITERATION=$((ITERATION + 1))
  REMAINING=$(grep -c '^\- \[ \]' openspec/changes/effect-foundation-migration/tasks.md 2>/dev/null || echo 0)

  if [ "$REMAINING" -eq 0 ]; then
    echo "All tasks complete! Stopping."
    break
  fi

  echo "=== Iteration $ITERATION | $REMAINING tasks remaining ==="
  cat PROMPT_build.md | claude -p --dangerously-skip-permissions
  git add -A && git push origin "$(git branch --show-current)" 2>/dev/null || true
  echo ""
done

echo "Loop finished after $ITERATION iterations."
