import * as https from "https";
import * as http from "http";
import * as net from "net";
import * as tls from "tls";
import { URL } from "url";
import type { CloudflareIPData } from "./types";
import { createOverallProgress, OverallProgress, cli } from "./utils";

const DEFAULT_TIMEOUT_SEC = 10;

export let url = "https://speed.cloudflare.com/__down?bytes=52428800";
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
      raw.setTimeout(options.timeout || timeoutSec * 1000);
    },
  };
  return new https.Agent(opts as https.AgentOptions);
}

function downloadSpeed(ip: string): Promise<number> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const port = Number(u.port) || (isHttps ? 443 : 80);
    const hostname = u.hostname;
    const path = u.pathname + u.search;
    const timeoutMs = timeoutSec * 1000;

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
    const agent = agentForIp(ip, hostname, port);
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

export async function testDownloadSpeed(
  ipSet: CloudflareIPData[],
  bar?: OverallProgress
): Promise<CloudflareIPData[]> {
  if (disable) return ipSet;
  if (ipSet.length === 0) {
    console.log(cli.dim("\nNo IPs from latency test, skipping download."));
    return ipSet;
  }
  let testNum = Math.min(testCount, ipSet.length);
  if (minSpeed > 0) testNum = ipSet.length;

  console.log(
    cli.dim(`\n2/2 Speed test: top ${testNum} by latency (use -dn N for more)\n`)
  );
  const progress = bar || createOverallProgress("Scan", testNum);
  if (bar) {
    progress.addTotal(testNum);
  }
  const speedSet: CloudflareIPData[] = [];
  for (let i = 0; i < testNum; i++) {
    const speed = await downloadSpeed(ipSet[i].ip);
    ipSet[i].downloadSpeed = speed;
    const ok = speed >= minSpeed * 1024 * 1024;
    progress.grow(1);
    if (ok) {
      speedSet.push(ipSet[i]);
      if (speedSet.length >= testCount) break;
    }
  }
  if (!bar) progress.done();
  const result = speedSet.length > 0 ? speedSet : ipSet;
  return result;
}
