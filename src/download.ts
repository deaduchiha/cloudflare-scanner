import * as https from "https";
import * as http from "http";
import { URL } from "url";
import type { CloudflareIPData } from "./types";
import { createRealtimeProgress, cli } from "./utils";

const BUFFER_SIZE = 1024;
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

function downloadSpeed(ip: string): Promise<number> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const port = Number(u.port) || (isHttps ? 443 : 80);
    const hostname = u.hostname;
    const path = u.pathname + u.search;
    const timeoutMs = timeoutSec * 1000;

    const opts: https.RequestOptions = {
      host: ip,
      port,
      path,
      method: "GET",
      headers: {
        Host: hostname,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.80 Safari/537.36",
      },
      timeout: timeoutMs,
      rejectUnauthorized: true,
      // Required: connect to IP but TLS SNI must be the hostname so Cloudflare accepts the handshake
      ...(isHttps && { servername: hostname }),
    };

    const req = (isHttps ? https : http).request(opts, (res) => {
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
  ipSet: CloudflareIPData[]
): Promise<CloudflareIPData[]> {
  if (disable) return ipSet;
  if (ipSet.length === 0) {
    console.log(cli.dim("\nNo IPs from latency test, skipping download."));
    return ipSet;
  }
  let testNum = Math.min(testCount, ipSet.length);
  if (minSpeed > 0) testNum = ipSet.length;

  const minSpeedLabel =
    minSpeed > 0 ? `${minSpeed.toFixed(2)} MB/s` : "none";
  console.log(
    cli.dim(`\nDownload test: min speed ${minSpeedLabel}, testing ${testNum} IPs\n`)
  );
  const bar = createRealtimeProgress(
    "Step 2/2: Download speed",
    testNum,
    "Tested"
  );
  const speedSet: CloudflareIPData[] = [];
  for (let i = 0; i < testNum; i++) {
    bar.setCurrent(ipSet[i].ip);
    const speed = await downloadSpeed(ipSet[i].ip);
    ipSet[i].downloadSpeed = speed;
    const ok = speed >= minSpeed * 1024 * 1024;
    bar.grow(1, ipSet[i].ip, ok);
    if (ok) {
      speedSet.push(ipSet[i]);
      if (speedSet.length >= testCount) break;
    }
  }
  bar.done();
  const result = speedSet.length > 0 ? speedSet : ipSet;
  return result;
}
