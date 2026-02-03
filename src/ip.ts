import IpCidr from "ip-cidr";

export function isIPv4Export(ip: string): boolean {
  return ip.includes(".");
}

function isIPv4(ip: string): boolean {
  return ip.includes(".");
}

function fixIP(ip: string): string {
  if (!ip.includes("/")) {
    return isIPv4(ip) ? `${ip}/32` : `${ip}/128`;
  }
  return ip;
}

/**
 * Get the first IP of a CIDR range.
 * Used to check if a whole Cloudflare range is usable on your network.
 */
export function getStartIp(cidr: string): string | null {
  try {
    const c = new IpCidr(cidr.trim());
    const start = c.start() as string;
    return start || null;
  } catch {
    return null;
  }
}

/** IPv4: one random IP per /24 block (kept for possible future use). */
function chooseIPv4(cidr: string): string[] {
  try {
    const c = new IpCidr(cidr);
    const start = c.start() as string;
    const end = c.end() as string;
    if (!start || !end) return [];
    const parts = start.split(".").map(Number);
    if (parts.length !== 4) return [];
    const prefix = parseInt(cidr.split("/")[1] || "32", 10);
    if (prefix >= 32) return [start];

    const result: string[] = [];
    const toNum = (a: number, b: number, c: number, d: number) =>
      (a << 24) | (b << 16) | (c << 8) | d;
    const [a0, b0, c0, d0] = start.split(".").map(Number);
    const [a1, b1, c1, d1] = end.split(".").map(Number);
    let startNum = toNum(a0, b0, c0, d0);
    const endNum = toNum(a1, b1, c1, d1);
    startNum = startNum & 0xffffff00;
    for (let n = startNum; n <= endNum; n += 256) {
      const d = n & 0xff;
      const cOct = (n >> 8) & 0xff;
      const b = (n >> 16) & 0xff;
      const a = (n >> 24) & 0xff;
      const maxLast = Math.min(255, endNum - n);
      const lastOctet =
        d + (maxLast > 0 ? Math.floor(Math.random() * (maxLast + 1)) : 0);
      result.push(`${a}.${b}.${cOct}.${Math.min(255, lastOctet)}`);
    }
    return result;
  } catch {
    return [];
  }
}

/** IPv6: single or one random (kept for possible future use). */
function chooseIPv6(cidr: string): string[] {
  if (cidr.endsWith("/128")) {
    return [cidr.replace("/128", "")];
  }
  try {
    const c = new IpCidr(cidr);
    const start = c.start() as string;
    const end = c.end() as string;
    if (start === end) return [start];
    const arr = c.toArray({ from: 0, limit: 10 });
    if (Array.isArray(arr) && arr.length) {
      return [arr[Math.floor(Math.random() * arr.length)]];
    }
    return [start];
  } catch {
    return [];
  }
}

function parseCIDR(line: string): string[] {
  const fixed = fixIP(line.trim());
  if (!IpCidr.isValidCIDR(fixed)) return [];
  if (isIPv4(fixed)) return chooseIPv4(fixed);
  return chooseIPv6(fixed);
}

/** Load IPs from a list of CIDR ranges (not used by the new flow). */
export function loadIPsFromRanges(cidrs: string[]): string[] {
  const ips: string[] = [];
  for (const cidr of cidrs) {
    const t = cidr.trim();
    if (!t || t.startsWith("#")) continue;
    parseCIDR(cidr).forEach((ip) => ips.push(ip));
  }
  return ips;
}
