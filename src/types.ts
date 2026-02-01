export interface PingData {
  ip: string;
  sent: number;
  received: number;
  delayMs: number;
}

export interface CloudflareIPData extends PingData {
  lossRate: number;
  downloadSpeed: number; // bytes per second
}
