import type { TunnelManager } from "./types";

function slugify(value: string) {
  return value.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").toLowerCase();
}

export class CloudflareTunnelManager implements TunnelManager {
  constructor(private readonly domain = process.env.MAGENTS_TUNNEL_DOMAIN ?? "trycloudflare.com") {}

  async attach(input: { sessionId: string; metroPort: number; publicUrl?: string }) {
    if (input.publicUrl) {
      return {
        connected: true,
        provider: "cloudflare" as const,
        publicUrl: input.publicUrl,
      };
    }

    return {
      connected: true,
      provider: "cloudflare" as const,
      publicUrl: `https://${slugify(input.sessionId)}-${input.metroPort}.${this.domain}`,
    };
  }

  async detach(_input: { sessionId: string }) {
    return {
      connected: false,
      provider: "none" as const,
    };
  }
}
