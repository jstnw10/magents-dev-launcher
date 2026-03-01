import { mkdir } from "node:fs/promises";
import path from "node:path";

import { AgentManager, type AgentMetadata, type Conversation, type ConversationMessage } from "./agent-manager";
import { OrchestrationError } from "./types";
import { getPromptForAgent } from "./prompt-templates";
import type { SpecialistRegistry } from "./specialist-registry";

// --- Types ---

export interface AgentServerInfo {
  port: number;
  url: string;
  startedAt: string;
}

export interface AgentServerOptions {
  workspacePath: string;
  manager: AgentManager;
  openCodeUrl: string;
  port?: number;
  specialistRegistry?: SpecialistRegistry;
}

/** Per-agent SSE subscription state */
interface SessionState {
  agentId: string;
  sessionId: string;
  assistantMessageId: string | null;
  streamingParts: Map<string, { id: string; type: string; text?: string; [key: string]: unknown }>;
  streamingPartOrder: string[];
  websockets: Set<ServerWebSocket>;
  sseAbortController: AbortController | null;
}

type ServerWebSocket = { data: unknown; send(data: string): void };

// --- Helpers ---

export const DEFAULT_AGENT_SERVER_PORT = 4097;

function serverInfoDir(workspacePath: string): string {
  return path.join(workspacePath, ".workspace", "agent-manager");
}

function serverInfoPath(workspacePath: string): string {
  return path.join(serverInfoDir(workspacePath), "server.json");
}

function conversationLogPath(workspacePath: string, agentId: string): string {
  return path.join(workspacePath, ".workspace", "agents", `${agentId}.json`);
}

function extractAgentIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/agent\/([^/]+)/);
  return match ? match[1]! : null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// --- SSE Parsing ---

function parseSSEChunk(buffer: string): { events: Array<{ event?: string; data: string }>; remainder: string } {
  const events: Array<{ event?: string; data: string }> = [];
  let remainder = buffer;

  while (true) {
    const idx = remainder.indexOf("\n\n");
    if (idx === -1) break;

    const block = remainder.slice(0, idx);
    remainder = remainder.slice(idx + 2);

    if (!block.trim()) continue;
    let eventType: string | undefined;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).trim();
        if (data) data += "\n";
        data += value;
      }
    }
    if (data) {
      events.push({ event: eventType, data });
    }
  }
  return { events, remainder };
}

// --- Agent Server ---

export class AgentServer {
  private readonly workspacePath: string;
  private readonly manager: AgentManager;
  private readonly openCodeUrl: string;
  private readonly port: number;
  private readonly specialistRegistry?: SpecialistRegistry;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private sessions = new Map<string, SessionState>();

  constructor(options: AgentServerOptions) {
    this.workspacePath = options.workspacePath;
    this.manager = options.manager;
    this.openCodeUrl = options.openCodeUrl.replace(/\/$/, "");
    this.port = options.port ?? DEFAULT_AGENT_SERVER_PORT;
    this.specialistRegistry = options.specialistRegistry;
  }

  async start(): Promise<AgentServerInfo> {
    const self = this;

    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",

      async fetch(req, server) {
        return self.handleRequest(req, server);
      },

      websocket: {
        open(ws) {
          const agentId = (ws.data as { agentId: string }).agentId;
          const session = self.sessions.get(agentId);
          if (session) {
            session.websockets.add(ws as unknown as ServerWebSocket);
          }
        },
        async message(ws, message) {
          await self.handleWebSocketMessage(ws as unknown as ServerWebSocket, message);
        },
        close(ws) {
          const agentId = (ws.data as { agentId: string }).agentId;
          const session = self.sessions.get(agentId);
          if (session) {
            session.websockets.delete(ws as unknown as ServerWebSocket);
          }
        },
      },
    });

    const info: AgentServerInfo = {
      port: this.port,
      url: `http://127.0.0.1:${this.port}`,
      startedAt: new Date().toISOString(),
    };

    await this.persistServerInfo(info);
    return info;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.sseAbortController?.abort();
    }
    this.sessions.clear();

    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }

    await this.removeServerInfo();
  }


  // --- HTTP Request Handler ---

  private async handleRequest(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    // WebSocket upgrade
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const agentId = extractAgentIdFromPath(pathname);
      if (!agentId) {
        return errorResponse("Invalid agent path for WebSocket", 400);
      }
      try {
        const metadata = await this.manager.getAgent(this.workspacePath, agentId);
        if (!this.sessions.has(agentId)) {
          this.sessions.set(agentId, {
            agentId,
            sessionId: metadata.sessionId,
            assistantMessageId: null,
            streamingParts: new Map(),
            streamingPartOrder: [],
            websockets: new Set(),
            sseAbortController: null,
          });
        }
        const upgraded = server.upgrade(req, { data: { agentId } });
        if (!upgraded) {
          return errorResponse("WebSocket upgrade failed", 500);
        }
        return undefined as unknown as Response;
      } catch (err) {
        if (err instanceof OrchestrationError && err.code === "AGENT_NOT_FOUND") {
          return errorResponse(`Agent not found: ${agentId}`, 404);
        }
        throw err;
      }
    }

    // GET /specialists — list available specialists
    if (method === "GET" && pathname === "/specialists") {
      if (!this.specialistRegistry) {
        return jsonResponse({ specialists: [] });
      }
      try {
        const specialists = await this.specialistRegistry.list();
        return jsonResponse({
          specialists: specialists.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            defaultModel: s.defaultModel,
            source: s.source,
          })),
        });
      } catch (err) {
        return errorResponse((err as Error).message, 500);
      }
    }

    // POST /agent — create agent
    if (method === "POST" && pathname === "/agent") {
      try {
        const body = await req.json() as { label: string; model?: string; specialistId?: string; systemPrompt?: string };
        if (!body.label) return errorResponse("Missing required field: label");

        // Auto-resolve specialist prompt if specialistId is provided but systemPrompt is not
        let systemPrompt = body.systemPrompt;
        let model = body.model;
        if (body.specialistId && !systemPrompt && this.specialistRegistry) {
          const spec = await this.specialistRegistry.get(body.specialistId);
          if (spec) {
            systemPrompt = spec.systemPrompt;
            model = model ?? spec.defaultModel;
          }
        }

        const metadata = await this.manager.createAgent(this.workspacePath, {
          label: body.label,
          model,
          specialistId: body.specialistId,
          systemPrompt,
        });
        return jsonResponse(metadata, 201);
      } catch (err) {
        return errorResponse((err as Error).message, 500);
      }
    }

    // GET /agent — list agents
    if (method === "GET" && pathname === "/agent") {
      const agents = await this.manager.listAgents(this.workspacePath);
      return jsonResponse({ agents });
    }

    // GET /agent/:id
    if (method === "GET" && pathname.match(/^\/agent\/[^/]+$/) && !pathname.includes("/conversation")) {
      const agentId = extractAgentIdFromPath(pathname)!;
      try {
        const metadata = await this.manager.getAgent(this.workspacePath, agentId);
        return jsonResponse(metadata);
      } catch (err) {
        if (err instanceof OrchestrationError && err.code === "AGENT_NOT_FOUND") {
          return errorResponse(`Agent not found: ${agentId}`, 404);
        }
        return errorResponse((err as Error).message, 500);
      }
    }

    // DELETE /agent/:id
    if (method === "DELETE" && pathname.match(/^\/agent\/[^/]+$/)) {
      const agentId = extractAgentIdFromPath(pathname)!;
      try {
        const session = this.sessions.get(agentId);
        if (session) {
          session.sseAbortController?.abort();
          this.sessions.delete(agentId);
        }
        await this.manager.removeAgent(this.workspacePath, agentId);
        return jsonResponse({ removed: true, agentId });
      } catch (err) {
        if (err instanceof OrchestrationError && err.code === "AGENT_NOT_FOUND") {
          return errorResponse(`Agent not found: ${agentId}`, 404);
        }
        return errorResponse((err as Error).message, 500);
      }
    }

    // GET /agent/:id/conversation
    if (method === "GET" && pathname.match(/^\/agent\/[^/]+\/conversation$/)) {
      const agentId = extractAgentIdFromPath(pathname)!;
      try {
        const conversation = await this.manager.getConversation(this.workspacePath, agentId);
        return jsonResponse(conversation);
      } catch (err) {
        if (err instanceof OrchestrationError && err.code === "AGENT_NOT_FOUND") {
          return errorResponse(`Agent not found: ${agentId}`, 404);
        }
        return errorResponse((err as Error).message, 500);
      }
    }

    return errorResponse("Not found", 404);
  }

  // --- WebSocket Message Handler ---

  private async handleWebSocketMessage(ws: ServerWebSocket, message: string | Buffer): Promise<void> {
    const agentId = (ws.data as { agentId: string }).agentId;
    const text = typeof message === "string" ? message : message.toString();

    let parsed: { type: string; text?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (parsed.type === "cancel") {
      const session = this.sessions.get(agentId);
      if (session?.sseAbortController) {
        session.sseAbortController.abort();
        session.sseAbortController = null;
      }
      return;
    }

    if (parsed.type === "message" && parsed.text) {
      await this.handleUserMessage(agentId, parsed.text);
      return;
    }

    ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${parsed.type}` }));
  }

  // --- Core Message Flow ---

  private async handleUserMessage(agentId: string, text: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;

    const metadata = await this.manager.getAgent(this.workspacePath, agentId);

    // Build prompt parts — wrap specialist prompt in task-loop template if present
    const parts: Array<{ type: string; text?: string; [key: string]: unknown }> = [];
    if (metadata.systemPrompt) {
      const resolvedPrompt = getPromptForAgent(metadata.systemPrompt);
      parts.push({ type: "text", text: resolvedPrompt, synthetic: true });
    }
    parts.push({ type: "text", text });

    // Reset streaming state
    session.assistantMessageId = null;
    session.streamingParts.clear();
    session.streamingPartOrder = [];

    // Fire-and-forget POST to OpenCode
    const postUrl = `${this.openCodeUrl}/session/${session.sessionId}/message`;
    try {
      fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts }),
      }).catch(() => {
        // Error will surface via SSE or timeout
      });
    } catch {
      this.broadcastToAgent(agentId, { type: "error", message: "Failed to send message to OpenCode" });
      return;
    }

    // Subscribe to SSE if not already subscribed
    this.ensureSSESubscription(agentId, session, text);
  }

  // --- SSE Subscription ---

  private ensureSSESubscription(agentId: string, session: SessionState, userText: string): void {
    if (session.sseAbortController) return; // Already subscribed

    const controller = new AbortController();
    session.sseAbortController = controller;

    const sseUrl = `${this.openCodeUrl}/event`;

    (async () => {
      try {
        const res = await fetch(sseUrl, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          this.broadcastToAgent(agentId, { type: "error", message: `SSE connection failed: ${res.status}` });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const { events, remainder } = parseSSEChunk(buffer);
          buffer = remainder;

          for (const event of events) {
            this.handleSSEEvent(agentId, session, event, userText);
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          this.broadcastToAgent(agentId, { type: "error", message: `SSE error: ${(err as Error).message}` });
        }
      } finally {
        if (session.sseAbortController === controller) {
          session.sseAbortController = null;
        }
      }
    })();
  }

  // --- SSE Event Handler ---

  private handleSSEEvent(
    agentId: string,
    session: SessionState,
    event: { event?: string; data: string },
    userText: string,
  ): void {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(event.data);
    } catch {
      return;
    }

    const eventType = (json.type as string) ?? "";
    const properties = (json.properties as Record<string, unknown>) ?? {};

    // Filter events to this session
    const eventSessionId =
      (properties.sessionID as string) ??
      ((properties.info as Record<string, unknown>)?.sessionID as string) ??
      ((properties.part as Record<string, unknown>)?.sessionID as string);

    if (eventSessionId && eventSessionId !== session.sessionId) return;

    switch (eventType) {
      case "message.updated": {
        const info = properties.info as Record<string, unknown> | undefined;
        if (!info) break;
        const role = info.role as string;
        const messageId = info.id as string;

        if (role === "assistant" && messageId) {
          if (!session.assistantMessageId) {
            session.assistantMessageId = messageId;
            this.broadcastToAgent(agentId, { type: "message.start", messageId });
          }

          // Check for completion
          const time = info.time as Record<string, unknown> | undefined;
          if (time?.completed) {
            const tokens = info.tokens as Record<string, unknown> | undefined;
            const cost = info.cost as number | undefined;
            this.broadcastToAgent(agentId, {
              type: "message.complete",
              messageId,
              tokens,
              cost,
            });

            // Log conversation
            this.logConversation(agentId, session, userText).catch(() => {});

            // Disconnect SSE after message complete
            session.sseAbortController?.abort();
            session.sseAbortController = null;
          }
        }
        break;
      }

      case "message.part.delta": {
        if (!session.assistantMessageId) break;
        const deltaMsgId = properties.messageID as string;
        if (deltaMsgId && deltaMsgId !== session.assistantMessageId) break;

        const partId = properties.partID as string;
        const field = properties.field as string;
        const delta = properties.delta as string;

        if (partId && field && delta !== undefined) {
          // Accumulate streaming parts
          let part = session.streamingParts.get(partId);
          if (part) {
            if (field === "text") {
              part.text = (part.text ?? "") + delta;
            }
          } else {
            part = { id: partId, type: "text", text: field === "text" ? delta : undefined };
            session.streamingParts.set(partId, part);
            session.streamingPartOrder.push(partId);
          }

          this.broadcastToAgent(agentId, { type: "delta", partId, field, delta });
        }
        break;
      }

      case "message.part.updated": {
        if (!session.assistantMessageId) break;
        const partDict = properties.part as Record<string, unknown> | undefined;
        if (!partDict) break;
        const partMsgId = partDict.messageID as string;
        if (partMsgId && partMsgId !== session.assistantMessageId) break;

        const partId = partDict.id as string;
        if (partId) {
          // Update accumulated part
          const part = session.streamingParts.get(partId) ?? { id: partId, type: "text" };
          if (partDict.text !== undefined) part.text = partDict.text as string;
          if (partDict.type !== undefined) part.type = partDict.type as string;
          session.streamingParts.set(partId, part);
          if (!session.streamingPartOrder.includes(partId)) {
            session.streamingPartOrder.push(partId);
          }

          this.broadcastToAgent(agentId, { type: "part.updated", partId, part: partDict });
        }
        break;
      }

      case "session.status": {
        const status = properties.status as Record<string, unknown> | undefined;
        if (status?.type === "idle") {
          this.broadcastToAgent(agentId, { type: "idle" });
        }
        break;
      }
    }
  }

  // --- Conversation Logging ---

  private async logConversation(agentId: string, session: SessionState, userText: string): Promise<void> {
    const now = new Date().toISOString();

    // Build content blocks from accumulated streaming parts
    const contentBlocks = session.streamingPartOrder
      .map((id) => session.streamingParts.get(id))
      .filter(Boolean) as Array<{ id: string; type: string; text?: string; [key: string]: unknown }>;

    const userMessage = {
      id: `msg_user_${Date.now()}`,
      role: "user" as const,
      contentBlocks: [{ type: "text", text: userText }],
      timestamp: now,
    };

    const assistantMessage = {
      id: session.assistantMessageId ?? `msg_asst_${Date.now()}`,
      role: "assistant" as const,
      contentBlocks,
      timestamp: now,
    };

    // Load existing conversation log or create new
    const logPath = conversationLogPath(this.workspacePath, agentId);
    let conversationLog: {
      id: string;
      metadata: Record<string, unknown>;
      messages: Array<Record<string, unknown>>;
    };

    try {
      const file = Bun.file(logPath);
      if (await file.exists()) {
        conversationLog = await file.json();
      } else {
        const metadata = await this.manager.getAgent(this.workspacePath, agentId);
        conversationLog = {
          id: agentId,
          metadata: {
            label: metadata.label,
            specialistId: metadata.specialistId,
            model: metadata.model,
          },
          messages: [],
        };
      }
    } catch {
      const metadata = await this.manager.getAgent(this.workspacePath, agentId);
      conversationLog = {
        id: agentId,
        metadata: {
          label: metadata.label,
          specialistId: metadata.specialistId,
          model: metadata.model,
        },
        messages: [],
      };
    }

    conversationLog.messages.push(userMessage, assistantMessage);

    const dir = path.dirname(logPath);
    await mkdir(dir, { recursive: true });
    await Bun.write(logPath, `${JSON.stringify(conversationLog, null, 2)}\n`);
  }

  // --- Broadcast ---

  private broadcastToAgent(agentId: string, frame: Record<string, unknown>): void {
    const session = this.sessions.get(agentId);
    if (!session) return;
    const data = JSON.stringify(frame);
    for (const ws of session.websockets) {
      try {
        ws.send(data);
      } catch {
        // WebSocket may have closed
      }
    }
  }

  // --- Server Info Persistence ---

  private async persistServerInfo(info: AgentServerInfo): Promise<void> {
    const dir = serverInfoDir(this.workspacePath);
    await mkdir(dir, { recursive: true });
    await Bun.write(serverInfoPath(this.workspacePath), `${JSON.stringify(info, null, 2)}\n`);
  }

  private async removeServerInfo(): Promise<void> {
    try {
      await Bun.file(serverInfoPath(this.workspacePath)).delete();
    } catch {
      // File may already be gone
    }
  }
}