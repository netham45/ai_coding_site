#!/usr/bin/env node

const pty = require("node-pty");

function parseArgs(argv) {
  const args = {
    codexPath: "codex",
    slowDelay: 0.1,
    readyTimeout: 30,
    statusTimeout: 30,
    debug: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--codex-path") {
      i += 1;
      if (i >= argv.length) throw new Error("--codex-path requires a value");
      args.codexPath = argv[i];
    } else if (a === "--slow-delay") {
      i += 1;
      if (i >= argv.length) throw new Error("--slow-delay requires a value");
      args.slowDelay = Number(argv[i]);
    } else if (a === "--ready-timeout") {
      i += 1;
      if (i >= argv.length) throw new Error("--ready-timeout requires a value");
      args.readyTimeout = Number(argv[i]);
    } else if (a === "--status-timeout") {
      i += 1;
      if (i >= argv.length) throw new Error("--status-timeout requires a value");
      args.statusTimeout = Number(argv[i]);
    } else if (a === "--debug") {
      args.debug = true;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  return args;
}

function printHelp() {
  const text = [
    "Usage: node codex_status.js [options]",
    "",
    "Options:",
    "  --codex-path <path>      Path to codex executable (default: codex)",
    "  --slow-delay <seconds>   Delay per typed character (default: 0.10)",
    "  --ready-timeout <sec>    Wait for Codex UI ready (default: 30)",
    "  --status-timeout <sec>   Wait for /status output (default: 30)",
    "  --debug                  Enable debug logs to stderr",
    "  -h, --help               Show this help",
  ].join("\n");
  process.stdout.write(`${text}\n`);
}

function makeLogger(debug) {
  return (msg) => {
    if (!debug) return;
    const d = new Date();
    const offMin = -d.getTimezoneOffset();
    const sign = offMin >= 0 ? "+" : "-";
    const abs = Math.abs(offMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}${sign}${hh}${mm}`;
    process.stderr.write(`[${ts}] ${msg}\n`);
  };
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const BOX_RE = /[│╭╮╰╯─•╳]/g;

function normalizeCapture(raw) {
  const deansi = raw.replace(ANSI_RE, "").replace(BOX_RE, " ");
  const lines = [];
  for (const ln of deansi.split(/\r?\n/)) {
    const s = ln.replace(/\s+/g, " ").trim();
    if (s) lines.push(s);
  }
  return lines;
}

const MONTHS = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

function nextLocalTimeToEpoch(hhmm) {
  const [h, m] = hhmm.split(":").map((v) => Number(v));
  const now = new Date();
  const cand = new Date(now);
  cand.setHours(h, m, 0, 0);
  if (cand <= now) cand.setDate(cand.getDate() + 1);
  return Math.floor(cand.getTime() / 1000);
}

function parseNoYearToEpoch(s) {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]{3})$/);
  if (!m) throw new Error(`Unrecognized reset format: ${s}`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const mon = MONTHS[m[4]];
  if (!mon) throw new Error(`Unknown month: ${m[4]}`);
  const now = new Date();
  let cand = new Date(now.getFullYear(), mon - 1, dd, hh, mm, 0, 0);
  if (cand <= now) cand = new Date(now.getFullYear() + 1, mon - 1, dd, hh, mm, 0, 0);
  return Math.floor(cand.getTime() / 1000);
}

function resetStrToEpoch(s) {
  if (!s) return null;
  const trimmed = s.trim();
  if (/^\d{1,2}:\d{2}$/.test(trimmed)) return nextLocalTimeToEpoch(trimmed);
  if (trimmed.includes(" on ")) {
    try {
      return parseNoYearToEpoch(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

const RE_5H = /5h limit:.*?(\d+)% left(?:.*?resets\s+([0-9]{1,2}:[0-9]{2}))?/i;
const RE_WEEK = /Weekly limit:.*?(\d+)% left/i;
const RE_WEEK_RESET_NEXT = /^\(?resets\s+(.+?)\)?$/i;
const RE_RESET_INLINE = /resets\s+([0-9]{1,2}:[0-9]{2}(?:\s+on\s+\d{1,2}\s+[A-Za-z]{3})?)/i;

function extractLimits(lines, log) {
  const mk = () => ({
    five_hour_left_percent: null,
    five_hour_resets_at: null,
    weekly_left_percent: null,
    weekly_resets_at: null,
  });
  const main = mk();
  const spark = mk();
  let section = "main";

  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    if (ln.includes("GPT-5.3-Codex-Spark limit") || ln.includes("Spark limit")) {
      section = "spark";
      continue;
    }

    const target = section === "main" ? main : spark;

    const m5 = ln.match(RE_5H);
    if (m5 && target.five_hour_left_percent == null) {
      target.five_hour_left_percent = Number(m5[1]);
      target.five_hour_resets_at = resetStrToEpoch(m5[2]);
    }

    const mw = ln.match(RE_WEEK);
    if (mw) {
      if (target.weekly_left_percent == null) {
        target.weekly_left_percent = Number(mw[1]);
      }
      if (target.weekly_resets_at == null) {
        const inline = ln.match(RE_RESET_INLINE);
        if (inline) {
          target.weekly_resets_at = resetStrToEpoch(inline[1]);
        } else if (i + 1 < lines.length) {
          const next = lines[i + 1].match(RE_WEEK_RESET_NEXT);
          if (next) target.weekly_resets_at = resetStrToEpoch(next[1]);
        }
      }
    }
  }

  log(`Parsed main=${JSON.stringify(main)}`);
  log(`Parsed spark=${JSON.stringify(spark)}`);

  return { main, spark };
}

function tailForLog(text, maxChars = 400) {
  const cleaned = text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  if (cleaned.length <= maxChars) return cleaned;
  return `...${cleaned.slice(-maxChars)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function respondToTerminalQueries(stdin, text, log) {
  if (text.includes("\x1b[6n")) {
    stdin.write("\x1b[1;1R");
    log("Replied to terminal query ESC[6n with ESC[1;1R.");
  }
  if (text.includes("\x1b[c")) {
    stdin.write("\x1b[?1;2c");
    log("Replied to terminal query ESC[c with ESC[?1;2c.");
  }
  if (text.includes("\x1b]10;?")) {
    stdin.write("\x1b]10;rgb:cccc/cccc/cccc\x1b\\");
    log("Replied to terminal color query OSC 10.");
  }
  if (text.includes("\x1b]11;?")) {
    stdin.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
    log("Replied to terminal color query OSC 11.");
  }
}

async function slowType(stdin, text, delayS) {
  for (const ch of text) {
    stdin.write(ch);
    if (delayS > 0) await sleep(delayS * 1000);
  }
}

async function sendLine(stdin, line, delayS) {
  await slowType(stdin, line, delayS);
  stdin.write("\r");
}

async function waitForMarkers(ctx, opts) {
  const {
    markers,
    timeoutS,
    phase,
    idleReadyBytes = 0,
    idleReadyS = 1.0,
  } = opts;

  const deadline = Date.now() + timeoutS * 1000;
  let nextProgress = Date.now() + 2000;

  while (Date.now() < deadline) {
    if (ctx.exitCode !== null) {
      throw new Error(
        `Codex exited during ${phase} with code ${ctx.exitCode}. Captured tail: ${tailForLog(ctx.buf)}`
      );
    }

    if (ctx.bufChanged) {
      ctx.bufChanged = false;
      const normText = normalizeCapture(ctx.buf.slice(-12000)).join("\n");
      if (markers.some((m) => normText.includes(m))) {
        ctx.log(`Matched marker for ${phase}. bytes_seen=${ctx.bytesSeen}`);
        return;
      }
    }

    const now = Date.now();
    if (idleReadyBytes && ctx.bytesSeen >= idleReadyBytes && (now - ctx.lastChunkAt) >= idleReadyS * 1000) {
      ctx.log(`No new output for ${idleReadyS.toFixed(2)}s after ${ctx.bytesSeen} bytes; treating ${phase} as ready.`);
      return;
    }

    if (now >= nextProgress) {
      ctx.log(`Still waiting (${phase})... bytes_seen=${ctx.bytesSeen}, tail=${tailForLog(ctx.buf)}`);
      nextProgress = now + 2000;
    }

    await sleep(50);
  }

  ctx.log(`Timed out waiting for markers (${phase}): ${JSON.stringify(markers)}. Tail:\n${ctx.buf.slice(-2000)}`);
  throw new Error("Timed out waiting for expected output from Codex.");
}

async function runCodexStatus({ codexPath, slowDelay, readyTimeout, statusTimeout, debug }, log) {
  const args = ["--no-alt-screen", "-c", "check_for_update_on_startup=false"];
  log(`Spawning: ${codexPath} ${args.join(" ")}`);

  const child = pty.spawn(codexPath, args, {
    name: process.env.TERM || "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: { ...process.env },
  });

  const ctx = {
    log,
    buf: "",
    captureChunks: [],
    bytesSeen: 0,
    lastChunkAt: Date.now(),
    bufChanged: false,
    exitCode: null,
  };

  child.onData((text) => {
    respondToTerminalQueries(child, text, log);
    ctx.buf += text;
    ctx.captureChunks.push(text);
    ctx.bytesSeen += Buffer.byteLength(text, "utf8");
    ctx.lastChunkAt = Date.now();
    ctx.bufChanged = true;
  });

  child.onExit(({ exitCode }) => {
    if (debug) {
      log(`Codex exited: ${exitCode}`);
    }
    ctx.exitCode = exitCode == null ? 0 : exitCode;
  });

  try {
    log("Waiting for Codex UI to be ready...");
    await waitForMarkers(ctx, {
      markers: [
        "OpenAI Codex (v",
        "model:",
        "/model to change",
        "? for shortcuts",
        "Run /status",
        "› Find and fix a bug",
      ],
      timeoutS: readyTimeout,
      phase: "startup",
      idleReadyBytes: 1200,
      idleReadyS: 1.0,
    });
    log("Ready.");

    log("Sending /status (slow)...");
    await sendLine(child, "/status", slowDelay);

    log("Waiting for /status output...");
    await waitForMarkers(ctx, {
      markers: ["5h limit:", "Weekly limit:", "/codex/settings/usage"],
      timeoutS: statusTimeout,
      phase: "status",
    });

    await sleep(600);

    log("Sending /quit...");
    await sendLine(child, "/quit", slowDelay);

    const ended = await Promise.race([
      new Promise((resolve) => {
        const interval = setInterval(() => {
          if (ctx.exitCode !== null) {
            clearInterval(interval);
            resolve(true);
          }
        }, 50);
      }),
      sleep(2000).then(() => false),
    ]);

    if (!ended) {
      log("Codex did not exit promptly; terminating.");
      child.kill();
      const ended2 = await Promise.race([
        new Promise((resolve) => {
          const interval = setInterval(() => {
            if (ctx.exitCode !== null) {
              clearInterval(interval);
              resolve(true);
            }
          }, 50);
        }),
        sleep(2000).then(() => false),
      ]);
      if (!ended2) {
        log("Codex still running; killing.");
        child.kill();
      }
    }

    return ctx.captureChunks.join("");
  } finally {
    // no-op
  }
}

function getTimezoneLabel() {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" });
  const parts = dtf.formatToParts(new Date());
  const tzPart = parts.find((p) => p.type === "timeZoneName");
  return tzPart ? tzPart.value : "local";
}

async function main() {
  try {
    const args = parseArgs(process.argv);
    const log = makeLogger(args.debug);

    const raw = await runCodexStatus(args, log);
    const lines = normalizeCapture(raw);
    const limits = extractLimits(lines, log);

    const payload = {
      captured_at: Math.floor(Date.now() / 1000),
      timezone: getTimezoneLabel(),
      limits,
    };

    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    process.exit(1);
  }
}

main();
