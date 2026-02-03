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
2. **Probe ranges** — For each CIDR:
   - Picks **random IPs** spread across the range (not just start/end)
   - Makes **HTTPS request** to Cloudflare's `/cdn-cgi/trace` endpoint
   - Verifies response contains `colo=` and `ip=` (proves it's real Cloudflare)
   - Measures latency for each successful response
3. **Filter** — A range passes only if:
   - **≥60%** of sampled IPs return valid Cloudflare trace
   - **Average latency** is under 2 seconds
4. **Output** — Writes only the **working ranges** (sorted by latency, best first) to `ip.txt`

This method is designed for networks like **Iran**, where many Cloudflare IPs are blocked or return fake responses.  
Unlike TCP-only checks, this verifies the IP actually serves real Cloudflare content.

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
