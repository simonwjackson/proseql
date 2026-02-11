#!/usr/bin/env nix-shell
#!nix-shell -i bash -p gettext jq
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Usage:
#   ./loop.sh                  # loop over ALL changes with remaining tasks
#   ./loop.sh indexing          # loop over a single change
#   ./loop.sh indexing 10       # single change, max 10 iterations
#   ./loop.sh --all 50         # all changes, max 50 total iterations

MAX_ITERATIONS=0
SINGLE_CHANGE=""

case "${1:-}" in
  --help|-h)
    echo "Usage:"
    echo "  ./loop.sh                  # all changes, unlimited"
    echo "  ./loop.sh --all 50         # all changes, max 50 iterations"
    echo "  ./loop.sh <change> [max]   # single change"
    exit 0
    ;;
  --all)
    MAX_ITERATIONS="${2:-0}"
    ;;
  "")
    # No args = all changes, unlimited
    ;;
  *)
    SINGLE_CHANGE="$1"
    MAX_ITERATIONS="${2:-0}"
    ;;
esac

ITERATION=0

# Count tasks in a tasks.md file
count_remaining() {
  local n
  n=$(grep -c '^\- \[ \]' "openspec/changes/$1/tasks.md" 2>/dev/null) || true
  echo "${n:-0}"
}

count_complete() {
  local n
  n=$(grep -c '^\- \[x\]' "openspec/changes/$1/tasks.md" 2>/dev/null) || true
  echo "${n:-0}"
}

# Find the next change with remaining tasks
# Returns the change name, or empty string if all done
next_change() {
  if [ -n "$SINGLE_CHANGE" ]; then
    local remaining
    remaining=$(count_remaining "$SINGLE_CHANGE")
    if [ "$remaining" -gt 0 ]; then
      echo "$SINGLE_CHANGE"
    fi
    return
  fi

  # Get all changes, ordered by matching spec number (001-xxx first, then unnumbered)
  local ordered_changes=()
  for spec_dir in openspec/specs/[0-9]*/; do
    [ -d "$spec_dir" ] || continue
    # Extract change name by stripping numeric prefix: 001-foo → foo
    local spec_name change_name
    spec_name=$(basename "$spec_dir")
    change_name="${spec_name#[0-9][0-9][0-9]-}"
    [ -d "openspec/changes/$change_name" ] && ordered_changes+=("$change_name")
  done
  # Append any changes that don't have a numbered spec
  for dir in openspec/changes/*/; do
    [ -d "$dir" ] || continue
    local name
    name=$(basename "$dir")
    [ "$name" = "archive" ] && continue
    local found=0
    for oc in "${ordered_changes[@]+"${ordered_changes[@]}"}"; do
      [ "$oc" = "$name" ] && found=1 && break
    done
    [ "$found" -eq 0 ] && ordered_changes+=("$name")
  done

  for name in "${ordered_changes[@]+"${ordered_changes[@]}"}"; do
    [ -f "openspec/changes/$name/tasks.md" ] || continue
    local remaining
    remaining=$(count_remaining "$name")
    if [ "$remaining" -gt 0 ]; then
      echo "$name"
      return
    fi
  done
}

echo "============================================"
echo "  OpenSpec Implementation Loop"
echo "============================================"
if [ -n "$SINGLE_CHANGE" ]; then
  echo "  Change: $SINGLE_CHANGE"
else
  echo "  Mode: all changes with remaining tasks"
fi
echo "  Max iterations: $([ "$MAX_ITERATIONS" -gt 0 ] && echo "$MAX_ITERATIONS" || echo "unlimited")"
echo "============================================"
echo ""

CURRENT_CHANGE=""

while true; do
  # Check iteration cap
  if [ "$MAX_ITERATIONS" -gt 0 ] && [ "$ITERATION" -ge "$MAX_ITERATIONS" ]; then
    echo ""
    echo "Reached max iterations ($MAX_ITERATIONS). Stopping."
    break
  fi

  # Find next change with work
  CHANGE=$(next_change)
  if [ -z "$CHANGE" ]; then
    echo ""
    echo "All tasks across all changes complete!"
    break
  fi

  # Announce change transitions
  if [ "$CHANGE" != "$CURRENT_CHANGE" ]; then
    if [ -n "$CURRENT_CHANGE" ]; then
      echo ""
      echo ">>> Change '$CURRENT_CHANGE' complete! Moving to '$CHANGE'"
      echo ""
    fi
    CURRENT_CHANGE="$CHANGE"

    # Verify tasks file exists
    if [ ! -f "openspec/changes/${CHANGE}/tasks.md" ]; then
      echo "Error: openspec/changes/${CHANGE}/tasks.md not found. Skipping."
      SINGLE_CHANGE=""
      continue
    fi
  fi

  ITERATION=$((ITERATION + 1))

  # Get progress
  REMAINING=$(count_remaining "$CHANGE")
  COMPLETE=$(count_complete "$CHANGE")
  TOTAL=$((REMAINING + COMPLETE))

  echo "=== Iteration $ITERATION | change: $CHANGE | $COMPLETE/$TOTAL done ($REMAINING remaining) ==="

  # Build prompt with change name
  PROMPT=$(CHANGE="$CHANGE" envsubst '$CHANGE' < PROMPT_build.md)

  # Run Claude
  claude --dangerously-skip-permissions --print --verbose --output-format stream-json <<< "$PROMPT" |
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
  echo ""
done

echo ""
echo "============================================"
echo "  Loop finished after $ITERATION iterations"
echo "============================================"
