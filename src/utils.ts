export const DEFAULT_OUTPUT = "result.csv";
const MAX_DELAY_MS = 9999;

/** ANSI colors for CLI (disabled if not a TTY so pipes stay clean). */
const isTty = process.stdout.isTTY === true;
export const cli = {
  green: (s: string) => (isTty ? `\x1b[32m${s}\x1b[0m` : s),
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

export function printResults(data: CloudflareIPData[]): void {
  if (noPrintResult()) return;
  if (data.length === 0) {
    console.log(cli.dim("\nNo results."));
    return;
  }
  const n = Math.min(printNum, data.length);
  const w = 16;
  const hasXray = data.some((d) => d.xrayLatencyMs !== undefined);
  console.log("");
  console.log(cli.bold("  Best IPs"));
  console.log(
    cli.dim(
      "  " +
        "IP".padEnd(w) +
        "Delay(ms)  " +
        "Speed(MB/s)" +
        (hasXray ? "  Xray(ms)" : "")
    )
  );
  for (let i = 0; i < n; i++) {
    const d = data[i];
    const speedMb = (d.downloadSpeed / 1024 / 1024).toFixed(2);
    const xrayMs = d.xrayLatencyMs !== undefined ? d.xrayLatencyMs.toFixed(0) : "";
    console.log(
      "  " +
        cli.green(d.ip.padEnd(w)) +
        String(Math.round(d.delayMs)).padEnd(9) +
        speedMb +
        (hasXray ? "  " + xrayMs : "")
    );
  }
  if (!noOutput()) {
    console.log(cli.dim(`  → ${output}`));
  }
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

const BAR_WIDTH = 20;
const LINE_LEN = 72;

function progressBar(current: number, total: number): string {
  if (total <= 0) return "[" + " ".repeat(BAR_WIDTH) + "]";
  const p = Math.min(1, current / total);
  const filled = Math.round(BAR_WIDTH * p);
  return "[" + "=".repeat(filled) + " ".repeat(BAR_WIDTH - filled) + "]";
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
  done: () => void;
};

/** Overall progress for the whole scan (no per-IP display). */
export function createOverallProgress(label: string, total: number): OverallProgress {
  let current = 0;
  let totalCount = Math.max(0, total);
  const pad = (s: string, len: number) =>
    s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);

  const write = (done = false) => {
    const pct = totalCount > 0 ? Math.round((100 * current) / totalCount) : 0;
    const bar = progressBar(current, totalCount);
    const cnt = `${current}/${totalCount}`;
    const suffix = done ? ` ${cli.green("done")}` : "";
    const line = pad(`${label} ${bar} ${pct}% ${cnt}${suffix}`, LINE_LEN);
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
    done() {
      current = totalCount;
      write(true);
      process.stdout.write("\n");
    },
  };
}
