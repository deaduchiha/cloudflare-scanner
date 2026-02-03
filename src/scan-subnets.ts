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
  TIMEOUT_MS: 4000, // Connection timeout
  MIN_SUCCESS_RATE: 0.5, // 50% must pass
  MAX_AVG_LATENCY: 3000, // Max acceptable latency (ms)

  // Input/Output
  INPUT_FILE: "subnets.txt",
  OUTPUT_FILE: "clean-ips.txt",
  CLOUDFLARE_OUTPUT: "cloudflare-subnets.txt",

  // Cloudflare URLs
  CF_IPV4_URL: "https://www.cloudflare.com/ips-v4",
  CF_IPV6_URL: "https://www.cloudflare.com/ips-v6",
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

      // Check if this subnet is fully contained within Cloudflare ranges
      // (stricter than overlap - excludes 0.0.0.0/0 and partial overlaps)
      if (matcher.containedInCloudflare(trimmed)) {
        cloudflareSubnets.push(trimmed);
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

// ═══════════════════════════════════════════════════════════════════════════
// CLOUDFLARE TRACE VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════

function checkCloudflareTrace(
  ip: string
): Promise<{ ok: boolean; latencyMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let resolved = false;

    const done = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve({ ok, latencyMs: Date.now() - start });
    };

    const timeout = setTimeout(() => done(false), CONFIG.TIMEOUT_MS);

    const socket = net.connect(443, ip, () => {
      const tlsSocket = tls.connect(
        {
          socket,
          servername: "www.cloudflare.com",
          rejectUnauthorized: false,
        },
        () => {
          const request = [
            "GET /cdn-cgi/trace HTTP/1.1",
            "Host: www.cloudflare.com",
            "Connection: close",
            "User-Agent: Mozilla/5.0",
            "",
            "",
          ].join("\r\n");

          tlsSocket.write(request);

          let data = "";
          tlsSocket.on("data", (chunk) => {
            data += chunk.toString();
            if (data.includes("colo=") && data.includes("ip=")) {
              clearTimeout(timeout);
              tlsSocket.destroy();
              done(true);
            }
          });

          tlsSocket.on("end", () => {
            clearTimeout(timeout);
            done(data.includes("colo=") && data.includes("ip="));
          });

          tlsSocket.on("error", () => {
            clearTimeout(timeout);
            done(false);
          });
        }
      );

      tlsSocket.on("error", () => {
        clearTimeout(timeout);
        done(false);
      });
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

async function scanSubnet(cidr: string): Promise<ScanResult> {
  const ips = getRandomIps(cidr, CONFIG.SAMPLES_PER_RANGE);
  if (ips.length === 0) {
    return { cidr, successRate: 0, avgLatency: 0, passed: false };
  }

  const results = await Promise.all(ips.map((ip) => checkCloudflareTrace(ip)));
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
  ) => void
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

  const inputFile = process.argv[2] || CONFIG.INPUT_FILE;

  if (!fs.existsSync(inputFile)) {
    console.error(cli.yellow(`  File not found: ${inputFile}`));
    process.exit(1);
  }

  const stats = fs.statSync(inputFile);
  const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(cli.cyan(`  Input file: ${inputFile} (${fileSizeMB} MB)`));
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1: Fetch official Cloudflare ranges
  // ─────────────────────────────────────────────────────────────────────────
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
    // Fallback to known Cloudflare ranges if fetch fails
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

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2: Stream through subnets file and filter Cloudflare matches
  // ─────────────────────────────────────────────────────────────────────────
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
    console.log(cli.yellow("  No Cloudflare subnets found in the input file."));
    process.exit(1);
  }

  // Save filtered Cloudflare subnets
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

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 3: Deduplicate and optimize scan list
  // ─────────────────────────────────────────────────────────────────────────
  console.log(cli.cyan("  [3/4] Optimizing scan list..."));

  // Remove duplicates
  const uniqueSubnets = [...new Set(cloudflareSubnets)];
  console.log(cli.dim(`  ${uniqueSubnets.length} unique subnets to scan`));
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 4: Scan for clean IPs with high concurrency
  // ─────────────────────────────────────────────────────────────────────────
  console.log(
    cli.cyan(
      `  [4/4] Scanning ${uniqueSubnets.length} subnets (${CONFIG.CONCURRENCY} concurrent)...`
    )
  );

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
    process.exit(1);
  }

  // Save clean IPs sorted by latency
  const output =
    [
      "# Clean Cloudflare IP subnets (sorted by latency, best first)",
      "# " + new Date().toISOString().slice(0, 10),
      "# " + cleanResults.length + " subnets",
      "",
      "# Format: subnet | avg_latency_ms | success_rate",
      ...cleanResults.map(
        (r) =>
          `${r.cidr.padEnd(20)} # ${r.avgLatency.toFixed(0).padStart(4)}ms  ${(
            r.successRate * 100
          ).toFixed(0)}%`
      ),
    ].join("\n") + "\n";

  fs.writeFileSync(CONFIG.OUTPUT_FILE, output);

  // Also save just the IPs without metadata
  const plainOutput = cleanResults.map((r) => r.cidr).join("\n") + "\n";
  fs.writeFileSync("clean-ips-plain.txt", plainOutput);

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
