export const DEFAULT_OUTPUT = "result.csv";
const MAX_DELAY_MS = 9999;

/** ANSI colors for CLI (disabled if not a TTY so pipes stay clean). */
const isTty = process.stdout.isTTY === true;
export const cli = {
  green: (s: string) => (isTty ? `\x1b[32m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTty ? `\x1b[36m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTty ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s: string) => (isTty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (isTty ? `\x1b[1m${s}\x1b[0m` : s),
};
const MIN_DELAY_MS = 0;
const MAX_LOSS_RATE = 1.0;

export let inputMaxDelayMs = MAX_DELAY_MS;
export let inputMinDelayMs = MIN_DELAY_MS;
export let inputMaxLossRate = MAX_LOSS_RATE;
export let output = DEFAULT_OUTPUT;
export let printNum = 10;

export function setUtilsOptions(opts: {
  inputMaxDelayMs?: number;
  inputMinDelayMs?: number;
  inputMaxLossRate?: number;
  output?: string;
  printNum?: number;
}) {
  if (opts.inputMaxDelayMs !== undefined) inputMaxDelayMs = opts.inputMaxDelayMs;
  if (opts.inputMinDelayMs !== undefined) inputMinDelayMs = opts.inputMinDelayMs;
  if (opts.inputMaxLossRate !== undefined) inputMaxLossRate = opts.inputMaxLossRate;
  if (opts.output !== undefined) output = opts.output;
  if (opts.printNum !== undefined) printNum = opts.printNum;
}

export function noPrintResult(): boolean {
  return printNum === 0;
}

export function noOutput(): boolean {
  return !output || output.trim() === "";
}

import type { CloudflareIPData } from "./types";

function getLossRate(d: CloudflareIPData): number {
  return (d.sent - d.received) / d.sent;
}

export function filterDelay(data: CloudflareIPData[]): CloudflareIPData[] {
  if (inputMaxDelayMs > MAX_DELAY_MS || inputMinDelayMs < MIN_DELAY_MS) return data;
  if (inputMaxDelayMs === MAX_DELAY_MS && inputMinDelayMs === MIN_DELAY_MS) return data;
  return data.filter((v) => v.delayMs >= inputMinDelayMs && v.delayMs <= inputMaxDelayMs);
}

export function filterLossRate(data: CloudflareIPData[]): CloudflareIPData[] {
  if (inputMaxLossRate >= MAX_LOSS_RATE) return data;
  return data.filter((v) => getLossRate(v) <= inputMaxLossRate);
}

export function sortByDelayAndLoss(data: CloudflareIPData[]): CloudflareIPData[] {
  return [...data].sort((a, b) => {
    const ra = getLossRate(a);
    const rb = getLossRate(b);
    if (ra !== rb) return ra - rb;
    return a.delayMs - b.delayMs;
  });
}

export function sortBySpeed(data: CloudflareIPData[]): CloudflareIPData[] {
  return [...data].sort((a, b) => b.downloadSpeed - a.downloadSpeed);
}

function rowToString(d: CloudflareIPData, includeXray: boolean): string[] {
  const loss = ((d.sent - d.received) / d.sent).toFixed(2);
  const speedMb = (d.downloadSpeed / 1024 / 1024).toFixed(2);
  const base = [
    d.ip,
    String(d.sent),
    String(d.received),
    loss,
    d.delayMs.toFixed(2),
    speedMb,
  ];
  if (!includeXray) return base;
  const xray = d.xrayLatencyMs !== undefined ? d.xrayLatencyMs.toFixed(2) : "";
  return [...base, xray];
}

export function exportCsv(data: CloudflareIPData[]): void {
  if (noOutput() || data.length === 0) return;
  const fs = require("fs");
  const hasXray = data.some((d) => d.xrayLatencyMs !== undefined);
  const header = hasXray
    ? "IP Address,Sent,Received,Loss Rate,Average Delay,Download Speed (MB/s),Xray Latency (ms)"
    : "IP Address,Sent,Received,Loss Rate,Average Delay,Download Speed (MB/s)";
  const rows = data.map((d) => rowToString(d, hasXray)).map((r) => r.join(","));
  fs.writeFileSync(output, [header, ...rows].join("\n"), "utf-8");
}

const TABLE = {
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  h: "─",
  v: "│",
  cross: "┼",
};

function padCol(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

export function printResults(data: CloudflareIPData[]): void {
  if (noPrintResult()) return;
  if (data.length === 0) {
    console.log("");
    console.log(cli.dim("  No results."));
    return;
  }
  const n = Math.min(printNum, data.length);
  const hasXray = data.some((d) => d.xrayLatencyMs !== undefined);
  const ipW = 18;
  const delayW = 10;
  const speedW = 12;
  const xrayW = hasXray ? 10 : 0;
  const totalW = ipW + delayW + speedW + (hasXray ? xrayW + 3 : 2);

  const sep = TABLE.h.repeat(ipW) + TABLE.cross + TABLE.h.repeat(delayW) + TABLE.cross + TABLE.h.repeat(speedW) + (hasXray ? TABLE.cross + TABLE.h.repeat(xrayW) : "");
  const top = TABLE.tl + sep + TABLE.tr;
  const mid = TABLE.v + TABLE.h.repeat(totalW) + TABLE.v;
  const bot = TABLE.bl + sep + TABLE.br;

  console.log("");
  console.log(cli.bold("  Best IPs"));
  console.log("  " + top);
  const headerIp = padCol("IP", ipW);
  const headerDelay = padCol("Delay (ms)", delayW);
  const headerSpeed = padCol("Speed MB/s", speedW);
  const headerXray = hasXray ? padCol("Xray (ms)", xrayW) : "";
  console.log(
    "  " +
      TABLE.v +
      cli.cyan(headerIp) +
      TABLE.v +
      cli.cyan(headerDelay) +
      TABLE.v +
      cli.cyan(headerSpeed) +
      (hasXray ? TABLE.v + cli.cyan(headerXray) : "") +
      TABLE.v
  );
  console.log("  " + mid);
  for (let i = 0; i < n; i++) {
    const d = data[i];
    const speedMb = (d.downloadSpeed / 1024 / 1024).toFixed(2);
    const xrayMs = d.xrayLatencyMs !== undefined ? String(Math.round(d.xrayLatencyMs)) : "";
    const row =
      TABLE.v +
      cli.green(padCol(d.ip, ipW)) +
      TABLE.v +
      padCol(String(Math.round(d.delayMs)), delayW) +
      TABLE.v +
      padCol(speedMb, speedW) +
      (hasXray ? TABLE.v + padCol(xrayMs, xrayW) : "") +
      TABLE.v;
    console.log("  " + row);
  }
  console.log("  " + bot);
  if (!noOutput()) {
    console.log(cli.dim(`  Saved: ${output}`));
  }
  console.log("");
}

/** Simple progress: print every N items. */
export function createProgress(total: number, label: string): {
  grow: (n: number, str?: string) => void;
  done: () => void;
} {
  let current = 0;
  const step = Math.max(1, Math.floor(total / 50));
  return {
    grow(n: number, _str?: string) {
      current += n;
      if (current % step === 0 || current === total) {
        process.stdout.write(`\r${label} ${current}/${total}`);
      }
    },
    done() {
      process.stdout.write(`\r${label} ${total}/${total}\n`);
    },
  };
}

const BAR_WIDTH = 24;
const LINE_LEN = 78;

function progressBar(current: number, total: number): string {
  if (total <= 0) return "▌" + "░".repeat(BAR_WIDTH) + "▐";
  const p = Math.min(1, current / total);
  const filled = Math.round(BAR_WIDTH * p);
  return "▌" + "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled) + "▐";
}

/** Real-time progress: step, bar %, count, current IP. Success = green. */
export function createRealtimeProgress(
  stepLabel: string,
  total: number,
  countLabel: string
): {
  grow: (n: number, currentIp?: string, success?: boolean) => void;
  setCurrent: (currentIp: string) => void;
  done: () => void;
} {
  let current = 0;
  let lastIp = "";
  let lastSuccess = false;
  const pad = (s: string, len: number) =>
    s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);

  const write = () => {
    const pct = total > 0 ? Math.round((100 * current) / total) : 0;
    const bar = progressBar(current, total);
    const cnt = `${current}/${total}`;
    const ipPart = lastIp
      ? lastSuccess
        ? ` ${cli.green(lastIp)}`
        : ` ${lastIp}`
      : "";
    const line = pad(
      `${stepLabel} ${bar} ${pct}% ${cnt}${ipPart}`,
      LINE_LEN
    );
    process.stdout.write(`\r${line}`);
  };

  return {
    grow(n: number, currentIp?: string, success?: boolean) {
      current += n;
      if (currentIp !== undefined) lastIp = currentIp;
      if (success !== undefined) lastSuccess = success;
      write();
    },
    setCurrent(currentIp: string) {
      lastIp = currentIp;
      write();
    },
    done() {
      lastIp = "";
      const pct = total > 0 ? Math.round((100 * current) / total) : 100;
      const line = pad(
        `${stepLabel} ${progressBar(current, total)} ${pct}% ${cli.green("done")}`,
        LINE_LEN
      );
      process.stdout.write(`\r${line}\n`);
    },
  };
}

export type OverallProgress = {
  grow: (n: number) => void;
  addTotal: (n: number) => void;
  setLabel: (label: string) => void;
  reset: (label: string, total: number) => void;
  done: () => void;
};

/** Overall progress for the whole scan (no per-IP display). */
export function createOverallProgress(label: string, total: number): OverallProgress {
  let current = 0;
  let totalCount = Math.max(0, total);
  let phaseLabel = label;
  const pad = (s: string, len: number) =>
    s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);

  const write = (done = false) => {
    const pct = totalCount > 0 ? Math.round((100 * current) / totalCount) : 0;
    const bar = progressBar(current, totalCount);
    const cnt = `${current}/${totalCount}`;
    const suffix = done ? ` ${cli.green("done")}` : "";
    const phase = cli.cyan(phaseLabel);
    const line = pad(`${phase} ${bar} ${pct}% ${cnt}${suffix}`, LINE_LEN + 10);
    process.stdout.write(`\r${line}`);
  };

  return {
    grow(n: number) {
      current += n;
      if (current > totalCount) current = totalCount;
      write();
    },
    addTotal(n: number) {
      totalCount = Math.max(0, totalCount + n);
      write();
    },
    setLabel(label: string) {
      phaseLabel = label;
      write();
    },
    reset(label: string, total: number) {
      phaseLabel = label;
      current = 0;
      totalCount = Math.max(0, total);
      write();
    },
    done() {
      current = totalCount;
      write(true);
      process.stdout.write("\n");
    },
  };
}
