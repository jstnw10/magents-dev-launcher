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
        const data = (await res.json()) as {
          id: string;
          slug: string;
          title: string;
        };
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
        const data = (await res.json()) as
          | {
              info: {
                id: string;
                role: string;
                tokens?: { input: number; output: number };
                cost?: number;
              };
              parts: Array<{
                type: string;
                text?: string;
                [key: string]: unknown;
              }>;
            }
          | undefined;
        return { data };
      },

      async messages(params) {
        const res = await fetch(`${base}/session/${params.path.id}/message`);
        if (!res.ok) {
          throw new Error(`Failed to get messages: ${res.status} ${await res.text()}`);
        }
        const data = (await res.json()) as Array<{
          info: {
            id: string;
            role: string;
            time: { created: number };
          };
          parts: Array<{
            type: string;
            text?: string;
            [key: string]: unknown;
          }>;
        }>;
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

      async list() {
        const res = await fetch(`${base}/session`);
        if (!res.ok) {
          throw new Error(`Failed to list sessions: ${res.status} ${await res.text()}`);
        }
        const data = (await res.json()) as Array<{
          id: string;
          slug: string;
          projectID: string;
          directory: string;
          parentID?: string;
          title: string;
          version?: string;
          time: { created: number; updated: number };
        }>;
        return { data };
      },
    },
  };
}
