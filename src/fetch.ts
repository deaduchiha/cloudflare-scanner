const CLOUDFLARE_IPS_V4 = "https://www.cloudflare.com/ips-v4";
const CLOUDFLARE_IPS_V6 = "https://www.cloudflare.com/ips-v6";

export async function fetchCloudflareRanges(): Promise<{
  ipv4: string[];
  ipv6: string[];
}> {
  const [v4Res, v6Res] = await Promise.all([
    fetch(CLOUDFLARE_IPS_V4, { signal: AbortSignal.timeout(15000) }),
    fetch(CLOUDFLARE_IPS_V6, { signal: AbortSignal.timeout(15000) }),
  ]);

  if (!v4Res.ok) throw new Error(`Failed to fetch IPv4: ${v4Res.status}`);
  if (!v6Res.ok) throw new Error(`Failed to fetch IPv6: ${v6Res.status}`);

  const v4Text = await v4Res.text();
  const v6Text = await v6Res.text();

  const ipv4 = v4Text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));

  const ipv6 = v6Text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));

  return { ipv4, ipv6 };
}
