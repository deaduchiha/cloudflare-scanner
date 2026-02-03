/**
 * Probe Cloudflare IP ranges using HTTP trace verification.
 *
 * Supports custom PROBE_URL: test your own site behind Cloudflare.
 * Default: https://www.cloudflare.com/cdn-cgi/trace (checks colo=/ip=)
 * Custom: any URL (checks HTTP 2xx) - like curl --resolve HOST:443:IP
 */

import * as net from "net";
import * as tls from "tls";
import IpCidr from "ip-cidr";

const TIMEOUT_MS = 5000;
const SAMPLES_PER_RANGE = 5;
const MIN_SUCCESS_RATE = 0.6; // 60% must pass
const MAX_AVG_LATENCY = 2000; // ms

const DEFAULT_PROBE_URL = "https://biatid.ir/pull/";

interface ProbeConfig {
  host: string;
  path: string;
  port: number;
  isTraceEndpoint: boolean;
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

    const timeout = setTimeout(() => done(false), TIMEOUT_MS);

    const runRequest = (sock: net.Socket | tls.TLSSocket) => {
      const request = [
        `GET ${probe.path} HTTP/1.1`,
        `Host: ${probe.host}`,
        "Connection: close",
        "User-Agent: Mozilla/5.0",
        "",
        "",
      ].join("\r\n");
      sock.write(request);

      sock.on("data", (chunk) => {
        data.buf += chunk.toString();
        if (probe.isTraceEndpoint) {
          if (data.buf.includes("colo=") && data.buf.includes("ip=")) {
            clearTimeout(timeout);
            sock.destroy();
            done(true);
          }
        } else {
          const match = data.buf.match(/HTTP\/\d\.\d\s+(\d{3})/);
          if (match) {
            const code = parseInt(match[1], 10);
            clearTimeout(timeout);
            sock.destroy();
            done(code >= 100 && code < 600);
          }
        }
      });

      sock.on("end", () => {
        clearTimeout(timeout);
        if (probe.isTraceEndpoint) {
          done(data.buf.includes("colo=") && data.buf.includes("ip="));
        } else {
          const match = data.buf.match(/HTTP\/\d\.\d\s+(\d{3})/);
          done(
            match
              ? parseInt(match[1], 10) >= 100 && parseInt(match[1], 10) < 600
              : false
          );
        }
      });

      sock.on("error", () => {
        clearTimeout(timeout);
        done(false);
      });
    };

    const socket = net.connect(probe.port, ip, () => {
      if (probe.port === 443) {
        const tlsSocket = tls.connect(
          {
            socket,
            servername: probe.host,
            rejectUnauthorized: false,
          },
          () => runRequest(tlsSocket)
        );
        tlsSocket.on("error", () => {
          clearTimeout(timeout);
          done(false);
        });
      } else {
        runRequest(socket);
      }
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
async function probeRange(
  cidr: string,
  probe: ProbeConfig
): Promise<RangeResult> {
  const ips = getRandomIps(cidr, SAMPLES_PER_RANGE);
  if (ips.length === 0) {
    return { cidr, successRate: 0, avgLatency: 0, passed: false };
  }

  const results = await Promise.all(ips.map((ip) => checkProbe(ip, probe)));
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
  ) => void,
  probeUrl?: string
): Promise<string[]> {
  const probe = parseProbeUrl(
    probeUrl || process.env.PROBE_URL || DEFAULT_PROBE_URL
  );

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
      const result = await probeRange(cidr, probe);
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
