#!/usr/bin/env node

import {
  setIPOptions,
  loadIPRanges,
  ipFile,
  ipText,
  lastLoadedRanges,
} from "./ip";
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
import { ipToCidr24 } from "./ip";
import { fetchCloudflareRanges, formatRangesForFile } from "./fetch";
import { probeRanges } from "./probe";
import { parseRangesFromContent, loadIPsFromRanges } from "./ip";
import * as fs from "fs";
import * as path from "path";

const VERSION = "1.0.0";

const LONG_TO_SHORT: Record<string, string> = {
  help: "help",
  version: "version",
  threads: "n",
  pingtimes: "t",
  traceurl: "traceurl",
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
  discoverranges: "dr",
};

function parseArgs(): Record<string, string | number | boolean> {
  const args: Record<string, string | number | boolean> = {};
  const argv = process.argv.slice(2);
  const numericKeys = [
    "n",
    "t",
    "dn",
    "dt",
    "tp",
    "tl",
    "tll",
    "p",
    "httpingcode",
    "xraytimeout",
    "xrayn",
  ];
  const floatKeys = ["tlr", "sl"];
  const flagKeys = [
    "httping",
    "dd",
    "allip",
    "skiptrace",
    "discover",
    "fetch",
    "extended",
    "probe",
  ];

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
    -n, --threads <N>     Latency threads (default: 50, max: 1000)
    -t, --ping-times <N>  Pings per IP (default: 1)
    -tp, --port <N>       Test port (default: 443)
    -url <url>            Test URL (default: speed.cloudflare.com)
    -traceurl <url>       Trace URL for clean IP check (default: www.cloudflare.com/cdn-cgi/trace)
    -skiptrace            Skip trace check (faster, less accurate)
    -httping              Use HTTP instead of TCP for latency
    -cfcolo <codes>       Match region, e.g. HKG,KHH (HTTP only)

  SPEED
    -dn, --download-n <N> How many IPs to speed-test (default: 10)
    -dt, --download-sec   Seconds per speed test (default: 20)
    -dd                   Skip speed test (latency only)
    -sl <N>               Min speed MB/s (filter)

  FILTERS
    -tl, --max-delay <ms>   Max avg latency (default: 9999)
    -tll, --min-delay <ms>  Min avg latency (default: 0)
    -tlr, --max-loss <0-1>  Max packet loss (default: 1)

  INPUT / OUTPUT
    -f, --file <path>     IP list file (default: ip.txt)
    -ip <ranges>          IPs from CLI, e.g. 1.1.1.1,2.2.2.2/24
    -seed <ip>            Scan /24 around working IP (e.g. 135.84.76.19)
    -fetch                Fetch valid Cloudflare IP ranges → ip.txt
    -extended             With -fetch: include 135.84.x.x (Xray working)
    -probe                Check which ranges are unblocked (for Iran etc.) before scan/fetch
    -discover             Find working ranges from scan → write /24 blocks to -dr file
    -dr, --discover-ranges <path>  Output working ranges (default: working-ranges.txt)
    -o, --output <path>   CSV output (default: result.csv, "" = none)
    -p, --print <N>       Show top N results (default: 10, 0 = none)
    -allip                Test every IP in range (IPv4, slower)

  XRAY (required for working Address)
    -xray <path>          Config JSON; validates IPs via proxy (only these work!)
    -xraybin <path>       Xray binary (default: xray)
    -xrayurl <url>        URL to test via proxy
    -xraytimeout <sec>    Timeout per IP (default: 5)
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

  if (args.fetch) {
    const outPath = (args.f as string) || "ip.txt";
    const includeExtended = !!args.extended;
    const doProbe = !!args.probe;
    const tcpPort = (args.tp as number) || 443;
    console.log("");
    console.log(cli.bold("  Fetching valid Cloudflare IP ranges..."));
    try {
      const { ipv4, ipv6 } = await fetchCloudflareRanges();
      let ranges = [...ipv4, ...ipv6];
      if (includeExtended) ranges.push("135.84.0.0/16");

      if (doProbe) {
        console.log(cli.cyan("  Probing ranges (checking which are unblocked)..."));
        ranges = await probeRanges(ranges, tcpPort, (cur, tot, cidr, ok) => {
          const status = ok ? cli.green("✓") : cli.dim("✗");
          process.stdout.write(`\r  ${cur}/${tot} ${status} ${cidr}    `);
        });
        process.stdout.write("\r" + " ".repeat(60) + "\r");
        console.log(cli.green(`  Unblocked: ${ranges.length} ranges`));
      }

      const content = [
        "# Cloudflare IP ranges" + (doProbe ? " (unblocked)" : ""),
        "# " + new Date().toISOString().slice(0, 10),
        "",
        ...ranges,
      ].join("\n") + "\n";
      fs.writeFileSync(outPath, content, "utf-8");
      console.log(cli.green(`  Saved: ${outPath}`));
      console.log("");
    } catch (err) {
      console.error(cli.yellow("  Fetch failed:"), err);
      process.exit(1);
    }
    process.exit(0);
  }

  setIPOptions({
    testAll: !!args.allip,
    ipFile: (args.f as string) || "ip.txt",
    ipText: (args.ip as string) || "",
    seedIp: (args.seed as string) || "",
  });
  setUtilsOptions({
    inputMaxDelayMs: (args.tl as number) || 9999,
    inputMinDelayMs: (args.tll as number) || 0,
    inputMaxLossRate: (args.tlr as number) ?? 1,
    output: (args.o as string) ?? "result.csv",
    printNum: (args.p as number) ?? 10,
  });
  setPingOptions({
    routines: (args.n as number) || 50,
    pingTimes: (args.t as number) || 1,
    tcpPort: (args.tp as number) || 443,
    url: (args.url as string) || "https://speed.cloudflare.com/__down",
    traceUrl:
      (args.traceurl as string) || "https://www.cloudflare.com/cdn-cgi/trace",
    skipTrace: !!args.skiptrace,
    httping: !!args.httping,
    httpingStatusCode: (args.httpingcode as number) || 0,
    httpingCFColo: (args.cfcolo as string) || "",
  });
  setDownloadOptions({
    url: (args.url as string) || "https://speed.cloudflare.com/__down",
    timeoutSec: (args.dt as number) || 20,
    disable: !!args.dd,
    testCount: (args.dn as number) || 10,
    minSpeed: (args.sl as number) || 0,
  });
  const xrayPath = args.xray as string;
  setXrayOptions({
    configPath: xrayPath || "",
    bin: (args.xraybin as string) || "xray",
    testUrl:
      (args.xrayurl as string) || "https://www.cloudflare.com/cdn-cgi/trace",
    timeoutSec: (args.xraytimeout as number) || 5,
    maxCount: (args.xrayn as number) ?? (xrayPath ? 50 : 0),
  });

  const source = (args.ip as string)
    ? "CLI"
    : (args.seed as string)
    ? "seed"
    : ipFile || "ip.txt";

  let ips: string[];
  const doProbe = !!args.probe;
  const tcpPort = (args.tp as number) || 443;

  if (doProbe && !(args.ip as string)) {
    let cidrs: string[] = [];
    const seed = (args.seed as string) || "";
    if (seed) {
      const cidr24 = ipToCidr24(seed.trim());
      if (cidr24) cidrs.push(cidr24);
    }
    const filePath = path.resolve(ipFile || "ip.txt");
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      cidrs = [...cidrs, ...parseRangesFromContent(content)];
    }
    if (cidrs.length === 0) {
      console.error(cli.dim("No valid ranges in file."));
      process.exit(1);
    }
    console.log("");
    console.log(cli.cyan("  Probing ranges (checking which are unblocked)..."));
    const unblocked = await probeRanges(cidrs, tcpPort, (cur, tot, cidr, ok) => {
      const status = ok ? cli.green("✓") : cli.dim("✗");
      process.stdout.write(`\r  ${cur}/${tot} ${status} ${cidr}    `);
    });
    process.stdout.write("\r" + " ".repeat(70) + "\r");
    console.log(cli.green(`  Unblocked: ${unblocked.length}/${cidrs.length} ranges`));
    if (unblocked.length === 0) {
      console.error(cli.yellow("  All ranges blocked. Try -fetch -probe -extended to get fresh ranges."));
      process.exit(1);
    }
    ips = loadIPsFromRanges(unblocked);
  } else {
    ips = loadIPRanges();
  }

  if (ips.length === 0) {
    console.error(cli.dim("No IPs. Use -f <file> or -ip <ranges>."));
    process.exit(1);
  }
  const r = lastLoadedRanges.length;

  console.log("");
  console.log(
    cli.bold("  CloudflareScanner " + VERSION) + cli.dim(`  · ${source}`)
  );
  console.log(cli.dim(`  IPs: ${ips.length}${r ? ` (${r} ranges)` : ""}`));
  if (xrayPath) {
    console.log(
      cli.cyan(
        "  Xray: validating via proxy - only working Address will be output"
      )
    );
  }
  if ((args.sl as number) > 0 && (args.tl as number) === 9999) {
    console.log(
      cli.yellow("  Tip: use -tl to cap latency and speed up when using -sl")
    );
  }
  console.log("");

  const progress = createOverallProgress("Latency", ips.length);
  let pingData = await runPing(ips, progress);
  pingData = sortByDelayAndLoss(pingData);
  pingData = filterDelay(pingData);
  pingData = filterLossRate(pingData);

  const useXray = !!(args.xray as string);
  let speedData = await testDownloadSpeed(pingData, progress);
  speedData = sortBySpeed(speedData);

  const hasRealSpeed = speedData.some((d) => d.downloadSpeed > 0);
  if (!hasRealSpeed && speedData.length > 0 && !args.dd) {
    console.log(
      cli.yellow(
        "  Note: Speed test returned 0 for all IPs. Use -dd to skip speed test."
      )
    );
  }
  const finalData = hasRealSpeed
    ? speedData.filter((d) => d.downloadSpeed > 0)
    : speedData;

  const xrayInput = useXray ? pingData.slice(0, 50) : finalData;
  const outputData = await testXrayForIps(xrayInput, progress);
  progress.done();

  exportCsv(outputData);
  printResults(outputData);

  if (args.discover) {
    const workingIps =
      outputData.length > 0 ? outputData : pingData.slice(0, 100);
    const ranges = new Set<string>();
    for (const d of workingIps) {
      const cidr = ipToCidr24(d.ip);
      if (cidr) ranges.add(cidr);
    }
    const rangeList = [...ranges].sort();
    const drPath = (args.dr as string) || "working-ranges.txt";
    const header =
      [
        "# Working IP ranges (discovered from scan)",
        "# Add these to ip.txt for better results",
        "",
        ...rangeList,
      ].join("\n") + "\n";
    fs.writeFileSync(drPath, header, "utf-8");
    console.log(
      cli.green(`  Discovered ${rangeList.length} working ranges → ${drPath}`)
    );
    console.log(cli.dim("  Add these to ip.txt for future scans"));
    console.log("");
  }

  const versionNew = await checkUpdate();
  if (versionNew) {
    console.log(cli.yellow("  Update available: " + versionNew));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
