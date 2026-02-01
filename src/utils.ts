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

function rowToString(d: CloudflareIPData): string[] {
  const loss = ((d.sent - d.received) / d.sent).toFixed(2);
  const speedMb = (d.downloadSpeed / 1024 / 1024).toFixed(2);
  return [d.ip, String(d.sent), String(d.received), loss, d.delayMs.toFixed(2), speedMb];
}

export function exportCsv(data: CloudflareIPData[]): void {
  if (noOutput() || data.length === 0) return;
  const fs = require("fs");
  const header = "IP Address,Sent,Received,Loss Rate,Average Delay,Download Speed (MB/s)";
  const rows = data.map(rowToString).map((r) => r.join(","));
  fs.writeFileSync(output, [header, ...rows].join("\n"), "utf-8");
}

export function printResults(data: CloudflareIPData[]): void {
  if (noPrintResult()) return;
  if (data.length === 0) {
    console.log(cli.dim("\nNo results to show."));
    return;
  }
  const n = Math.min(printNum, data.length);
  const hasLongIp = data.some((d) => d.ip.length > 15);
  const w = hasLongIp ? 42 : 17;
  console.log("");
  console.log(cli.bold("  Best IPs (latency + speed):"));
  console.log(
    cli.dim(
      "  " +
        "IP Address".padEnd(w) +
        "Sent  Recv  Loss   Delay(ms)  Speed(MB/s)"
    )
  );
  for (let i = 0; i < n; i++) {
    const d = data[i];
    const loss = ((d.sent - d.received) / d.sent).toFixed(2);
    const speedMb = (d.downloadSpeed / 1024 / 1024).toFixed(2);
    console.log(
      "  " +
        cli.green(d.ip.padEnd(w)) +
        String(d.sent).padEnd(5) +
        String(d.received).padEnd(6) +
        loss.padEnd(7) +
        d.delayMs.toFixed(0).padEnd(10) +
        speedMb
    );
  }
  if (!noOutput()) {
    console.log(cli.dim(`\n  Results saved to ${output}`));
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

const PROGRESS_LINE_LENGTH = 100;

/** Real-time progress: step, count, current IP. Successful IPs shown in green. */
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
    const part = cli.dim(`${stepLabel}  ${countLabel}: ${current}/${total}`);
    const ipDisplay = lastIp
      ? lastSuccess
        ? `  ${cli.green(lastIp)}`
        : `  ${lastIp}`
      : "";
    const line = pad(part + ipDisplay, PROGRESS_LINE_LENGTH);
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
      const line = pad(
        `${stepLabel}  ${countLabel}: ${current}/${total} ${cli.green("✓")}`,
        PROGRESS_LINE_LENGTH
      );
      process.stdout.write(`\r${line}\n`);
    },
  };
}
