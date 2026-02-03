# Cloudflare Clean Range Scanner

Fetches Cloudflare IP ranges from cloudflare.com and finds **working ranges** on your network.  
Scanning is based on **TCP 443 reachability only** (no trace, no speed test). Output is **ranges only**.

## Usage

```bash
npm install
npm run build
npm start
```

Or:

```bash
node dist/index.js
```

## What it does

1. **Fetch** — Downloads Cloudflare IPv4 and IPv6 ranges from cloudflare.com/ips-v4 and /ips-v6
2. **Probe ranges** — For each CIDR, tests a few sample IPs with:
   - TCP connect to port 443
   - If any sample IP in the range connects (no timeout), the whole range is marked as working.
3. **Output** — Writes only the **working ranges** (not individual IPs) to `ip.txt`

This method is designed for networks like **Iran**, where many Cloudflare IPs are blocked or throttled.  
If a range times out on TCP 443, it is excluded.

## Output

`ip.txt` contains one CIDR per line, e.g.:

```text
104.16.0.0/13
172.64.0.0/13
2400:cb00::/32
```

Use these ranges in your own tooling or configs (firewall allowlists, proxy configs, etc.).

## Requirements

- Node.js 18+
