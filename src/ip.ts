import * as fs from "fs";
import * as path from "path";
import IpCidr from "ip-cidr";

const DEFAULT_IP_FILE = "ip.txt";

export let testAll = false;
export let ipFile = DEFAULT_IP_FILE;
export let ipText = "";
export let seedIp = "";

/** Last loaded CIDR lines (for display). Set by loadIPRanges(). */
export let lastLoadedRanges: string[] = [];

export function setIPOptions(opts: {
  testAll?: boolean;
  ipFile?: string;
  ipText?: string;
  seedIp?: string;
}) {
  if (opts.testAll !== undefined) testAll = opts.testAll;
  if (opts.ipFile !== undefined) ipFile = opts.ipFile;
  if (opts.ipText !== undefined) ipText = opts.ipText;
  if (opts.seedIp !== undefined) seedIp = opts.seedIp;
}

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

/** Convert single IPv4 to /24 range for scanning nearby IPs. */
export function ipToCidr24(ip: string): string | null {
  if (!isIPv4(ip) || ip.includes("/")) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/** IPv4: one random IP per /24 block, or all IPs if testAll (capped). */
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

    if (testAll) {
      const out: string[] = [];
      const max = 15000;
      const arr = c.toArray({ from: 0, limit: max });
      return Array.isArray(arr) ? arr : [];
    }

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

/** IPv6: single or one random. */
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

export function loadIPRanges(): string[] {
  const ips: string[] = [];
  lastLoadedRanges = [];
  const addRange = (cidr: string) => {
    lastLoadedRanges.push(cidr);
    parseCIDR(cidr).forEach((ip) => ips.push(ip));
  };
  if (seedIp) {
    const cidr24 = ipToCidr24(seedIp.trim());
    if (cidr24) addRange(cidr24);
  }
  if (ipText) {
    ipText.split(",").forEach((entry) => {
      const t = entry.trim();
      if (!t) return;
      addRange(t);
    });
    return ips;
  }
  const filePath = path.resolve(ipFile || DEFAULT_IP_FILE);
  if (!fs.existsSync(filePath)) {
    if (ips.length === 0) {
      console.error(`IP file not found: ${filePath}`);
      process.exit(1);
    }
  } else {
    const content = fs.readFileSync(filePath, "utf-8");
    content.split(/\r?\n/).forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      addRange(t);
    });
  }
  return ips;
}

/** Parse CIDR lines from file content (no IP expansion). */
export function parseRangesFromContent(content: string): string[] {
  const cidrs: string[] = [];
  content.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const fixed = fixIP(t);
    if (IpCidr.isValidCIDR(fixed)) cidrs.push(fixed);
  });
  return cidrs;
}

/** Load IPs from a list of CIDR ranges (used after probe filter). */
export function loadIPsFromRanges(cidrs: string[]): string[] {
  const ips: string[] = [];
  lastLoadedRanges = [];
  for (const cidr of cidrs) {
    lastLoadedRanges.push(cidr);
    parseCIDR(cidr).forEach((ip) => ips.push(ip));
  }
  return ips;
}
