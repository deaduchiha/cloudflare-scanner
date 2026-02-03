#!/usr/bin/env node

/**
 * High-performance scanner for large subnet files.
 *
 * ALGORITHM:
 * 1. Fetch official Cloudflare ranges and build a sorted numeric interval tree
 * 2. Stream through the input file line-by-line (memory efficient for 335k+ lines)
 * 3. Use binary search to check if each subnet overlaps with Cloudflare ranges
 * 4. Scan filtered subnets with high concurrency using worker pool
 * 5. Output clean/working subnets sorted by latency
 */

import * as fs from "fs";
import * as readline from "readline";
import * as net from "net";
import * as tls from "tls";
import IpCidr from "ip-cidr";
import { cli } from "./utils";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Scanning
  CONCURRENCY: 100, // High concurrency for speed
  SAMPLES_PER_RANGE: 3, // IPs to test per subnet
  TIMEOUT_MS: 6000, // Connection timeout (slower networks)
  MIN_SUCCESS_RATE: 0.5, // 50% must pass
  MAX_AVG_LATENCY: 3000, // Max acceptable latency (ms)

  // Input/Output
  INPUT_FILE: "subnets.txt",
  OUTPUT_FILE: "clean-ips.txt",
  CLOUDFLARE_OUTPUT: "cloudflare-subnets.txt",

  // Cloudflare URLs
  CF_IPV4_URL: "https://www.cloudflare.com/ips-v4",
  CF_IPV6_URL: "https://www.cloudflare.com/ips-v6",

  // Probe URL: where to test connectivity (default: biatid.ir)
  // Use PROBE_URL env or --probe-url to override
  PROBE_URL: "https://biatid.ir/pull/",
};

// ═══════════════════════════════════════════════════════════════════════════
// IP UTILITIES - Numeric conversion for fast comparison
// ═══════════════════════════════════════════════════════════════════════════

/** Convert IPv4 to 32-bit unsigned integer */
function ipv4ToNum(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

/** Convert number back to IPv4 string */
function numToIpv4(n: number): string {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ].join(".");
}

/** Get start and end numeric IPs from CIDR */
function cidrToRange(cidr: string): { start: number; end: number } | null {
  try {
    const c = new IpCidr(cidr.trim());
    const startIp = c.start() as string;
    const endIp = c.end() as string;
    if (!startIp || !startIp.includes(".")) return null; // IPv4 only for now
    return {
      start: ipv4ToNum(startIp),
      end: ipv4ToNum(endIp),
    };
  } catch {
    return null;
  }
}

/** Exclude catch-all subnets that overlap everything (0.0.0.0/0, ::/0) */
function isCatchAllSubnet(cidr: string): boolean {
  const trimmed = cidr.trim();
  return trimmed === "0.0.0.0/0" || trimmed === "::/0";
}

/** Extract CIDR from line (handles prefixes like "L1:192.168.0.0/24") */
function extractCidr(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const v4 = trimmed.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2})/);
  if (v4) return v4[1];
  const v6 = trimmed.match(/([0-9a-fA-F:]+(?::[0-9a-fA-F:]+)*\/\d{1,3})/);
  if (v6) return v6[1];
  if (trimmed.includes("/")) return trimmed;
  return null;
}

/** Check if two ranges overlap */
function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number }
): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** Check if range A is fully contained within range B */
function rangeContainedIn(
  inner: { start: number; end: number },
  outer: { start: number; end: number }
): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLOUDFLARE RANGE MATCHER - Binary search for O(log n) lookups
// ═══════════════════════════════════════════════════════════════════════════

interface NumericRange {
  start: number;
  end: number;
  cidr: string;
}

class CloudflareRangeMatcher {
  private ranges: NumericRange[] = [];

  constructor(cloudflareRanges: string[]) {
    // Convert all Cloudflare ranges to numeric and sort by start
    for (const cidr of cloudflareRanges) {
      const range = cidrToRange(cidr);
      if (range) {
        this.ranges.push({ ...range, cidr });
      }
    }
    // Sort by start IP for binary search
    this.ranges.sort((a, b) => a.start - b.start);
  }

  /** Check if a subnet overlaps with any Cloudflare range - O(log n) */
  overlapsCloudflare(cidr: string): boolean {
    const target = cidrToRange(cidr);
    if (!target) return false;

    // Binary search to find potential overlapping ranges
    let left = 0;
    let right = this.ranges.length - 1;

    // Find the first range that could possibly overlap
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.ranges[mid].end < target.start) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    // Check ranges starting from the found position
    for (let i = left; i < this.ranges.length; i++) {
      const cfRange = this.ranges[i];
      if (cfRange.start > target.end) break; // No more possible overlaps
      if (rangesOverlap(target, cfRange)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a subnet is FULLY CONTAINED within any Cloudflare range.
   * Stricter than overlap: excludes 0.0.0.0/0 and partial overlaps.
   */
  containedInCloudflare(cidr: string): boolean {
    const target = cidrToRange(cidr);
    if (!target) return false;

    // Skip catch-all subnets (0.0.0.0/0, ::/0) - never meaningful
    if (target.start === 0 && target.end === 0xffffffff) return false;

    // Binary search to find potential containing ranges
    let left = 0;
    let right = this.ranges.length - 1;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.ranges[mid].end < target.start) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    for (let i = left; i < this.ranges.length; i++) {
      const cfRange = this.ranges[i];
      if (cfRange.start > target.end) break;
      if (rangeContainedIn(target, cfRange)) {
        return true;
      }
    }

    return false;
  }

  /** Get the matching Cloudflare range if overlaps */
  getMatchingRange(cidr: string): string | null {
    const target = cidrToRange(cidr);
    if (!target) return null;

    for (const cfRange of this.ranges) {
      if (rangesOverlap(target, cfRange)) {
        return cfRange.cidr;
      }
    }
    return null;
  }

  get count(): number {
    return this.ranges.length;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE STREAMING - Memory efficient for 335k+ lines
// ═══════════════════════════════════════════════════════════════════════════

async function streamSubnets(
  filePath: string,
  matcher: CloudflareRangeMatcher,
  onProgress: (processed: number, found: number) => void
): Promise<string[]> {
  const cloudflareSubnets: string[] = [];
  let processed = 0;

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        processed++;
        return;
      }

      const cidr = extractCidr(trimmed) || trimmed;
      // Check if this subnet overlaps with Cloudflare ranges (includes partial overlaps)
      // Exclude 0.0.0.0/0 explicitly - it overlaps everything but is meaningless to scan
      if (matcher.overlapsCloudflare(cidr) && !isCatchAllSubnet(cidr)) {
        cloudflareSubnets.push(cidr);
      }

      processed++;
      if (processed % 10000 === 0) {
        onProgress(processed, cloudflareSubnets.length);
      }
    });

    rl.on("close", () => {
      onProgress(processed, cloudflareSubnets.length);
      resolve(cloudflareSubnets);
    });

    rl.on("error", reject);
    stream.on("error", reject);
  });
}

/** Read ALL subnets from file (no Cloudflare filter). Use --all when you trust your list. */
async function streamAllSubnets(
  filePath: string,
  onProgress: (processed: number) => void
): Promise<string[]> {
  const subnets: string[] = [];
  let processed = 0;

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        processed++;
        return;
      }
      const cidr = extractCidr(trimmed) || trimmed;
      if (!isCatchAllSubnet(cidr)) {
        subnets.push(cidr);
      }
      processed++;
      if (processed % 10000 === 0) onProgress(processed);
    });

    rl.on("close", () => {
      onProgress(processed);
      resolve(subnets);
    });

    rl.on("error", reject);
    stream.on("error", reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PROBE CONFIG - Custom URL support (like curl --resolve)
// ═══════════════════════════════════════════════════════════════════════════

interface ProbeConfig {
  host: string;
  path: string;
  port: number;
  isTraceEndpoint: boolean; // true = check colo=/ip=, false = check HTTP 2xx
}

function parseProbeUrl(url: string): ProbeConfig {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  const u = new URL(url);
  const port = u.port
    ? parseInt(u.port, 10)
    : u.protocol === "https:"
    ? 443
    : 80;
  const path = u.pathname || "/";
  const isTraceEndpoint =
    u.hostname === "www.cloudflare.com" && path.includes("/cdn-cgi/trace");
  return {
    host: u.hostname,
    path: path + (u.search || ""),
    port,
    isTraceEndpoint,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONNECTIVITY PROBE (connect to IP, request URL - like curl --resolve)
// ═══════════════════════════════════════════════════════════════════════════

function runHttpRequest(
  socket: net.Socket | tls.TLSSocket,
  probe: ProbeConfig,
  data: { buf: string },
  timeout: ReturnType<typeof setTimeout>,
  done: (ok: boolean) => void
): void {
  const request = [
    `GET ${probe.path} HTTP/1.1`,
    `Host: ${probe.host}`,
    "Connection: close",
    "User-Agent: Mozilla/5.0",
    "",
    "",
  ].join("\r\n");

  socket.write(request);

  socket.on("data", (chunk) => {
    data.buf += chunk.toString();
    if (probe.isTraceEndpoint) {
      if (data.buf.includes("colo=") && data.buf.includes("ip=")) {
        clearTimeout(timeout);
        socket.destroy();
        done(true);
      }
    } else {
      const match = data.buf.match(/HTTP\/\d\.\d\s+(\d{3})/);
      if (match) {
        const code = parseInt(match[1], 10);
        clearTimeout(timeout);
        socket.destroy();
        // Accept any HTTP response (100-599 = IP reached the URL)
        done(code >= 100 && code < 600);
      }
    }
  });

  socket.on("end", () => {
    clearTimeout(timeout);
    if (probe.isTraceEndpoint) {
      done(data.buf.includes("colo=") && data.buf.includes("ip="));
    } else {
      const match = data.buf.match(/HTTP\/\d\.\d\s+(\d{3})/);
      // Accept any HTTP response (100-599 = IP reached the URL)
      done(
        match
          ? parseInt(match[1], 10) >= 100 && parseInt(match[1], 10) < 600
          : false
      );
    }
  });

  socket.on("error", () => {
    clearTimeout(timeout);
    done(false);
  });
}

/** For --verbose: probe and return raw response for debugging */
async function probeWithRawResponse(
  ip: string,
  probe: ProbeConfig
): Promise<{ ok: boolean; raw: string }> {
  return new Promise((resolve) => {
    const data = { buf: "" };
    const timeout = setTimeout(
      () => resolve({ ok: false, raw: data.buf }),
      CONFIG.TIMEOUT_MS
    );

    const done = (ok: boolean) => {
      clearTimeout(timeout);
      resolve({ ok, raw: data.buf });
    };

    const socket = net.connect(probe.port, ip, () => {
      if (probe.port === 443) {
        const tlsSocket = tls.connect(
          { socket, servername: probe.host, rejectUnauthorized: false },
          () => {
            tlsSocket.write(
              `GET ${probe.path} HTTP/1.1\r\nHost: ${probe.host}\r\nConnection: close\r\n\r\n`
            );
            tlsSocket.on("data", (c) => (data.buf += c.toString()));
            tlsSocket.on("end", () =>
              done(
                probe.isTraceEndpoint
                  ? data.buf.includes("colo=") && data.buf.includes("ip=")
                  : /HTTP\/\d\.\d\s+[1-5]\d{2}/.test(data.buf)
              )
            );
            tlsSocket.on("error", () => done(false));
          }
        );
        tlsSocket.on("error", () => done(false));
      } else {
        socket.write(
          `GET ${probe.path} HTTP/1.1\r\nHost: ${probe.host}\r\nConnection: close\r\n\r\n`
        );
        socket.on("data", (c) => (data.buf += c.toString()));
        socket.on("end", () =>
          done(/HTTP\/\d\.\d\s+([2345]\d{2})/.test(data.buf))
        );
        socket.on("error", () => done(false));
      }
    });
    socket.on("error", () => done(false));
    socket.setTimeout(CONFIG.TIMEOUT_MS, () => done(false));
  });
}

function checkProbe(
  ip: string,
  probe: ProbeConfig
): Promise<{ ok: boolean; latencyMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let resolved = false;
    const data = { buf: "" };

    const done = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve({ ok, latencyMs: Date.now() - start });
    };

    const timeout = setTimeout(() => done(false), CONFIG.TIMEOUT_MS);

    const socket = net.connect(probe.port, ip, () => {
      if (probe.port === 443) {
        const tlsSocket = tls.connect(
          {
            socket,
            servername: probe.host,
            rejectUnauthorized: false,
          },
          () => runHttpRequest(tlsSocket, probe, data, timeout, done)
        );
        tlsSocket.on("error", () => {
          clearTimeout(timeout);
          done(false);
        });
      } else {
        runHttpRequest(socket, probe, data, timeout, done);
      }
    });

    socket.on("error", () => {
      clearTimeout(timeout);
      done(false);
    });

    socket.setTimeout(CONFIG.TIMEOUT_MS, () => {
      clearTimeout(timeout);
      socket.destroy();
      done(false);
    });
  });
}

/** Get random IPs from a CIDR range */
function getRandomIps(cidr: string, count: number): string[] {
  const range = cidrToRange(cidr);
  if (!range) return [];

  const { start, end } = range;
  const rangeSize = end - start + 1;
  const ips: string[] = [];
  const seen = new Set<number>();

  const actualCount = Math.min(count, rangeSize);
  for (let i = 0; i < actualCount && seen.size < rangeSize; i++) {
    const offset = Math.floor(Math.random() * rangeSize);
    const ipNum = start + offset;
    if (!seen.has(ipNum)) {
      seen.add(ipNum);
      ips.push(numToIpv4(ipNum));
    }
  }

  return ips;
}

// ═══════════════════════════════════════════════════════════════════════════
// HIGH-CONCURRENCY SCANNER
// ═══════════════════════════════════════════════════════════════════════════

interface ScanResult {
  cidr: string;
  successRate: number;
  avgLatency: number;
  passed: boolean;
}

let PROBE_CONFIG: ProbeConfig;

async function scanSubnet(cidr: string): Promise<ScanResult> {
  const ips = getRandomIps(cidr, CONFIG.SAMPLES_PER_RANGE);
  if (ips.length === 0) {
    return { cidr, successRate: 0, avgLatency: 0, passed: false };
  }

  const results = await Promise.all(
    ips.map((ip) => checkProbe(ip, PROBE_CONFIG))
  );
  const successes = results.filter((r) => r.ok);
  const successRate = successes.length / results.length;

  if (successes.length === 0) {
    return { cidr, successRate: 0, avgLatency: 0, passed: false };
  }

  const avgLatency =
    successes.reduce((sum, r) => sum + r.latencyMs, 0) / successes.length;
  const passed =
    successRate >= CONFIG.MIN_SUCCESS_RATE &&
    avgLatency <= CONFIG.MAX_AVG_LATENCY;

  return { cidr, successRate, avgLatency, passed };
}

async function scanAllSubnets(
  subnets: string[],
  onProgress: (
    done: number,
    total: number,
    current: string,
    passed: boolean
  ) => void,
  onClean?: (result: ScanResult) => void
): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  let index = 0;
  let done = 0;

  const worker = async () => {
    while (index < subnets.length) {
      const i = index++;
      const cidr = subnets[i];
      const result = await scanSubnet(cidr);
      results.push(result);
      done++;
      if (result.passed) onClean?.(result);
      onProgress(done, subnets.length, cidr, result.passed);
    }
  };

  // Create worker pool
  const workers = Array.from({ length: CONFIG.CONCURRENCY }, () => worker());
  await Promise.all(workers);

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROGRESS DISPLAY
// ═══════════════════════════════════════════════════════════════════════════

function progressBar(current: number, total: number, width = 30): string {
  if (total <= 0) return "░".repeat(width);
  const p = Math.min(1, current / total);
  const filled = Math.round(width * p);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs(): {
  inputFile: string;
  probeUrl: string;
  verbose: boolean;
  all: boolean;
} {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const all = args.includes("--all") || args.includes("-a");
  const probeIdx = args.findIndex((a) => a === "--probe-url" || a === "-u");
  const probeUrl =
    probeIdx >= 0 && args[probeIdx + 1]
      ? args[probeIdx + 1]
      : process.env.PROBE_URL || CONFIG.PROBE_URL;
  const fileArgs = args.filter(
    (a) =>
      a !== "--verbose" &&
      a !== "-v" &&
      a !== "--all" &&
      a !== "-a" &&
      a !== "--probe-url" &&
      a !== "-u" &&
      (probeIdx < 0 || a !== args[probeIdx + 1])
  );
  const inputFile =
    fileArgs.find((a) => !a.startsWith("-")) || CONFIG.INPUT_FILE;
  return { inputFile, probeUrl, verbose, all };
}

async function main(): Promise<void> {
  console.log("");
  console.log(
    cli.bold("  ╔══════════════════════════════════════════════════════════╗")
  );
  console.log(
    cli.bold("  ║     Cloudflare Clean IP Scanner - Large File Mode       ║")
  );
  console.log(
    cli.bold("  ╚══════════════════════════════════════════════════════════╝")
  );
  console.log("");

  const { inputFile, probeUrl, verbose, all } = parseArgs();
  PROBE_CONFIG = parseProbeUrl(probeUrl);

  if (!fs.existsSync(inputFile)) {
    console.error(cli.yellow(`  File not found: ${inputFile}`));
    process.exit(1);
  }

  const stats = fs.statSync(inputFile);
  const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(cli.cyan(`  Input file: ${inputFile} (${fileSizeMB} MB)`));
  if (all) {
    console.log(
      cli.yellow("  Mode: --all (no Cloudflare filter, probe every subnet)")
    );
  }
  if (!PROBE_CONFIG.isTraceEndpoint) {
    console.log(cli.cyan(`  Probe URL:  ${probeUrl} (any HTTP response)`));
  }
  console.log("");

  let uniqueSubnets: string[];

  if (all) {
    // ─────────────────────────────────────────────────────────────────────
    // --all: Load ALL subnets, no Cloudflare filter
    // ─────────────────────────────────────────────────────────────────────
    console.log(cli.cyan("  [1/2] Loading subnets (no filter)..."));

    const startLoad = Date.now();
    uniqueSubnets = await streamAllSubnets(inputFile, (processed) => {
      if (processed % 10000 === 0) {
        process.stdout.write(`\r  ${processed.toLocaleString()} lines...`);
      }
    });
    process.stdout.write("\r" + " ".repeat(40) + "\r");

    uniqueSubnets = [...new Set(uniqueSubnets)];
    const loadTime = ((Date.now() - startLoad) / 1000).toFixed(1);
    console.log(
      cli.green(
        `  Loaded ${uniqueSubnets.length.toLocaleString()} subnets in ${loadTime}s`
      )
    );
    console.log("");
  } else {
    // ─────────────────────────────────────────────────────────────────────
    // Default: Fetch Cloudflare ranges and filter
    // ─────────────────────────────────────────────────────────────────────
    console.log(cli.cyan("  [1/4] Fetching official Cloudflare IP ranges..."));

    let cfRanges: string[];
    try {
      const [v4Res, v6Res] = await Promise.all([
        fetch(CONFIG.CF_IPV4_URL, { signal: AbortSignal.timeout(15000) }),
        fetch(CONFIG.CF_IPV6_URL, { signal: AbortSignal.timeout(15000) }),
      ]);

      const v4Text = await v4Res.text();
      const v6Text = await v6Res.text();

      cfRanges = [
        ...v4Text.split(/\r?\n/).filter((s) => s.trim() && !s.startsWith("#")),
        ...v6Text.split(/\r?\n/).filter((s) => s.trim() && !s.startsWith("#")),
      ];
    } catch {
      console.log(cli.yellow("  Failed to fetch, using built-in ranges..."));
      cfRanges = [
        "173.245.48.0/20",
        "103.21.244.0/22",
        "103.22.200.0/22",
        "103.31.4.0/22",
        "141.101.64.0/18",
        "108.162.192.0/18",
        "190.93.240.0/20",
        "188.114.96.0/20",
        "197.234.240.0/22",
        "198.41.128.0/17",
        "162.158.0.0/15",
        "104.16.0.0/13",
        "104.24.0.0/14",
        "172.64.0.0/13",
        "131.0.72.0/22",
      ];
    }

    const matcher = new CloudflareRangeMatcher(cfRanges);
    console.log(
      cli.green(`  Loaded ${matcher.count} official Cloudflare ranges`)
    );
    console.log("");

    console.log(cli.cyan("  [2/4] Scanning file for Cloudflare subnets..."));

    const startFilter = Date.now();
    const cloudflareSubnets = await streamSubnets(
      inputFile,
      matcher,
      (processed, found) => {
        const bar = progressBar(processed, 335325);
        process.stdout.write(
          `\r  ${bar} ${processed.toLocaleString()} processed, ${cli.green(
            found.toString()
          )} CF matches    `
        );
      }
    );
    process.stdout.write("\r" + " ".repeat(80) + "\r");

    const filterTime = ((Date.now() - startFilter) / 1000).toFixed(1);
    console.log(
      cli.green(
        `  Found ${cloudflareSubnets.length.toLocaleString()} Cloudflare subnets in ${filterTime}s`
      )
    );

    if (cloudflareSubnets.length === 0) {
      console.log(
        cli.yellow(
          "  No Cloudflare subnets found. Try --all to probe every subnet."
        )
      );
      process.exit(1);
    }

    fs.writeFileSync(
      CONFIG.CLOUDFLARE_OUTPUT,
      [
        "# Cloudflare subnets extracted from " + inputFile,
        "# " + new Date().toISOString().slice(0, 10),
        "# " + cloudflareSubnets.length + " subnets",
        "",
        ...cloudflareSubnets,
      ].join("\n") + "\n"
    );
    console.log(cli.dim(`  Saved to ${CONFIG.CLOUDFLARE_OUTPUT}`));
    console.log("");

    console.log(cli.cyan("  [3/4] Optimizing scan list..."));
    uniqueSubnets = [...new Set(cloudflareSubnets)];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Deduplicate done; verbose test and scan
  // ─────────────────────────────────────────────────────────────────────────

  // Verbose: test first IP and show response
  if (verbose && uniqueSubnets.length > 0) {
    const testIp = getRandomIps(uniqueSubnets[0], 1)[0];
    console.log(cli.cyan(`  [verbose] Testing ${testIp} → ${probeUrl}`));
    const { ok, raw } = await probeWithRawResponse(testIp, PROBE_CONFIG);
    console.log(cli.dim("  Response:"));
    console.log(
      cli.dim(raw.slice(0, 600) + (raw.length > 600 ? "\n  ..." : ""))
    );
    console.log(
      cli[ok ? "green" : "yellow"](`  Result: ${ok ? "OK" : "FAILED"}`)
    );
    console.log("");
  }
  console.log(cli.dim(`  ${uniqueSubnets.length} unique subnets to scan`));
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // Scan for clean IPs with high concurrency
  // ─────────────────────────────────────────────────────────────────────────
  const scanStep = all ? "[2/2]" : "[4/4]";
  console.log(
    cli.cyan(
      `  ${scanStep} Scanning ${uniqueSubnets.length} subnets (${CONFIG.CONCURRENCY} concurrent)...`
    )
  );

  // Init output files (append each clean subnet as found)
  const header =
    "# Clean Cloudflare IP subnets (saved as found)\n" +
    "# " +
    new Date().toISOString().slice(0, 10) +
    "\n\n# Format: subnet | avg_latency_ms | success_rate\n";
  fs.writeFileSync(CONFIG.OUTPUT_FILE, header);
  fs.writeFileSync("clean-ips-plain.txt", "");

  const startScan = Date.now();
  let passedCount = 0;

  const scanResults = await scanAllSubnets(
    uniqueSubnets,
    (done, total, current, passed) => {
      if (passed) passedCount++;
      const bar = progressBar(done, total);
      const status = passed ? cli.green("✓") : cli.dim("✗");
      process.stdout.write(
        `\r  ${bar} ${done}/${total} ${status} ${cli.green(
          passedCount.toString()
        )} clean    `
      );
    },
    (result) => {
      // Append immediately when subnet passes
      const line = `${result.cidr.padEnd(20)} # ${result.avgLatency
        .toFixed(0)
        .padStart(4)}ms  ${(result.successRate * 100).toFixed(0)}%\n`;
      fs.appendFileSync(CONFIG.OUTPUT_FILE, line);
      fs.appendFileSync("clean-ips-plain.txt", result.cidr + "\n");
    }
  );

  process.stdout.write("\r" + " ".repeat(80) + "\r");

  const scanTime = ((Date.now() - startScan) / 1000).toFixed(1);
  const cleanResults = scanResults
    .filter((r) => r.passed)
    .sort((a, b) => a.avgLatency - b.avgLatency);

  console.log(cli.green(`  Completed in ${scanTime}s`));
  console.log(
    cli.green(`  Clean subnets: ${cleanResults.length}/${uniqueSubnets.length}`)
  );
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // OUTPUT
  // ─────────────────────────────────────────────────────────────────────────
  if (cleanResults.length === 0) {
    console.log(cli.yellow("  No clean Cloudflare subnets found."));
    console.log(
      cli.yellow("  Your network may be blocking Cloudflare traffic.")
    );
    fs.writeFileSync(
      CONFIG.OUTPUT_FILE,
      "# No clean subnets found\n# " +
        new Date().toISOString().slice(0, 10) +
        "\n\n"
    );
    fs.writeFileSync("clean-ips-plain.txt", "");
    console.log(cli.dim("  ✓ Empty output written"));
    return;
  }

  // Update header with count (files already appended during scan)
  const content = fs.readFileSync(CONFIG.OUTPUT_FILE, "utf-8");
  fs.writeFileSync(
    CONFIG.OUTPUT_FILE,
    content.replace(
      "# Clean Cloudflare IP subnets (saved as found)",
      `# Clean Cloudflare IP subnets (saved as found)\n# ${cleanResults.length} subnets`
    )
  );

  console.log(
    cli.green(
      `  ✓ Saved ${cleanResults.length} clean subnets → ${CONFIG.OUTPUT_FILE}`
    )
  );
  console.log(cli.dim(`  ✓ Plain list → clean-ips-plain.txt`));
  console.log("");

  // Show top 10 fastest
  console.log(cli.bold("  Top 10 fastest clean subnets:"));
  cleanResults.slice(0, 10).forEach((r, i) => {
    console.log(
      cli.cyan(`  ${(i + 1).toString().padStart(2)}. `) +
        r.cidr.padEnd(20) +
        cli.green(` ${r.avgLatency.toFixed(0)}ms`)
    );
  });
  console.log("");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
