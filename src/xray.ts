import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as net from "net";
import * as tls from "tls";
import { spawn } from "child_process";
import { URL } from "url";
import type { CloudflareIPData } from "./types";
import { cli, OverallProgress } from "./utils";

export let xrayConfigPath = "";
export let xrayBin = "xray";
export let xrayTestUrl = "https://www.cloudflare.com/cdn-cgi/trace";
export let xrayTimeoutSec = 10;
export let xrayMaxCount = 0;

export function setXrayOptions(opts: {
  configPath?: string;
  bin?: string;
  testUrl?: string;
  timeoutSec?: number;
  maxCount?: number;
}) {
  if (opts.configPath !== undefined) xrayConfigPath = opts.configPath;
  if (opts.bin !== undefined) xrayBin = opts.bin || "xray";
  if (opts.testUrl !== undefined) xrayTestUrl = opts.testUrl;
  if (opts.timeoutSec !== undefined) xrayTimeoutSec = opts.timeoutSec;
  if (opts.maxCount !== undefined) xrayMaxCount = opts.maxCount;
}

type ProxyInbound = {
  protocol: "socks" | "http";
  host: string;
  port: number;
};

function readConfigTemplate(): Record<string, unknown> {
  const raw = fs.readFileSync(xrayConfigPath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function applyAddressInConfig(config: Record<string, unknown>, ip: string): void {
  const outbounds = config.outbounds;
  if (!Array.isArray(outbounds)) return;
  outbounds.forEach((ob) => {
    if (!ob || typeof ob !== "object") return;
    const settings = (ob as { settings?: Record<string, unknown> }).settings;
    if (!settings || typeof settings !== "object") return;
    const vnext = (settings as { vnext?: Array<Record<string, unknown>> }).vnext;
    if (Array.isArray(vnext)) {
      vnext.forEach((v) => {
        if (v && typeof v === "object" && typeof v.address === "string") {
          v.address = ip;
        }
      });
    }
    const servers = (settings as { servers?: Array<Record<string, unknown>> }).servers;
    if (Array.isArray(servers)) {
      servers.forEach((s) => {
        if (s && typeof s === "object" && typeof s.address === "string") {
          s.address = ip;
        }
      });
    }
    if (typeof (settings as { address?: unknown }).address === "string") {
      (settings as { address: string }).address = ip;
    }
  });
}

function getProxyInbound(config: Record<string, unknown>): ProxyInbound {
  const inbounds = config.inbounds;
  if (!Array.isArray(inbounds)) {
    throw new Error("Xray config missing inbounds.");
  }
  for (const inbound of inbounds) {
    if (!inbound || typeof inbound !== "object") continue;
    const protocol = (inbound as { protocol?: string }).protocol;
    if (protocol !== "socks" && protocol !== "http") continue;
    const port = Number((inbound as { port?: number | string }).port);
    const host =
      (inbound as { listen?: string }).listen || "127.0.0.1";
    const settings = (inbound as { settings?: Record<string, unknown> }).settings;
    if (protocol === "socks") {
      const auth = settings?.auth as string | undefined;
      const accounts = settings?.accounts as unknown[] | undefined;
      if (auth && auth !== "noauth") {
        throw new Error("Socks inbound uses auth; unsupported.");
      }
      if (Array.isArray(accounts) && accounts.length > 0) {
        throw new Error("Socks inbound has accounts; unsupported.");
      }
    }
    if (protocol === "http") {
      const accounts = settings?.accounts as unknown[] | undefined;
      if (Array.isArray(accounts) && accounts.length > 0) {
        throw new Error("HTTP proxy inbound has accounts; unsupported.");
      }
    }
    if (!port) throw new Error("Xray inbound port is missing.");
    return { protocol, host, port };
  }
  throw new Error("No socks/http inbound found in xray config.");
}

function waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  const tryOnce = (): Promise<boolean> =>
    new Promise((resolve) => {
      const s = net.connect(port, host, () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
      s.setTimeout(500, () => {
        s.destroy();
        resolve(false);
      });
    });

  return new Promise(async (resolve) => {
    for (;;) {
      if (await tryOnce()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      await new Promise((r) => setTimeout(r, 150));
    }
  });
}

function readUntil(
  socket: net.Socket,
  matcher: (buf: Buffer) => boolean,
  timeoutMs: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (matcher(buf)) {
        cleanup();
        resolve(buf);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("timeout"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.setTimeout(timeoutMs, onTimeout);
  });
}

async function httpProxyTunnel(
  proxy: ProxyInbound,
  targetHost: string,
  targetPort: number,
  timeoutMs: number
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host, async () => {
      const req = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        "Proxy-Connection: close",
        "",
        "",
      ].join("\r\n");
      socket.write(req);
      try {
        const data = await readUntil(
          socket,
          (buf) => buf.toString("utf8").includes("\r\n\r\n"),
          timeoutMs
        );
        const line = data.toString("utf8").split("\r\n")[0] || "";
        if (!line.includes("200")) {
          socket.destroy();
          return reject(new Error(`proxy connect failed: ${line}`));
        }
        resolve(socket);
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });
    socket.on("error", reject);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error("proxy timeout"));
    });
  });
}

async function socksProxyTunnel(
  proxy: ProxyInbound,
  targetHost: string,
  targetPort: number,
  timeoutMs: number
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host, async () => {
      try {
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
        const hello = await readUntil(socket, (buf) => buf.length >= 2, timeoutMs);
        if (hello[0] !== 0x05 || hello[1] !== 0x00) {
          socket.destroy();
          return reject(new Error("socks auth failed"));
        }
        socket.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, targetHost.length]),
            Buffer.from(targetHost, "utf8"),
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
          ])
        );
        const resp = await readUntil(socket, (buf) => buf.length >= 10, timeoutMs);
        if (resp[1] !== 0x00) {
          socket.destroy();
          return reject(new Error("socks connect failed"));
        }
        resolve(socket);
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });
    socket.on("error", reject);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error("socks timeout"));
    });
  });
}

async function requestThroughProxy(
  proxy: ProxyInbound,
  testUrl: string,
  timeoutMs: number
): Promise<number> {
  const u = new URL(testUrl);
  const isHttps = u.protocol === "https:";
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const path = u.pathname + u.search;

  const tunnel =
    proxy.protocol === "http"
      ? await httpProxyTunnel(proxy, u.hostname, port, timeoutMs)
      : await socksProxyTunnel(proxy, u.hostname, port, timeoutMs);

  const socket = isHttps
    ? tls.connect({ socket: tunnel, servername: u.hostname })
    : tunnel;

  return new Promise((resolve) => {
    const start = Date.now();
    const req = [
      `GET ${path} HTTP/1.1`,
      `Host: ${u.hostname}`,
      "Connection: close",
      "User-Agent: CloudflareScanner/1",
      "",
      "",
    ].join("\r\n");
    socket.write(req);
    socket.on("data", () => {
      const elapsed = Date.now() - start;
      socket.destroy();
      resolve(elapsed);
    });
    socket.on("error", () => resolve(0));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(0);
    });
  });
}

async function runXrayForIp(ip: string): Promise<number> {
  const template = readConfigTemplate();
  applyAddressInConfig(template, ip);
  const inbound = getProxyInbound(template);
  const tmpPath = path.join(
    os.tmpdir(),
    `xray-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(tmpPath, JSON.stringify(template, null, 2), "utf-8");

  const proc = spawn(xrayBin, ["run", "-c", tmpPath], { stdio: "ignore" });
  let spawnError: Error | null = null;
  proc.on("error", (err) => {
    spawnError = err;
  });
  const timeoutMs = xrayTimeoutSec * 1000;
  try {
    if (spawnError) return 0;
    const ready = await waitForPort(inbound.host, inbound.port, timeoutMs);
    if (!ready) return 0;
    const latency = await requestThroughProxy(inbound, xrayTestUrl, timeoutMs);
    return latency;
  } finally {
    proc.kill("SIGTERM");
    fs.unlinkSync(tmpPath);
  }
}

export async function testXrayForIps(
  ipSet: CloudflareIPData[],
  bar?: OverallProgress
): Promise<CloudflareIPData[]> {
  if (!xrayConfigPath) return ipSet;
  if (ipSet.length === 0) return [];
  const maxCount =
    xrayMaxCount > 0 ? Math.min(xrayMaxCount, ipSet.length) : ipSet.length;
  if (bar) {
    bar.setLabel("Xray");
    bar.addTotal(maxCount);
  }

  const out: CloudflareIPData[] = [];
  for (let i = 0; i < maxCount; i++) {
    const ip = ipSet[i].ip;
    const latency = await runXrayForIp(ip);
    if (bar) bar.grow(1);
    if (latency > 0) {
      ipSet[i].xrayLatencyMs = latency;
      out.push(ipSet[i]);
    }
  }
  if (out.length === 0) {
    console.log(cli.dim("\n  No IPs passed the Xray proxy test."));
  }
  return out;
}
