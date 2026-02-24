import { createLauncherClient, selectSession } from "@magents/dev-launcher";
import type { ControlTransport } from "@magents/sdk";

export interface LauncherConnectionState {
  readonly launchUrl: string;
  readonly sessionId: string;
  readonly source: "metro" | "tunnel";
}

export async function resolveLauncherConnection(
  transport: ControlTransport,
  preferredSessionId?: string
): Promise<LauncherConnectionState | undefined> {
  const client = createLauncherClient({ transport, defaultSessionId: preferredSessionId });
  const listResult = await client.listSessions();
  const selected = selectSession(listResult.sessions, {
    preferredSessionId,
    fallbackToFirstRunning: true,
  });

  if (!selected) {
    return undefined;
  }

  const endpoint = await client.resolveEndpoint(selected.id);
  const launchUrl =
    endpoint.tunnel.connected && endpoint.tunnel.publicUrl
      ? endpoint.tunnel.publicUrl
      : endpoint.metroUrl;

  return {
    launchUrl,
    sessionId: selected.id,
    source: launchUrl === endpoint.metroUrl ? "metro" : "tunnel",
  };
}
