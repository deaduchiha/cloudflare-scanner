import * as net from "net";
import * as https from "https";
import * as http from "http";
import { URL } from "url";
import { isIPv4Export } from "./ip";
import type { CloudflareIPData } from "./types";
import { createRealtimeProgress } from "./utils";

const TCP_CONNECT_TIMEOUT = 1000;

export let routines = 10;
export let tcpPort = 443;
export let pingTimes = 4;
export let httping = false;
export let httpingStatusCode = 0;
export let url = "https://speed.cloudflare.com/__down?bytes=52428800";
export let httpingCFColo = "";
let httpingCFColomap: Set<string> | null = null;

const COLO_REGEX = /[A-Z]{3}/;

export function setPingOptions(opts: {
  routines?: number;
  tcpPort?: number;
  pingTimes?: number;
  httping?: boolean;
  httpingStatusCode?: number;
  url?: string;
  httpingCFColo?: string;
}) {
  if (opts.routines !== undefined)
    routines = Math.min(1000, Math.max(1, opts.routines));
  if (opts.tcpPort !== undefined) tcpPort = opts.tcpPort;
  if (opts.pingTimes !== undefined) pingTimes = opts.pingTimes;
  if (opts.httping !== undefined) httping = opts.httping;
  if (opts.httpingStatusCode !== undefined)
    httpingStatusCode = opts.httpingStatusCode;
  if (opts.url !== undefined) url = opts.url;
  if (opts.httpingCFColo !== undefined) {
    httpingCFColo = opts.httpingCFColo;
    httpingCFColomap = httpingCFColo
      ? new Set(
          httpingCFColo
            .toUpperCase()
            .split(",")
            .map((s) => s.trim())
        )
      : null;
  }
}

function getColo(headerValue: string): string {
  if (!headerValue) return "";
  const m = headerValue.match(COLO_REGEX);
  const out = m ? m[0] : "";
  if (!httpingCFColomap) return out;
  return httpingCFColomap.has(out) ? out : "";
}

function tcping(ip: string): Promise<{ ok: boolean; delayMs: number }> {
  return new Promise((resolve) => {
    const addr = isIPv4Export(ip) ? `${ip}:${tcpPort}` : `[${ip}]:${tcpPort}`;
    const start = Date.now();
    const sock = net.createConnection(
      { host: ip, port: tcpPort, timeout: TCP_CONNECT_TIMEOUT },
      () => {
        const delayMs = Date.now() - start;
        sock.destroy();
        resolve({ ok: true, delayMs });
      }
    );
    sock.on("error", () => resolve({ ok: false, delayMs: 0 }));
    sock.setTimeout(TCP_CONNECT_TIMEOUT, () => {
      sock.destroy();
      resolve({ ok: false, delayMs: 0 });
    });
  });
}

function httpingOnce(
  ip: string
): Promise<{ ok: boolean; delayMs: number; colo?: string }> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const port = u.port || (isHttps ? 443 : 80);
  const host = u.hostname;

  return new Promise((resolve) => {
    const start = Date.now();
    const opts: http.RequestOptions = {
      host: ip,
      port,
      path: u.pathname + u.search,
      method: "HEAD",
      headers: {
        Host: host,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.80 Safari/537.36",
      },
      timeout: 2000,
    };

    const req = (isHttps ? https : http).request(opts, (res) => {
      const delayMs = Date.now() - start;
      const code = res.statusCode || 0;
      const valid =
        httpingStatusCode === 0 ||
        (httpingStatusCode >= 100 && httpingStatusCode <= 599)
          ? [200, 301, 302].includes(code)
          : code === httpingStatusCode;
      if (!valid) {
        res.destroy();
        resolve({ ok: false, delayMs: 0 });
        return;
      }
      if (httpingCFColo) {
        const cfRay =
          res.headers["server"] === "cloudflare"
            ? (res.headers["cf-ray"] as string)
            : (res.headers["x-amz-cf-pop"] as string);
        const colo = getColo(cfRay || "");
        if (!colo) {
          res.destroy();
          resolve({ ok: false, delayMs: 0 });
          return;
        }
      }
      res.destroy();
      resolve({ ok: true, delayMs });
    });
    req.on("error", () => resolve({ ok: false, delayMs: 0 }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, delayMs: 0 });
    });
    req.end();
  });
}

async function httpingMulti(
  ip: string
): Promise<{ recv: number; totalDelayMs: number }> {
  let recv = 0;
  let totalDelayMs = 0;
  for (let i = 0; i < pingTimes; i++) {
    const r = await httpingOnce(ip);
    if (r.ok) {
      recv++;
      totalDelayMs += r.delayMs;
    }
  }
  return { recv, totalDelayMs };
}

async function checkConnection(
  ip: string
): Promise<{ recv: number; totalDelayMs: number }> {
  if (httping) return httpingMulti(ip);
  let recv = 0;
  let totalDelayMs = 0;
  for (let i = 0; i < pingTimes; i++) {
    const r = await tcping(ip);
    if (r.ok) {
      recv++;
      totalDelayMs += r.delayMs;
    }
  }
  return { recv, totalDelayMs };
}

async function runOne(
  ip: string,
  bar: ReturnType<typeof createRealtimeProgress>
): Promise<CloudflareIPData | null> {
  const { recv, totalDelayMs } = await checkConnection(ip);
  bar.grow(1, ip, recv > 0);
  if (recv === 0) return null;
  return {
    ip,
    sent: pingTimes,
    received: recv,
    delayMs: totalDelayMs / recv,
    lossRate: 0,
    downloadSpeed: 0,
  };
}

async function runBatch(
  ips: string[],
  concurrency: number
): Promise<CloudflareIPData[]> {
  const bar = createRealtimeProgress(
    "Step 1/2: Latency test",
    ips.length,
    "Scanned"
  );
  const results: CloudflareIPData[] = [];
  let next = 0;
  const workers = Array.from({ length: concurrency }, async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= ips.length) return;
      const one = await runOne(ips[i], bar);
      if (one) results.push(one);
    }
  });
  await Promise.all(workers);
  bar.done();
  return results;
}

export async function runPing(ips: string[]): Promise<CloudflareIPData[]> {
  if (ips.length === 0) return [];
  const concurrency = Math.min(routines, ips.length);
  const results = await runBatch(ips, concurrency);
  return results;
}
