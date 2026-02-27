#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import pty
import re
import select
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta
from typing import Optional, List


# ----------------------------
# Debug logging
# ----------------------------

def make_logger(debug: bool):
    def log(msg: str):
        if not debug:
            return
        ts = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S%z")
        line = f"[{ts}] {msg}\n"
        sys.stderr.write(line)
        sys.stderr.flush()
    return log


# ----------------------------
# PTY subprocess helpers
# ----------------------------

def set_pty_nonblocking(fd: int):
    import fcntl
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

def set_pty_winsize(fd: int, rows: int = 40, cols: int = 120):
    import fcntl
    import struct
    import termios
    # struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; }
    winsz = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsz)

def read_pty_available(master_fd: int, timeout_s: float) -> str:
    """Read whatever is available on the PTY within timeout_s, return decoded text."""
    chunks: List[bytes] = []
    r, _, _ = select.select([master_fd], [], [], timeout_s)
    if not r:
        return ""
    while True:
        try:
            data = os.read(master_fd, 4096)
            if not data:
                break
            chunks.append(data)
            # If more data is immediately available, keep draining; otherwise stop.
            r2, _, _ = select.select([master_fd], [], [], 0)
            if not r2:
                break
        except BlockingIOError:
            break
        except OSError:
            break
    if not chunks:
        return ""
    return b"".join(chunks).decode("utf-8", errors="replace")

def tail_for_log(text: str, max_chars: int = 400) -> str:
    cleaned = text.replace("\r", "\\r").replace("\n", "\\n")
    if len(cleaned) <= max_chars:
        return cleaned
    return f"...{cleaned[-max_chars:]}"

def respond_to_terminal_queries(master_fd: int, text: str, log) -> None:
    # Some Codex UI stacks probe terminal capabilities and can stall if probes are unanswered.
    # Reply with conservative values to keep startup progressing in raw PTY mode.
    if "\x1b[6n" in text:
        os.write(master_fd, b"\x1b[1;1R")  # Cursor position report: row 1, col 1.
        log("Replied to terminal query ESC[6n with ESC[1;1R.")
    if "\x1b[c" in text:
        os.write(master_fd, b"\x1b[?1;2c")  # Primary DA: VT100 with advanced video option.
        log("Replied to terminal query ESC[c with ESC[?1;2c.")
    if "\x1b]10;?" in text:
        os.write(master_fd, b"\x1b]10;rgb:cccc/cccc/cccc\x1b\\")
        log("Replied to terminal color query OSC 10.")
    if "\x1b]11;?" in text:
        os.write(master_fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
        log("Replied to terminal color query OSC 11.")

def slow_type(master_fd: int, text: str, delay_s: float):
    for ch in text:
        os.write(master_fd, ch.encode("utf-8"))
        time.sleep(delay_s)

def send_line(master_fd: int, line: str, delay_s: float):
    slow_type(master_fd, line, delay_s)
    os.write(master_fd, b"\r")


# ----------------------------
# Parsing helpers
# ----------------------------

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
BOX_TRANS = str.maketrans({
    "│": " ", "╭": " ", "╮": " ", "╰": " ", "╯": " ",
    "─": " ", "•": " ", "╳": " ",
})
MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1
)}

RE_5H = re.compile(r"5h limit:.*?(\d+)% left(?:.*?resets\s+([0-9]{1,2}:[0-9]{2}))?", re.I)
RE_WEEK = re.compile(r"Weekly limit:.*?(\d+)% left", re.I)
RE_WEEK_RESET_NEXT = re.compile(r"^\(?resets\s+(.+?)\)?$", re.I)
RE_RESET_INLINE = re.compile(
    r"resets\s+([0-9]{1,2}:[0-9]{2}(?:\s+on\s+\d{1,2}\s+[A-Za-z]{3})?)",
    re.I,
)

def normalize_capture(raw: str) -> List[str]:
    raw = ANSI_RE.sub("", raw)
    raw = raw.translate(BOX_TRANS)
    lines = []
    for ln in raw.splitlines():
        ln = re.sub(r"\s+", " ", ln).strip()
        if ln:
            lines.append(ln)
    return lines

def next_local_time_to_epoch(hhmm: str, tz) -> int:
    h, m = map(int, hhmm.split(":"))
    now = datetime.now().astimezone()
    cand = datetime.combine(now.date(), dtime(h, m), tzinfo=tz)
    if cand <= now:
        cand += timedelta(days=1)
    return int(cand.timestamp())

def parse_no_year_to_epoch(s: str, tz) -> int:
    # "03:49 on 28 Feb"
    m = re.match(r"^(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]{3})$", s.strip())
    if not m:
        raise ValueError(f"Unrecognized reset format: {s!r}")
    hh, mm, dd, mon = int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)
    mon_i = MONTHS.get(mon)
    if not mon_i:
        raise ValueError(f"Unknown month: {mon!r}")
    now = datetime.now().astimezone()
    yr = now.year
    cand = datetime(yr, mon_i, dd, hh, mm, tzinfo=tz)
    if cand <= now:
        cand = datetime(yr + 1, mon_i, dd, hh, mm, tzinfo=tz)
    return int(cand.timestamp())

def reset_str_to_epoch(s: Optional[str], tz) -> Optional[int]:
    if not s:
        return None
    s = s.strip()
    if re.fullmatch(r"\d{1,2}:\d{2}", s):
        return next_local_time_to_epoch(s, tz)
    if " on " in s:
        try:
            return parse_no_year_to_epoch(s, tz)
        except Exception:
            return None
    return None

@dataclass
class Limits:
    five_hour_left_percent: Optional[int] = None
    five_hour_resets_at: Optional[int] = None
    weekly_left_percent: Optional[int] = None
    weekly_resets_at: Optional[int] = None

def extract_limits(lines: List[str], log) -> dict:
    tz = datetime.now().astimezone().tzinfo  # system tz

    main = Limits()
    spark = Limits()
    section = "main"

    for i, ln in enumerate(lines):
        if "GPT-5.3-Codex-Spark limit" in ln or "Spark limit" in ln:
            section = "spark"
            continue

        target = main if section == "main" else spark

        m5 = RE_5H.search(ln)
        if m5 and target.five_hour_left_percent is None:
            target.five_hour_left_percent = int(m5.group(1))
            target.five_hour_resets_at = reset_str_to_epoch(m5.group(2), tz)

        mw = RE_WEEK.search(ln)
        if mw:
            if target.weekly_left_percent is None:
                target.weekly_left_percent = int(mw.group(1))
            if target.weekly_resets_at is None:
                minline = RE_RESET_INLINE.search(ln)
                if minline:
                    target.weekly_resets_at = reset_str_to_epoch(minline.group(1), tz)
                elif i + 1 < len(lines):
                    mnext = RE_WEEK_RESET_NEXT.match(lines[i + 1])
                    if mnext:
                        target.weekly_resets_at = reset_str_to_epoch(mnext.group(1), tz)

    log(f"Parsed main={main}")
    log(f"Parsed spark={spark}")

    return {
        "main": {
            "five_hour_left_percent": main.five_hour_left_percent,
            "five_hour_resets_at": main.five_hour_resets_at,
            "weekly_left_percent": main.weekly_left_percent,
            "weekly_resets_at": main.weekly_resets_at,
        },
        "spark": {
            "five_hour_left_percent": spark.five_hour_left_percent,
            "five_hour_resets_at": spark.five_hour_resets_at,
            "weekly_left_percent": spark.weekly_left_percent,
            "weekly_resets_at": spark.weekly_resets_at,
        },
    }


# ----------------------------
# Codex control logic
# ----------------------------

READY_MARKERS = [
    "OpenAI Codex (v",
    "model:",
    "/model to change",
    "? for shortcuts",
    "Run /status",
    "› Find and fix a bug",
]
STATUS_MARKERS = [
    "5h limit:",
    "Weekly limit:",
    "/codex/settings/usage",
]

def wait_for_markers(
    master_fd: int,
    markers: List[str],
    timeout_s: float,
    log,
    capture: List[str],
    proc: Optional[subprocess.Popen] = None,
    phase: str = "wait",
    idle_ready_bytes: int = 0,
    idle_ready_s: float = 1.0,
) -> None:
    deadline = time.monotonic() + timeout_s
    buf = ""
    bytes_seen = 0
    next_progress_log = time.monotonic() + 2.0
    last_chunk_at = time.monotonic()
    while time.monotonic() < deadline:
        if proc is not None:
            rc = proc.poll()
            if rc is not None:
                tail = tail_for_log(buf)
                raise RuntimeError(
                    f"Codex exited during {phase} with code {rc}. "
                    f"Captured tail: {tail}"
                )

        chunk = read_pty_available(master_fd, timeout_s=0.2)
        if chunk:
            respond_to_terminal_queries(master_fd, chunk, log)
            buf += chunk
            bytes_seen += len(chunk.encode("utf-8", errors="replace"))
            capture.append(chunk)
            last_chunk_at = time.monotonic()

            # Marker checks against normalized text are more robust than scanning raw
            # PTY bytes that contain heavy cursor/format control sequences.
            norm_text = "\n".join(normalize_capture(buf[-12000:]))
            if any(m in norm_text for m in markers):
                log(f"Matched marker for {phase}. bytes_seen={bytes_seen}")
                return

        now = time.monotonic()
        if idle_ready_bytes and bytes_seen >= idle_ready_bytes and (now - last_chunk_at) >= idle_ready_s:
            log(
                f"No new output for {idle_ready_s:.2f}s after {bytes_seen} bytes; "
                f"treating {phase} as ready."
            )
            return

        if now >= next_progress_log:
            log(
                f"Still waiting ({phase})... bytes_seen={bytes_seen}, "
                f"tail={tail_for_log(buf)}"
            )
            next_progress_log = now + 2.0

    # include a small tail in logs if debug
    tail = buf[-2000:]
    log(f"Timed out waiting for markers ({phase}): {markers}. Tail:\n{tail}")
    raise TimeoutError("Timed out waiting for expected output from Codex.")

def run_codex_status(
    codex_path: str,
    slow_delay: float,
    ready_timeout: float,
    status_timeout: float,
    debug: bool,
    log,
) -> str:
    master_fd, slave_fd = pty.openpty()
    set_pty_nonblocking(master_fd)
    set_pty_winsize(master_fd)
    set_pty_winsize(slave_fd)

    # Keep startup behavior aligned with the proven bash implementation.
    cmd = [codex_path, "--no-alt-screen", "-c", "check_for_update_on_startup=false"]

    log(f"Spawning: {' '.join(cmd)}")

    # Start in a new session so it behaves like a real terminal program
    proc = subprocess.Popen(
        cmd,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        start_new_session=True,
        close_fds=True,
        env=os.environ.copy(),
    )
    os.close(slave_fd)

    capture_chunks: List[str] = []

    try:
        log("Waiting for Codex UI to be ready...")
        wait_for_markers(
            master_fd,
            READY_MARKERS,
            ready_timeout,
            log,
            capture_chunks,
            proc=proc,
            phase="startup",
            idle_ready_bytes=1200,
            idle_ready_s=1.0,
        )
        log("Ready.")

        log("Sending /status (slow)...")
        send_line(master_fd, "/status", delay_s=slow_delay)

        log("Waiting for /status output...")
        wait_for_markers(
            master_fd,
            STATUS_MARKERS,
            status_timeout,
            log,
            capture_chunks,
            proc=proc,
            phase="status",
        )

        # Give it a moment to fully render the status box
        time.sleep(0.6)
        extra = read_pty_available(master_fd, timeout_s=0.2)
        if extra:
            capture_chunks.append(extra)

        log("Sending /quit...")
        send_line(master_fd, "/quit", delay_s=slow_delay)

        # Wait briefly for exit, then terminate if needed
        try:
            proc.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            log("Codex did not exit promptly; terminating.")
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                log("Codex still running; killing.")
                proc.kill()

        return "".join(capture_chunks)

    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser(description="Spawn Codex in a PTY, run /status, print limits JSON to stdout.")
    ap.add_argument("--codex-path", default="codex", help="Path to codex executable.")
    ap.add_argument("--slow-delay", type=float, default=0.10, help="Delay per character when typing commands.")
    ap.add_argument("--ready-timeout", type=float, default=30.0, help="Seconds to wait for Codex UI to appear.")
    ap.add_argument("--status-timeout", type=float, default=30.0, help="Seconds to wait for /status output.")
    ap.add_argument("--debug", action="store_true", help="Enable debug logs.")
    args = ap.parse_args()

    log = make_logger(args.debug)

    raw = run_codex_status(
        codex_path=args.codex_path,
        slow_delay=args.slow_delay,
        ready_timeout=args.ready_timeout,
        status_timeout=args.status_timeout,
        debug=args.debug,
        log=log,
    )

    lines = normalize_capture(raw)
    limits = extract_limits(lines, log)

    tz = datetime.now().astimezone().tzinfo
    payload = {
        "captured_at": int(datetime.now().astimezone().timestamp()),
        "timezone": str(tz),
        "limits": limits,
    }

    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
