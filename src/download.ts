import * as https from "https";
import * as http from "http";
import * as net from "net";
import * as tls from "tls";
import { URL } from "url";
import type { CloudflareIPData } from "./types";
import { createOverallProgress, OverallProgress, cli } from "./utils";

const DEFAULT_TIMEOUT_SEC = 20;
const SPEED_TEST_BYTES = 1048576; // 1MB - completes quickly, reliable
const FALLBACK_BYTES = 102400;    // 100KB - fallback if 1MB fails

export let url = "https://speed.cloudflare.com/__down?bytes=" + SPEED_TEST_BYTES;
export let timeoutSec = DEFAULT_TIMEOUT_SEC;
export let disable = false;
export let testCount = 10;
export let minSpeed = 0;

export function setDownloadOptions(opts: {
  url?: string;
  timeoutSec?: number;
  disable?: boolean;
  testCount?: number;
  minSpeed?: number;
}) {
  if (opts.url !== undefined) url = opts.url;
  if (opts.timeoutSec !== undefined) timeoutSec = opts.timeoutSec;
  if (opts.disable !== undefined) disable = opts.disable;
  if (opts.testCount !== undefined) testCount = opts.testCount;
  if (opts.minSpeed !== undefined) minSpeed = opts.minSpeed;
}

export let tcpPort = 443;

/** Create HTTPS agent: connect to IP, TLS with SNI = hostname (required for Cloudflare). */
function agentForIp(ip: string, hostname: string, port: number, connectTimeoutMs: number): https.Agent {
  const opts = {
    keepAlive: false,
    createConnection: (
      _options: { port: number; host: string; timeout?: number },
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
      raw.setTimeout(connectTimeoutMs);
    },
  };
  return new https.Agent(opts as https.AgentOptions);
}

async function downloadSpeed(ip: string): Promise<number> {
  let speed = await downloadSpeedWithBytes(ip, SPEED_TEST_BYTES);
  if (speed === 0) {
    speed = await downloadSpeedWithBytes(ip, FALLBACK_BYTES);
  }
  return speed;
}

function downloadSpeedWithBytes(ip: string, bytes: number): Promise<number> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const path = (u.pathname || "/__down") + "?bytes=" + bytes;
    const isHttps = u.protocol === "https:";
    const port = Number(u.port) || (isHttps ? 443 : 80);
    const hostname = u.hostname;
    const timeoutMs = timeoutSec * 1000;
    const connectTimeoutMs = Math.min(15000, timeoutMs);

    if (!isHttps) {
      const opts: http.RequestOptions = {
        host: ip,
        port,
        path,
        method: "GET",
        headers: { Host: hostname, "User-Agent": "CloudflareScanner/1" },
        timeout: timeoutMs,
      };
      const req = http.request(opts, (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          resolve(0);
          return;
        }
        let total = 0;
        const start = Date.now();
        res.on("data", (c: Buffer) => (total += c.length));
        res.on("end", () => {
          const elapsed = (Date.now() - start) / 1000;
          resolve(elapsed > 0 ? total / elapsed : 0);
        });
        res.on("error", () => resolve(0));
      });
      req.on("error", () => resolve(0));
      req.on("timeout", () => {
        req.destroy();
        resolve(0);
      });
      req.end();
      return;
    }

    // HTTPS: connect to IP, TLS SNI = hostname
    const agent = agentForIp(ip, hostname, port, connectTimeoutMs);
    const opts: https.RequestOptions = {
      host: ip,
      port,
      path,
      method: "GET",
      headers: {
        Host: hostname,
        "User-Agent": "Mozilla/5.0 (compatible; CloudflareScanner/1)",
      },
      timeout: timeoutMs,
      agent,
      rejectUnauthorized: true,
      servername: hostname,
    };

    const req = https.request(opts, (res) => {
      if (res.statusCode !== 200) {
        res.destroy();
        resolve(0);
        return;
      }
      const start = Date.now();
      let totalRead = 0;
      res.on("data", (chunk: Buffer) => {
        totalRead += chunk.length;
      });
      res.on("end", () => {
        const elapsed = (Date.now() - start) / 1000;
        resolve(elapsed > 0 ? totalRead / elapsed : 0);
      });
      res.on("error", () => resolve(0));
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });
}

const SPEED_PARALLEL = 5;

export async function testDownloadSpeed(
  ipSet: CloudflareIPData[],
  bar?: OverallProgress
): Promise<CloudflareIPData[]> {
  if (disable) return ipSet;
  if (ipSet.length === 0) {
    console.log(cli.dim("\n  No IPs from latency test; skipping speed test."));
    return ipSet;
  }
  let testNum = Math.min(Math.max(testCount * 2, 15), ipSet.length);
  if (minSpeed > 0) testNum = ipSet.length;

  if (!bar) console.log("");
  const progress = bar || createOverallProgress("Speed", testNum);
  if (bar) progress.reset("Speed", testNum);

  const results: CloudflareIPData[] = [];
  const toTest = ipSet.slice(0, testNum);

  for (let i = 0; i < toTest.length; i += SPEED_PARALLEL) {
    const batch = toTest.slice(i, i + SPEED_PARALLEL);
    const speeds = await Promise.all(batch.map((d) => downloadSpeed(d.ip)));
    for (let j = 0; j < batch.length; j++) {
      batch[j].downloadSpeed = speeds[j];
      progress.grow(1);
      if (speeds[j] > 0 && speeds[j] >= minSpeed * 1024 * 1024) {
        results.push(batch[j]);
      }
    }
    if (results.length >= testCount) break;
  }

  if (!bar) progress.done();
  const withSpeed = results.filter((d) => d.downloadSpeed > 0);
  const sorted = [...withSpeed].sort((a, b) => b.downloadSpeed - a.downloadSpeed);
  return sorted.length > 0 ? sorted : ipSet.slice(0, testNum);
}
