import * as net from "net";
import * as tls from "tls";
import * as https from "https";
import * as http from "http";
import { URL } from "url";
import { isIPv4Export } from "./ip";
import type { CloudflareIPData } from "./types";
import { createOverallProgress, OverallProgress } from "./utils";

// Slightly longer timeout to avoid false timeouts on slower networks (e.g. Iran)
const TCP_CONNECT_TIMEOUT = 3000;
const TRACE_TIMEOUT_MS = 2500;
const ROUTINES = 50;
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

function tcping(
  ip: string,
  port: number
): Promise<{ ok: boolean; delayMs: number }> {
  return new Promise((resolve) => {
    const addr = isIPv4Export(ip) ? `${ip}:${port}` : `[${ip}]:${port}`;
    const start = Date.now();
    const sock = net.createConnection(
      { host: ip, port, timeout: TCP_CONNECT_TIMEOUT },
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

function agentForIp(ip: string, hostname: string, port: number): https.Agent {
  const opts = {
    keepAlive: false,
    createConnection: (
      options: { port: number; host: string; timeout?: number },
      callback: (err: Error | null, s?: net.Socket) => void
    ) => {
      const raw = net.connect(port, ip, () => {
        const tlsSocket = tls.connect(
          { socket: raw, servername: hostname, rejectUnauthorized: true },
          () => callback(null, tlsSocket)
        );
        tlsSocket.on("error", (err) => callback(err));
      });
      raw.on("error", (err) => callback(err));
      raw.setTimeout(options.timeout || TRACE_TIMEOUT_MS);
    },
  };
  return new https.Agent(opts as https.AgentOptions);
}

function parseTraceBody(body: string): boolean {
  if (!body) return false;
  let hasColo = false;
  let hasIp = false;
  body.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("colo=")) hasColo = true;
    if (line.startsWith("ip=")) hasIp = true;
  });
  return hasColo && hasIp;
}

function checkCdnTrace(ip: string): Promise<boolean> {
  const u = new URL(TRACE_URL);
  const isHttps = u.protocol === "https:";
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const hostname = u.hostname;

  return new Promise((resolve) => {
    const reqOptions: http.RequestOptions = {
      host: ip,
      port,
      path: "/cdn-cgi/trace",
      method: "GET",
      headers: {
        Host: hostname,
        "User-Agent": "CloudflareScanner/1",
      },
      timeout: TRACE_TIMEOUT_MS,
    };

    const doReq = isHttps
      ? https.request({
          ...reqOptions,
          agent: agentForIp(ip, hostname, port),
          rejectUnauthorized: true,
          servername: hostname,
        })
      : http.request(reqOptions);

    const req = doReq;
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("response", (res) => {
      if ((res.statusCode || 0) !== 200) {
        res.destroy();
        resolve(false);
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
        if (data.length > 4096) res.destroy();
      });
      res.on("end", () => resolve(parseTraceBody(data)));
      res.on("error", () => resolve(false));
    });
    req.end();
  });
}

/**
 * Check if a single IP is "clean": TCP 443 connect + Cloudflare trace.
 * Used for checking the start IP of each Cloudflare range.
 */
export async function isIpClean(
  ip: string,
  port: number = 443
): Promise<{ ok: boolean; delayMs: number }> {
  const tcp = await tcping(ip, port);
  if (!tcp.ok) return { ok: false, delayMs: 0 };
  const traceOk = await checkCdnTrace(ip);
  if (!traceOk) return { ok: false, delayMs: 0 };
  return { ok: true, delayMs: tcp.delayMs };
}

// Older multi-IP scan kept for completeness (not used by the main app anymore)
async function runOne(
  ip: string,
  port: number,
  bar: OverallProgress
): Promise<CloudflareIPData | null> {
  const r = await tcping(ip, port);
  bar.grow(1);
  if (!r.ok) return null;
  const traceOk = await checkCdnTrace(ip);
  if (!traceOk) return null;
  return {
    ip,
    sent: 1,
    received: 1,
    delayMs: r.delayMs,
  };
}

async function runBatch(
  ips: string[],
  port: number,
  concurrency: number,
  bar: OverallProgress
): Promise<CloudflareIPData[]> {
  const results: CloudflareIPData[] = [];
  let next = 0;
  const workers = Array.from(
    { length: concurrency },
    async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= ips.length) return;
        const one = await runOne(ips[i], port, bar);
        if (one) results.push(one);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

export async function runPing(
  ips: string[],
  bar?: OverallProgress
): Promise<CloudflareIPData[]> {
  if (ips.length === 0) return [];
  const port = 443;
  const concurrency = Math.min(ROUTINES, ips.length);
  const progress = bar || createOverallProgress("Scan", ips.length);
  const results = await runBatch(ips, port, concurrency, progress);
  if (!bar) progress.done();
  return results;
}
