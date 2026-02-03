#!/usr/bin/env node

/**
 * Cloudflare Clean IP Scanner
 * Fetches Cloudflare IP ranges and finds ranges that are reachable (not blocked) on your network.
 * Uses a lightweight TCP probe (port 443) on a few IPs per range.
 * Output: working Cloudflare IP RANGES only (no individual IPs).
 */

import * as fs from "fs";
import { fetchCloudflareRanges } from "./fetch";
import { probeRanges } from "./probe";
import { cli } from "./utils";

const OUTPUT_FILE = "ip.txt";

async function main(): Promise<void> {
  console.log("");
  console.log(cli.bold("  Cloudflare Clean IP Scanner"));
  console.log(cli.dim("  Fetch → Probe ranges (HTTPS trace verification)"));
  console.log("");

  // 1. Fetch Cloudflare IP ranges
  console.log(cli.cyan("  Fetching Cloudflare IP ranges..."));
  const { ipv4, ipv6 } = await fetchCloudflareRanges();
  const ranges = [...ipv4, ...ipv6];
  console.log(cli.green(`  Fetched ${ranges.length} ranges`));
  console.log("");

  // 2. Probe ranges with a TCP connect on port 443.
  //    probeRanges tries a few IPs from each range (better than only start IP)
  //    and marks the range as working if any of them connect successfully.
  console.log(cli.cyan("  Probing ranges (HTTPS trace verification)..."));
  const goodRanges = await probeRanges(ranges, 443, (cur, tot, cidr, ok) => {
    const status = ok ? cli.green("✓") : cli.dim("✗");
    process.stdout.write(`\r  ${cur}/${tot} ${status} ${cidr}    `);
  });
  process.stdout.write("\r" + " ".repeat(70) + "\r");

  console.log(
    cli.green(`  Working ranges: ${goodRanges.length}/${ranges.length}`)
  );
  if (goodRanges.length === 0) {
    console.error(cli.yellow("  All Cloudflare ranges appear blocked."));
    process.exit(1);
  }

  // 3. Write output: only ranges, no individual IPs
  const content =
    [
      "# Working Cloudflare IP ranges (HTTPS trace verified, sorted by latency)",
      "# " + new Date().toISOString().slice(0, 10),
      "# " + goodRanges.length + " ranges",
      "",
      ...goodRanges,
    ].join("\n") + "\n";

  fs.writeFileSync(OUTPUT_FILE, content, "utf-8");
  console.log(
    cli.green(`  Saved ${goodRanges.length} working ranges → ${OUTPUT_FILE}`)
  );
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
