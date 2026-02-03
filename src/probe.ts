/**
 * Probe IP ranges to find which are reachable (not blocked).
 * Useful for regions like Iran where ranges get blocked daily.
 */

import * as net from "net";
import IpCidr from "ip-cidr";

const PROBE_TIMEOUT_MS = 3000;
const PROBE_PORT = 443;

/** Get IPs to probe from a CIDR - try multiple as .0 often doesn't respond. */
function getProbeIps(cidr: string): string[] {
  try {
    const c = new IpCidr(cidr.trim());
    const start = c.start() as string;
    if (!start) return [];
    const ips: string[] = [start];
    if (start.includes(".")) {
      const parts = start.split(".").map(Number);
      if (parts.length === 4) {
        if (parts[3] === 0) ips.push(`${parts[0]}.${parts[1]}.${parts[2]}.1`);
        ips.push(`${parts[0]}.${parts[1]}.${parts[2]}.${Math.min(255, parts[3] + 1)}`);
      }
    } else {
      try {
        const arr = c.toArray({ from: 1, limit: 1 });
        if (Array.isArray(arr) && arr[0]) ips.push(arr[0]);
      } catch {
        /* ignore */
      }
    }
    return [...new Set(ips)].slice(0, 3);
  } catch {
    return [];
  }
}

/** Quick TCP connect to check if IP/range is reachable. */
function probeIp(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(
      { host: ip, port, timeout: PROBE_TIMEOUT_MS },
      () => {
        sock.destroy();
        resolve(true);
      }
    );
    sock.on("error", () => resolve(false));
    sock.setTimeout(PROBE_TIMEOUT_MS, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/** Probe each range in parallel, return only reachable (unblocked) ranges. */
export async function probeRanges(
  cidrs: string[],
  port: number = PROBE_PORT,
  onProgress?: (current: number, total: number, cidr: string, ok: boolean) => void
): Promise<string[]> {
  const valid = cidrs.filter((c) => {
    const t = c.trim();
    return t && !t.startsWith("#");
  });

  const results: string[] = [];
  let done = 0;

  const probeOne = async (cidr: string): Promise<boolean> => {
    const ips = getProbeIps(cidr);
    if (ips.length === 0) {
      done++;
      onProgress?.(done, valid.length, cidr, false);
      return false;
    }
    const results = await Promise.all(ips.map((ip) => probeIp(ip, port)));
    const ok = results.some((r) => r);
    done++;
    onProgress?.(done, valid.length, cidr, ok);
    return ok;
  };

  const settled = await Promise.allSettled(
    valid.map(async (cidr) => {
      const ok = await probeOne(cidr);
      return ok ? cidr : null;
    })
  );

  for (const s of settled) {
    if (s.status === "fulfilled" && s.value) results.push(s.value);
  }

  return results;
}
