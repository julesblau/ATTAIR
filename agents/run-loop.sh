#!/bin/bash
# Persistent runner for the ATTAIR agent army.
# Retries automatically after rate limits or crashes.
# Sends GH notifications on pause/resume.

cd "$(dirname "$0")"
GH='"C:\Program Files\GitHub CLI\gh.exe"'
REPO="julesblau/ATTAIR"

notify() {
  eval $GH issue create --repo $REPO --label agent-update --assignee julesblau \
    --title "\"$1\"" --body "\"$2\"" 2>/dev/null || true
}

MAX_RETRIES=50
RETRY=0

while [ $RETRY -lt $MAX_RETRIES ]; do
  echo ""
  echo "════════════════════════════════════════"
  echo "  Agent Army — attempt $((RETRY + 1))"
  echo "  $(date)"
  echo "════════════════════════════════════════"
  echo ""

  node run.js
  EXIT_CODE=$?

  # If run.js exited cleanly AND a standup was written, we're actually done
  if [ $EXIT_CODE -eq 0 ] && [ -f "../standups/$(date +%Y-%m-%d).md" ]; then
    echo "✅ Agent army completed successfully."
    exit 0
  fi

  RETRY=$((RETRY + 1))

  # Calculate sleep — check if we're rate limited (usage resets at known times)
  HOUR=$(TZ="America/New_York" date +%H)
  if [ $HOUR -ge 20 ]; then
    # After 8pm ET — sleep until 11pm ET (3 hours max)
    SLEEP_SECS=$(( (23 - HOUR) * 3600 + 120 ))
  elif [ $HOUR -lt 6 ]; then
    # Before 6am ET — sleep until 6am
    SLEEP_SECS=$(( (6 - HOUR) * 3600 + 120 ))
  else
    # During the day — short retry, might be a transient issue
    SLEEP_SECS=300
  fi

  # Minimum 2 minutes, maximum 4 hours
  [ $SLEEP_SECS -lt 120 ] && SLEEP_SECS=120
  [ $SLEEP_SECS -gt 14400 ] && SLEEP_SECS=14400

  RESUME_TIME=$(date -d "+${SLEEP_SECS} seconds" +%H:%M 2>/dev/null || date +%H:%M)
  echo ""
  echo "⏸️  Exited (code $EXIT_CODE). Sleeping ${SLEEP_SECS}s until ~${RESUME_TIME}..."
  echo "   Retry $RETRY/$MAX_RETRIES"

  notify "[Agent] ⏸️ Paused — resumes ~${RESUME_TIME}" \
    "Rate limited or interrupted. Auto-retrying in $((SLEEP_SECS / 60)) minutes (attempt $RETRY/$MAX_RETRIES)."

  sleep $SLEEP_SECS

  echo "🔄 Waking up — retrying..."
  notify "[Agent] 🔄 Resuming" "Waking up after pause. Attempt $((RETRY + 1))."
done

echo "❌ Exhausted $MAX_RETRIES retries. Giving up."
notify "[Agent] ❌ Gave up" "Exhausted $MAX_RETRIES retries over multiple hours. Manual restart needed."
