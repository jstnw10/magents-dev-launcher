import type { OpenCodeClientInterface } from "./agent-manager";

export function createOpenCodeClient(serverUrl: string): OpenCodeClientInterface {
  const base = serverUrl.replace(/\/$/, "");

  return {
    session: {
      async create(params) {
        const res = await fetch(`${base}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params ?? {}),
        });
        if (!res.ok) {
          throw new Error(`Failed to create session: ${res.status} ${await res.text()}`);
        }
        const data = await res.json();
        return { data };
      },

      async prompt(params) {
        const res = await fetch(`${base}/session/${params.path.id}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params.body),
        });
        if (!res.ok) {
          throw new Error(`Failed to send prompt: ${res.status} ${await res.text()}`);
        }
        const data = await res.json();
        return { data };
      },

      async messages(params) {
        const res = await fetch(`${base}/session/${params.path.id}/message`);
        if (!res.ok) {
          throw new Error(`Failed to get messages: ${res.status} ${await res.text()}`);
        }
        const data = await res.json();
        return { data };
      },

      async delete(params) {
        const res = await fetch(`${base}/session/${params.path.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          throw new Error(`Failed to delete session: ${res.status} ${await res.text()}`);
        }
      },
    },
  };
}
