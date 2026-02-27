#!/usr/bin/env bash
set -euo pipefail

SESSION="codexstat"
PANE="${SESSION}:0.0"

OUT_JSON="${HOME}/codex_limits.json"
LOG_FILE="${HOME}/codex_status_run.log"
CAPTURE_FILE="${HOME}/codex_status_capture.txt"
TMP_STATUS="$(mktemp)"

log() {
  printf '[%(%Y-%m-%d %H:%M:%S)T] %s\n' -1 "$*" | tee -a "$LOG_FILE" >&2
}

cleanup() {
  set +e
  log "Cleanup: attempting to quit Codex + kill tmux session (if exists)"
  tmux has-session -t "$SESSION" 2>/dev/null || { log "Cleanup: session '$SESSION' not present"; return 0; }
  tmux send-keys -t "$PANE" "/quit" Enter 2>/dev/null || true
  sleep 0.3
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  log "Cleanup: done"
}
trap cleanup EXIT

snapshot_tail() {
  tmux capture-pane -t "$PANE" -p -J -S -2000 2>/dev/null | tail -n 40 || true
}

log "=== START ==="
log "Session: $SESSION  Pane: $PANE"
log "Output JSON: $OUT_JSON"
log "Log file: $LOG_FILE"
log "Capture file: $CAPTURE_FILE"
log "Temp status: $TMP_STATUS"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  log "Existing tmux session '$SESSION' found; killing it first"
  tmux kill-session -t "$SESSION" || true
fi

CODEX_CMD='codex --no-alt-screen -c check_for_update_on_startup=false'
log "Launching Codex via tmux: $CODEX_CMD"
tmux new-session -d -s "$SESSION" "$CODEX_CMD"

log "Waiting for Codex UI to render..."
READY=0
for i in $(seq 1 400); do
  if (( i % 25 == 0 )); then
    log "Still waiting... (attempt $i/400). Pane tail:"
    snapshot_tail | sed 's/^/  | /' | tee -a "$LOG_FILE" >&2
  fi
  out="$(tmux capture-pane -t "$PANE" -p -J -S -3000 2>/dev/null || true)"
  # Ready if we see the header or the prompt line
  if echo "$out" | grep -Eq "OpenAI Codex \(v|model:|/model to change|› Find and fix a bug|\\? for shortcuts"; then
    READY=1
    log "Ready detected via pane output."
    break
  fi
  sleep 0.05
done
[[ "$READY" -eq 1 ]] || { log "FATAL: Timed out waiting for UI"; exit 1; }

log 'Sending "/status" slowly...'
for c in / s t a t u s; do
  tmux send-keys -t "$PANE" -l "$c"
  sleep 0.10
done
tmux send-keys -t "$PANE" Enter

log "Waiting for /status markers..."
STATUS_OK=0
for i in $(seq 1 250); do
  if (( i % 25 == 0 )); then
    log "Still waiting for /status... (attempt $i/250). Pane tail:"
    snapshot_tail | sed 's/^/  | /' | tee -a "$LOG_FILE" >&2
  fi
  out="$(tmux capture-pane -t "$PANE" -p -J -S -12000 2>/dev/null || true)"
  echo "$out" | grep -Eq "5h limit:|Weekly limit:|/codex/settings/usage" && { STATUS_OK=1; break; }
  sleep 0.05
done
[[ "$STATUS_OK" -eq 1 ]] || { log "FATAL: Timed out waiting for /status output"; exit 1; }

log "Capturing pane to $CAPTURE_FILE ..."
tmux capture-pane -t "$PANE" -p -J -S -20000 > "$TMP_STATUS"
cp -f "$TMP_STATUS" "$CAPTURE_FILE" || true

log "Parsing limits and writing JSON (system timezone)..."
python3 - "$TMP_STATUS" "$OUT_JSON" "$LOG_FILE" <<'PY'
import json, re, sys
from datetime import datetime, time, timedelta

text_path, out_path, log_path = sys.argv[1], sys.argv[2], sys.argv[3]
tz = datetime.now().astimezone().tzinfo  # system tz

def log(msg):
    ts = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S%z")
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(f"[{ts}] [parser] {msg}\n")

raw = open(text_path, "r", encoding="utf-8", errors="replace").read()
log(f"Raw capture bytes: {len(raw)}")

# Strip ANSI
raw = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", raw)
# Replace box drawing chars with spaces
raw = raw.translate(str.maketrans({"│":" ","╭":" ","╮":" ","╰":" ","╯":" ","─":" ","•":" ","╳":" "}))
lines = [re.sub(r"\s+"," ",ln).strip() for ln in raw.splitlines() if ln.strip()]

MONTHS = {m:i for i,m in enumerate(["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"], start=1)}

def next_local_time_to_epoch(hhmm: str) -> int:
    h, m = map(int, hhmm.split(":"))
    now = datetime.now().astimezone()
    cand = datetime.combine(now.date(), time(h, m), tzinfo=tz)
    if cand <= now:
        cand += timedelta(days=1)
    return int(cand.timestamp())

def parse_no_year_to_epoch(s: str) -> int:
    m = re.match(r"^(\d{1,2}):(\d{2}) on (\d{1,2}) ([A-Za-z]{3})$", s.strip())
    if not m:
        raise ValueError(s)
    hh, mm, dd, mon = int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)
    now = datetime.now().astimezone()
    yr = now.year
    cand = datetime(yr, MONTHS[mon], dd, hh, mm, tzinfo=tz)
    if cand <= now:
        cand = datetime(yr + 1, MONTHS[mon], dd, hh, mm, tzinfo=tz)
    return int(cand.timestamp())

def reset_str_to_epoch(s):
    if not s:
        return None
    s = s.strip()
    if re.fullmatch(r"\d{1,2}:\d{2}", s):
        return next_local_time_to_epoch(s)
    if " on " in s:
        try:
            return parse_no_year_to_epoch(s)
        except Exception as e:
            log(f"Failed parsing dated reset {s!r}: {e}")
            return None
    return None

limits = {
  "main": {"five_hour_left_percent": None, "five_hour_resets_at": None, "weekly_left_percent": None, "weekly_resets_at": None},
  "spark": {"five_hour_left_percent": None, "five_hour_resets_at": None, "weekly_left_percent": None, "weekly_resets_at": None},
}

section = "main"
re_5h = re.compile(r"5h limit:.*?(\d+)% left(?:.*?resets ([0-9]{1,2}:[0-9]{2}))?", re.I)
re_week = re.compile(r"Weekly limit:.*?(\d+)% left", re.I)
re_week_reset_next = re.compile(r"^\(resets (.+)\)$", re.I)

for i, ln in enumerate(lines):
    if "GPT-5.3-Codex-Spark limit" in ln or "Spark limit" in ln:
        section = "spark"
        continue

    m5 = re_5h.search(ln)
    if m5 and limits[section]["five_hour_left_percent"] is None:
        limits[section]["five_hour_left_percent"] = int(m5.group(1))
        limits[section]["five_hour_resets_at"] = reset_str_to_epoch(m5.group(2))

    mw = re_week.search(ln)
    if mw and limits[section]["weekly_left_percent"] is None:
        limits[section]["weekly_left_percent"] = int(mw.group(1))
        if i + 1 < len(lines):
            mnext = re_week_reset_next.match(lines[i+1])
            if mnext:
                limits[section]["weekly_resets_at"] = reset_str_to_epoch(mnext.group(1))

payload = {
  "captured_at": int(datetime.now().astimezone().timestamp()),
  "timezone": str(tz),
  "limits": limits,
}

log(f"Parsed limits: {limits}")

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)

print(out_path)
PY

log "Wrote: $OUT_JSON"
cat "$OUT_JSON" | sed 's/^/  /' | tee -a "$LOG_FILE" >&2

log "Quitting Codex..."
tmux send-keys -t "$PANE" "/quit" Enter || true
sleep 0.4
log "Killing tmux session..."
tmux kill-session -t "$SESSION" || true
log "=== DONE ==="
