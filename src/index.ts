#!/usr/bin/env node

import { setIPOptions, loadIPRanges, ipFile, ipText, lastLoadedRanges } from "./ip";
import {
  setUtilsOptions,
  filterDelay,
  filterLossRate,
  sortByDelayAndLoss,
  sortBySpeed,
  exportCsv,
  printResults,
  inputMaxLossRate,
  cli,
  createOverallProgress,
} from "./utils";
import { setPingOptions, runPing } from "./ping";
import { setDownloadOptions, testDownloadSpeed } from "./download";
import { setXrayOptions, testXrayForIps } from "./xray";

const VERSION = "2.2.5";

const LONG_TO_SHORT: Record<string, string> = {
  help: "help",
  version: "version",
  threads: "n",
  pingtimes: "t",
  downloadn: "dn",
  downloadsec: "dt",
  port: "tp",
  maxdelay: "tl",
  mindelay: "tll",
  maxloss: "tlr",
  print: "p",
  file: "f",
  output: "o",
  ip: "ip",
};

function parseArgs(): Record<string, string | number | boolean> {
  const args: Record<string, string | number | boolean> = {};
  const argv = process.argv.slice(2);
  const numericKeys = [
    "n", "t", "dn", "dt", "tp", "tl", "tll", "p",
    "httpingcode", "xraytimeout", "xrayn",
  ];
  const floatKeys = ["tlr", "sl"];
  const flagKeys = ["httping", "dd", "allip"];

  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "-h" || a === "--help") {
      args.help = true;
      continue;
    }
    if (a === "-v" || a === "--version") {
      args.version = true;
      continue;
    }
    let key: string;
    if (a.startsWith("--")) {
      key = a.slice(2).replace(/-/g, "");
      key = LONG_TO_SHORT[key] ?? key;
    } else if (a.startsWith("-")) {
      key = a.slice(1).replace(/-/g, "");
    } else {
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      if (numericKeys.includes(key)) {
        args[key] = parseInt(next, 10) || 0;
      } else if (floatKeys.includes(key)) {
        args[key] = parseFloat(next) || 0;
      } else {
        args[key] = next;
      }
      i++;
    } else if (flagKeys.includes(key)) {
      args[key] = true;
    }
  }
  return args;
}

const HELP = `
  CloudflareScanner ${VERSION}
  Find the fastest Cloudflare IPs (IPv4 + IPv6) — latency, speed, optional Xray check.

  USAGE
    npx cloudflare-scanner [options]
    npx cloudflare-scanner -f ip.txt -o result.csv -xray config.json

  SCAN
    -n, --threads <N>     Latency threads (default: 10, max: 1000)
    -t, --ping-times <N>  Pings per IP (default: 4)
    -tp, --port <N>       Test port (default: 443)
    -url <url>            Test URL (default: speed.cloudflare.com)
    -httping              Use HTTP instead of TCP for latency
    -cfcolo <codes>       Match region, e.g. HKG,KHH (HTTP only)

  SPEED
    -dn, --download-n <N> How many IPs to speed-test (default: 10)
    -dt, --download-sec   Seconds per speed test (default: 10)
    -dd                   Skip speed test (latency only)
    -sl <N>               Min speed MB/s (filter)

  FILTERS
    -tl, --max-delay <ms>   Max avg latency (default: 9999)
    -tll, --min-delay <ms>  Min avg latency (default: 0)
    -tlr, --max-loss <0-1>  Max packet loss (default: 1)

  INPUT / OUTPUT
    -f, --file <path>     IP list file (default: ip.txt)
    -ip <ranges>          IPs from CLI, e.g. 1.1.1.1,2.2.2.2/24
    -o, --output <path>   CSV output (default: result.csv, "" = none)
    -p, --print <N>       Show top N results (default: 10, 0 = none)
    -allip                Test every IP in range (IPv4, slower)

  XRAY (optional)
    -xray <path>          Config JSON; outbound address = clean IP
    -xraybin <path>       Xray binary (default: xray)
    -xrayurl <url>        URL to test via proxy
    -xraytimeout <sec>    Timeout per IP (default: 10)
    -xrayn <N>            Max IPs to test (0 = all)

  MISC
    -v, --version         Show version
    -h, --help            Show this help
`;

async function checkUpdate(): Promise<string> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/Ptechgithub/CloudflareScanner/releases/latest",
      { signal: AbortSignal.timeout(10000) }
    );
    const data = (await res.json()) as { tag_name?: string };
    return data.tag_name && data.tag_name !== VERSION ? data.tag_name : "";
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (args.version) {
    console.log("  CloudflareScanner " + VERSION);
    const v = await checkUpdate();
    if (v) console.log(cli.yellow("  Update available: " + v));
    process.exit(0);
  }


  setIPOptions({
    testAll: !!args.allip,
    ipFile: (args.f as string) || "ip.txt",
    ipText: (args.ip as string) || "",
  });
  setUtilsOptions({
    inputMaxDelayMs: (args.tl as number) || 9999,
    inputMinDelayMs: (args.tll as number) || 0,
    inputMaxLossRate: (args.tlr as number) ?? 1,
    output: (args.o as string) ?? "result.csv",
    printNum: (args.p as number) ?? 10,
  });
  setPingOptions({
    routines: (args.n as number) || 10,
    pingTimes: (args.t as number) || 4,
    tcpPort: (args.tp as number) || 443,
    url: (args.url as string) || "https://speed.cloudflare.com/__down?bytes=52428800",
    httping: !!args.httping,
    httpingStatusCode: (args.httpingcode as number) || 0,
    httpingCFColo: (args.cfcolo as string) || "",
  });
  setDownloadOptions({
    url: (args.url as string) || "https://speed.cloudflare.com/__down?bytes=52428800",
    timeoutSec: (args.dt as number) || 10,
    disable: !!args.dd,
    testCount: (args.dn as number) || 10,
    minSpeed: (args.sl as number) || 0,
  });
  setXrayOptions({
    configPath: (args.xray as string) || "",
    bin: (args.xraybin as string) || "xray",
    testUrl: (args.xrayurl as string) || "https://www.cloudflare.com/cdn-cgi/trace",
    timeoutSec: (args.xraytimeout as number) || 10,
    maxCount: (args.xrayn as number) || 0,
  });

  const source = ipText ? "CLI" : ipFile || "ip.txt";
  const ips = loadIPRanges();
  if (ips.length === 0) {
    console.error(cli.dim("No IPs. Use -f <file> or -ip <ranges>."));
    process.exit(1);
  }
  const r = lastLoadedRanges.length;

  console.log("");
  console.log(cli.bold("  CloudflareScanner " + VERSION) + cli.dim(`  · ${source}`));
  console.log(cli.dim(`  IPs: ${ips.length}${r ? ` (${r} ranges)` : ""}`));
  if ((args.sl as number) > 0 && (args.tl as number) === 9999) {
    console.log(cli.yellow("  Tip: use -tl to cap latency and speed up when using -sl"));
  }
  console.log("");

  const progress = createOverallProgress("Latency", ips.length);
  let pingData = await runPing(ips, progress);
  pingData = sortByDelayAndLoss(pingData);
  pingData = filterDelay(pingData);
  pingData = filterLossRate(pingData);

  let speedData = await testDownloadSpeed(pingData, progress);
  speedData = sortBySpeed(speedData);

  const finalData = await testXrayForIps(speedData, progress);
  progress.done();

  exportCsv(finalData);
  printResults(finalData);

  const versionNew = await checkUpdate();
  if (versionNew) {
    console.log(cli.yellow("  Update available: " + versionNew));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
