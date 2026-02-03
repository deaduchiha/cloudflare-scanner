import * as net from "net";
import * as tls from "tls";
import * as https from "https";
import * as http from "http";
import { URL } from "url";
import { isIPv4Export } from "./ip";
import type { CloudflareIPData } from "./types";
import { createOverallProgress, OverallProgress } from "./utils";

const TCP_CONNECT_TIMEOUT = 1000;

export let routines = 50;
export let tcpPort = 443;
export let pingTimes = 1;
export let httping = false;
export let httpingStatusCode = 0;
export let url = "https://speed.cloudflare.com/__down?bytes=52428800";
export let traceUrl = "https://www.cloudflare.com/cdn-cgi/trace";
export let skipTrace = false;
export let httpingCFColo = "";
let httpingCFColomap: Set<string> | null = null;

const COLO_REGEX = /[A-Z]{3}/;
const TRACE_TIMEOUT_MS = 2500;

export function setPingOptions(opts: {
  routines?: number;
  tcpPort?: number;
  pingTimes?: number;
  httping?: boolean;
  httpingStatusCode?: number;
  url?: string;
  traceUrl?: string;
  skipTrace?: boolean;
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
  if (opts.traceUrl !== undefined) traceUrl = opts.traceUrl;
  if (opts.skipTrace !== undefined) skipTrace = opts.skipTrace;
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
  const u = new URL(traceUrl);
  const isHttps = u.protocol === "https:";
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const hostname = u.hostname;
  const path = "/cdn-cgi/trace";

  return new Promise((resolve) => {
    const reqOptions: http.RequestOptions = {
      host: ip,
      port,
      path,
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

async function runOne(ip: string, bar: OverallProgress): Promise<CloudflareIPData | null> {
  const { recv, totalDelayMs } = await checkConnection(ip);
  bar.grow(1);
  if (recv === 0) return null;
  if (!skipTrace) {
    const traceOk = await checkCdnTrace(ip);
    if (!traceOk) return null;
  }
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
  concurrency: number,
  bar: OverallProgress
): Promise<CloudflareIPData[]> {
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

export async function runPing(
  ips: string[],
  bar?: OverallProgress
): Promise<CloudflareIPData[]> {
  if (ips.length === 0) return [];
  const concurrency = Math.min(routines, ips.length);
  const progress = bar || createOverallProgress("Scan", ips.length);
  const results = await runBatch(ips, concurrency, progress);
  if (!bar) progress.done();
  return results;
}
