/**
 * Probe IP ranges to find which are reachable (not blocked).
 * Useful for regions like Iran where ranges get blocked daily.
 */

import * as net from "net";
import IpCidr from "ip-cidr";

const PROBE_TIMEOUT_MS = 4000;
const PROBE_PORT = 443;

/** Get first IP from a CIDR range for probing. */
function getProbeIp(cidr: string): string | null {
  try {
    const c = new IpCidr(cidr.trim());
    const start = c.start() as string;
    return start || null;
  } catch {
    return null;
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
    const ip = getProbeIp(cidr);
    if (!ip) return false;
    const ok = await probeIp(ip, port);
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
