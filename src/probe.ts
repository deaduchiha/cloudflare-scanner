/**
 * Probe Cloudflare IP ranges using HTTP trace verification.
 *
 * NEW ALGORITHM:
 * - For each range, pick random IPs spread across the range
 * - Make HTTPS request to /cdn-cgi/trace (Cloudflare's trace endpoint)
 * - Verify response contains "colo=" (Cloudflare datacenter code)
 * - A range is clean only if majority of IPs return valid Cloudflare response
 *
 * This is more accurate than TCP-only because it verifies actual Cloudflare service,
 * not just that port 443 is open.
 */

import * as net from "net";
import * as tls from "tls";
import IpCidr from "ip-cidr";

const TIMEOUT_MS = 5000;
const SAMPLES_PER_RANGE = 5;
const MIN_SUCCESS_RATE = 0.6; // 60% must pass
const MAX_AVG_LATENCY = 2000; // ms

/** Get random IPs spread across a CIDR range. */
function getRandomIps(cidr: string, count: number): string[] {
  try {
    const c = new IpCidr(cidr.trim());
    const start = c.start() as string;
    const end = c.end() as string;
    if (!start) return [];

    // For IPv4, generate random IPs within the range
    if (start.includes(".")) {
      const startParts = start.split(".").map(Number);
      const endParts = end.split(".").map(Number);

      const toNum = (p: number[]) =>
        ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
      const fromNum = (n: number) => [
        (n >>> 24) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 8) & 0xff,
        n & 0xff,
      ];

      const startNum = toNum(startParts);
      const endNum = toNum(endParts);
      const rangeSize = endNum - startNum + 1;

      const ips: string[] = [];
      const seen = new Set<number>();

      for (let i = 0; i < count && seen.size < rangeSize; i++) {
        // Pick random offset within range
        const offset = Math.floor(Math.random() * rangeSize);
        const ipNum = startNum + offset;
        if (!seen.has(ipNum)) {
          seen.add(ipNum);
          const parts = fromNum(ipNum);
          ips.push(parts.join("."));
        }
      }
      return ips;
    }

    // For IPv6, just get first few
    const arr = c.toArray({ from: 0, limit: count }) as string[] | null;
    return arr || [start];
  } catch {
    return [];
  }
}

/**
 * Check if an IP returns valid Cloudflare trace response.
 * Makes HTTPS request to /cdn-cgi/trace and verifies "colo=" in response.
 */
function checkCloudflareTrace(
  ip: string
): Promise<{ ok: boolean; latencyMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let resolved = false;

    const done = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      const latencyMs = Date.now() - start;
      resolve({ ok, latencyMs });
    };

    const timeout = setTimeout(() => {
      done(false);
    }, TIMEOUT_MS);

    // Create raw TCP connection to the IP
    const socket = net.connect(443, ip, () => {
      // Upgrade to TLS with cloudflare.com as SNI
      const tlsSocket = tls.connect(
        {
          socket,
          servername: "www.cloudflare.com",
          rejectUnauthorized: false, // Allow self-signed for testing
        },
        () => {
          // Send HTTP request
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
            // Check if we got what we need
            if (data.includes("colo=") && data.includes("ip=")) {
              clearTimeout(timeout);
              tlsSocket.destroy();
              done(true);
            }
          });

          tlsSocket.on("end", () => {
            clearTimeout(timeout);
            // Final check
            const hasTrace = data.includes("colo=") && data.includes("ip=");
            done(hasTrace);
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

    socket.setTimeout(TIMEOUT_MS, () => {
      clearTimeout(timeout);
      socket.destroy();
      done(false);
    });
  });
}

/** Result for a single range probe. */
interface RangeResult {
  cidr: string;
  successRate: number;
  avgLatency: number;
  passed: boolean;
}

/** Probe a single range by testing multiple random IPs. */
async function probeRange(cidr: string): Promise<RangeResult> {
  const ips = getRandomIps(cidr, SAMPLES_PER_RANGE);
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
    successRate >= MIN_SUCCESS_RATE && avgLatency <= MAX_AVG_LATENCY;

  return { cidr, successRate, avgLatency, passed };
}

/** Probe all ranges and return only the ones that pass. */
export async function probeRanges(
  cidrs: string[],
  _port: number = 443,
  onProgress?: (
    current: number,
    total: number,
    cidr: string,
    ok: boolean
  ) => void
): Promise<string[]> {
  const valid = cidrs.filter((c) => {
    const t = c.trim();
    return t && !t.startsWith("#");
  });

  const results: RangeResult[] = [];
  let done = 0;

  // Process ranges with limited concurrency
  const CONCURRENCY = 10;
  let index = 0;

  const worker = async () => {
    while (index < valid.length) {
      const i = index++;
      const cidr = valid[i];
      const result = await probeRange(cidr);
      results.push(result);
      done++;
      onProgress?.(done, valid.length, cidr, result.passed);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Return only ranges that passed, sorted by latency (best first)
  return results
    .filter((r) => r.passed)
    .sort((a, b) => a.avgLatency - b.avgLatency)
    .map((r) => r.cidr);
}
