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

function parseArgs(): Record<string, string | number | boolean> {
  const args: Record<string, string | number | boolean> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      args["help"] = true;
      continue;
    }
    if (a === "-v" || a === "--version") {
      args["version"] = true;
      continue;
    }
    if (a.startsWith("-")) {
      const key = a.replace(/^-+/, "").replace(/-/g, "");
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        if (
          [
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
          ].includes(key)
        ) {
          args[key] = parseInt(next, 10) || 0;
        } else if (["tlr", "sl"].includes(key)) {
          args[key] = parseFloat(next) || 0;
        } else {
          args[key] = next;
        }
        i++;
      } else if (["httping", "dd", "allip"].includes(key)) {
        args[key] = true;
      }
    }
  }
  return args;
}

const HELP = `
CloudflareScanner ${VERSION}
Test the latency and speed of all IP addresses of Cloudflare CDN, and get the fastest IP (IPv4+IPv6)!
https://github.com/Ptechgithub/CloudflareScanner

Options:
  -n 10        Latency test threads (default 10, max 1000)
  -t 4         Latency test times per IP (default 4)
  -dn 10       Download test count (default 10)
  -dt 10       Download test time per IP in seconds (default 10)
  -tp 443      Test port (default 443)
  -url <url>   Test URL for latency/download (default speed.cloudflare.com)

  -httping     Use HTTP mode for latency (default TCP)
  -httping-code 200   Valid HTTP status (default 200,301,302)
  -cfcolo HKG,KHH,... Match region (HTTPing only)

  -tl 200      Max average latency ms (default 9999)
  -tll 40      Min average latency ms (default 0)
  -tlr 0.2     Max loss rate 0-1 (default 1)
  -sl 5        Min download speed MB/s (default 0)

  -p 10        Display result count (default 10, 0=no print)
  -f ip.txt    IP range file (default ip.txt)
  -ip 1.1.1.1,2.2.2.2/24   IP ranges from CLI
  -o result.csv   Output CSV (default result.csv, ""=no file)

  -dd          Disable download test (sort by latency only)
  -allip       Test all IPs in range (IPv4 only, default: one per /24)

  -xray <file>    Xray config JSON for validation
  -xraybin <path> Xray binary (default: xray)
  -xrayurl <url>  Test URL via proxy (default: https://www.cloudflare.com/cdn-cgi/trace)
  -xraytimeout 10 Timeout seconds for xray test (default 10)
  -xrayn 0        Max IPs to test with xray (0 = all)

  -v           Print version
  -h           Print help
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
    console.log(VERSION);
    console.log("Checking for updates...");
    const v = await checkUpdate();
    if (v) console.log(`*** Found new version [${v}]! Please update. ***`);
    else console.log(`Current version is the latest [${VERSION}]!`);
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

  if ((args.sl as number) > 0 && (args.tl as number) === 9999) {
    console.log("[Tip] When using [-sl], consider using [-tl] to avoid long testing...");
  }

  const source = ipText ? "CLI" : ipFile || "ip.txt";
  console.log(cli.dim(`CloudflareScanner ${VERSION}  ${source}`));
  const ips = loadIPRanges();
  if (ips.length === 0) {
    console.error("No IPs. Use -f <file> or -ip <ranges>.");
    process.exit(1);
  }
  const r = lastLoadedRanges.length;
  console.log(cli.dim(`${ips.length} IPs${r ? ` (${r} ranges)` : ""}\n`));

  console.log(cli.dim("1/3 Latency → 2/3 Speed → 3/3 Xray (if enabled)\n"));

  const progress = createOverallProgress("Scan", ips.length);
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
    console.log(cli.dim(`\nNew version ${versionNew} available.`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
