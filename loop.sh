#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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
  HOME=~/.claude-accounts/personal nix run nixpkgs#bun -- x '@anthropic-ai/claude-code' --dangerously-skip-permissions --print --verbose --output-format stream-json <PROMPT_build.md |
    jq -r '
      if .type == "assistant" then
        .message.content[]? |
        if .type == "text" then .text
        elif .type == "tool_use" then
          "[\(.name)] " + (.input | to_entries | map("\(.key)=\(.value | tostring | .[0:120])") | join(" "))
        else empty
        end
      elif .type == "result" then
        "\n--- done: \(.duration_ms / 1000)s | cost: $\(.total_cost_usd | tostring | .[0:6]) | turns: \(.num_turns) ---"
      else empty
      end
    ' || echo "!!! Claude exited with error (likely context overflow). Continuing loop..."
  git add -A && git push origin "$(git branch --show-current)" 2>/dev/null || true
  echo ""
done

echo "Loop finished after $ITERATION iterations."
