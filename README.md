# Cloudflare Clean Range Scanner

Fetches Cloudflare IP ranges from cloudflare.com and finds **working ranges** on your network.  
Scanning is based on **HTTPS trace verification** (proves real Cloudflare, not just TCP reachability). Output is **ranges only**.

## Quick Start

```bash
npm install
npm run build
npm start
```

Output: `ip.txt` — working Cloudflare ranges sorted by latency.

---

## Usage

### Mode 1: Standard — Scan Official Cloudflare Ranges

Scans all ranges published by Cloudflare directly.

```bash
npm start
# or
node dist/index.js
```

**Output:** `ip.txt` — working ranges (one CIDR per line).

---

### Mode 2: Large File — Filter Your Own Subnet List

Use when you have a large file of subnets (e.g. 300k+ lines) and want to:

1. Filter to only subnets that **overlap** Cloudflare ranges
2. Probe those for working IPs

```bash
npm run scan:subnets
# or specify a file:
node dist/scan-subnets.js path/to/subnets.txt

# Probe ALL subnets (no Cloudflare filter) — when your list already has CF subnets:
node dist/scan-subnets.js subnets.txt --all
```

**Input:** `subnets.txt` (default) or any file path you pass.

**`--all` / `-a`:** Skip the Cloudflare overlap filter. Probes every subnet in the file. Use when your subnets include Cloudflare IPs not in the official list, or use non-standard formats (e.g. `L1:192.168.0.0/24`).

**Output:**

- `cloudflare-subnets.txt` — subnets that overlap Cloudflare ranges (before probing)
- `clean-ips.txt` — working subnets with latency and success rate
- `clean-ips-plain.txt` — plain list of working subnets only

**Filter logic:** Subnets that **overlap** Cloudflare ranges are kept. Catch-all subnets like `0.0.0.0/0` are excluded.

---

### Custom Probe URL — Test Your Own Site

Probe your own website (behind Cloudflare) instead of cloudflare.com. Works like `curl --resolve HOST:443:IP`.

```bash
# Environment variable
PROBE_URL=https://yoursite.com/ node dist/scan-subnets.js subnets.txt

# Or CLI flag (both modes)
node dist/scan-subnets.js subnets.txt --probe-url https://yoursite.com/
node dist/index.js --probe-url https://yoursite.com/
```

- **Default:** `https://biatid.ir/pull/` — verifies HTTP 2xx response
- **Cloudflare trace:** `https://www.cloudflare.com/cdn-cgi/trace` — verifies `colo=`, `ip=`
- **Custom URL:** Any HTTPS URL — verifies HTTP 2xx response

Use this to find Cloudflare IPs that can reach **your** site (e.g. in restricted networks).

---

## What It Does

1. **Fetch** — Downloads Cloudflare IPv4 and IPv6 ranges from cloudflare.com/ips-v4 and /ips-v6
2. **Probe ranges** — For each CIDR:
   - Picks **random IPs** spread across the range
   - Makes **HTTPS request** to Cloudflare's `/cdn-cgi/trace` endpoint
   - Verifies response contains `colo=` and `ip=` (proves it's real Cloudflare)
   - Measures latency for each successful response
3. **Filter** — A range passes only if:
   - **≥50%** of sampled IPs return valid Cloudflare trace (large-file mode)
   - **≥60%** for standard mode
   - **Average latency** under threshold (3s large-file, 2s standard)
4. **Output** — Writes **working ranges** sorted by latency (best first)

This method is designed for networks where many Cloudflare IPs are blocked or return fake responses.  
Unlike TCP-only checks, it verifies the IP actually serves real Cloudflare content.

---

## Output Format

**ip.txt** (standard mode):

```text
104.16.0.0/13
172.64.0.0/13
```

**clean-ips.txt** (large-file mode):

```text
104.16.0.0/24     #  686ms  100%
173.245.48.0/24   #  743ms  100%
```

Use these ranges in firewall allowlists, proxy configs, etc.

---

## Requirements

- Node.js 18+
