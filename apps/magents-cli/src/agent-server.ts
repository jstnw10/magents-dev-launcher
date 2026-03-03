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
  userText: string | null;
  turnMessageCount: number;
  completedMessages: Array<{ id: string; contentBlocks: Array<Record<string, unknown>> }>;
  systemPromptSent: boolean;
}

type ServerWebSocket = { data: unknown; send(data: string): void };

type WebSocketData = { type: "agent"; agentId: string } | { type: "workspace" };

// --- Helpers ---

export const DEFAULT_AGENT_SERVER_PORT = 4097;

function serverInfoDir(workspacePath: string): string {
  return path.join(workspacePath, ".workspace", "agent-manager");
}

function serverInfoPath(workspacePath: string): string {
  return path.join(serverInfoDir(workspacePath), "server.json");
}

function conversationLogPath(workspacePath: string, agentId: string): string {
  return path.join(workspacePath, ".workspace", "opencode", "conversations", `${agentId}.json`);
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

  // Workspace-level event broadcasting
  private workspaceWebsockets = new Set<ServerWebSocket>();
  private workspaceSSEController: AbortController | null = null;

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
          const data = ws.data as WebSocketData;
          if (data.type === "workspace") {
            self.workspaceWebsockets.add(ws as unknown as ServerWebSocket);
            self.ensureWorkspaceSSESubscription();
            console.log(`[AgentServer] Workspace WebSocket connected (total: ${self.workspaceWebsockets.size})`);
          } else {
            const session = self.sessions.get(data.agentId);
            if (session) {
              session.websockets.add(ws as unknown as ServerWebSocket);
            }
          }
        },
        async message(ws, message) {
          const data = ws.data as WebSocketData;
          if (data.type === "workspace") {
            // Workspace websockets are read-only — no messages expected
            return;
          }
          await self.handleWebSocketMessage(ws as unknown as ServerWebSocket, message);
        },
        close(ws) {
          const data = ws.data as WebSocketData;
          if (data.type === "workspace") {
            self.workspaceWebsockets.delete(ws as unknown as ServerWebSocket);
            console.log(`[AgentServer] Workspace WebSocket disconnected (remaining: ${self.workspaceWebsockets.size})`);
            // Abort workspace SSE if no more clients
            if (self.workspaceWebsockets.size === 0 && self.workspaceSSEController) {
              console.log(`[AgentServer] No workspace clients — aborting workspace SSE`);
              self.workspaceSSEController.abort();
              self.workspaceSSEController = null;
            }
          } else {
            const session = self.sessions.get(data.agentId);
            if (session) {
              session.websockets.delete(ws as unknown as ServerWebSocket);
              // Save conversation when last client disconnects
              if (session.websockets.size === 0 && session.streamingPartOrder.length > 0) {
                self.logConversation(data.agentId, session).catch(() => {});
              }
            }
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

    // Clean up workspace SSE
    this.workspaceSSEController?.abort();
    this.workspaceSSEController = null;
    this.workspaceWebsockets.clear();

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
      // Workspace-level event stream
      if (pathname === "/events") {
        const upgraded = server.upgrade(req, { data: { type: "workspace" } as WebSocketData });
        if (!upgraded) {
          return errorResponse("WebSocket upgrade failed", 500);
        }
        return undefined as unknown as Response;
      }

      // Per-agent WebSocket
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
            userText: null,
            turnMessageCount: 0,
            completedMessages: [],
            systemPromptSent: false,
          });
        }
        const upgraded = server.upgrade(req, { data: { type: "agent", agentId } as WebSocketData });
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
        const metadata = await this.manager.getAgent(this.workspacePath, agentId);

        // Both agent-server and agent-manager now write to the same path,
        // so we can use the manager's conversation directly.
        const sourceMessages = conversation.messages;

        // Transform to the format the Swift client expects
        const response = {
          id: agentId,
          metadata: {
            label: metadata.label,
            specialistId: metadata.specialistId,
            model: metadata.model,
          },
          messages: sourceMessages.map((msg: any, index: number) => ({
            id: msg.id ?? `msg_${index}`,
            role: msg.role,
            contentBlocks: msg.contentBlocks ?? msg.parts?.map((p: any) => ({
              type: p.type ?? "text",
              text: p.text,
              name: p.name,
              input: p.input,
              content: p.content,
              tool_use_id: p.tool_use_id,
            })) ?? [{ type: "text", text: msg.content ?? "" }],
            timestamp: msg.timestamp,
          })),
        };

        return jsonResponse(response);
      } catch (err) {
        if (err instanceof OrchestrationError && err.code === "AGENT_NOT_FOUND") {
          return errorResponse(`Agent not found: ${agentId}`, 404);
        }
        return errorResponse((err as Error).message, 500);
      }
    }

    // GET /session/:id/children — get child sessions of a parent
    if (method === "GET" && pathname.match(/^\/session\/[^/]+\/children$/)) {
      const sessionId = pathname.split("/")[2]
      try {
        const res = await fetch(`${this.openCodeUrl}/session/${sessionId}/children`)
        if (!res.ok) {
          return errorResponse(`Failed to get children: ${res.status}`, res.status)
        }
        const children = await res.json()
        return jsonResponse(children)
      } catch (err) {
        return errorResponse((err as Error).message, 500)
      }
    }

    // GET /session/status — get status of all sessions
    if (method === "GET" && pathname === "/session/status") {
      try {
        const res = await fetch(`${this.openCodeUrl}/session/status`)
        if (!res.ok) {
          return errorResponse(`Failed to get status: ${res.status}`, res.status)
        }
        const status = await res.json()
        return jsonResponse(status)
      } catch (err) {
        return errorResponse((err as Error).message, 500)
      }
    }

    // GET /session — list OpenCode sessions
    if (method === "GET" && pathname === "/session") {
      try {
        const res = await fetch(`${this.openCodeUrl}/session`);
        if (!res.ok) {
          return errorResponse(`Failed to list sessions: ${res.status}`, 500);
        }
        const allSessions = (await res.json()) as Array<{
          id: string;
          directory: string;
          parentID?: string;
          title: string;
          time: { created: number; updated: number };
        }>;

        // Filter to this workspace
        let sessions = allSessions.filter(s => s.directory === this.workspacePath);

        // Optional parentId filter
        const parentId = url.searchParams.get("parentId");
        if (parentId) {
          sessions = sessions.filter(s => s.parentID === parentId);
        }

        return jsonResponse({ sessions });
      } catch (err) {
        return errorResponse((err as Error).message, 500);
      }
    }

    // GET /health — health check with version info
    if (method === "GET" && pathname === "/health") {
      return jsonResponse({ status: "ok", version: 2, features: ["events"] });
    }

    return errorResponse("Not found", 404);
  }

  // --- WebSocket Message Handler ---

  private async handleWebSocketMessage(ws: ServerWebSocket, message: string | Buffer): Promise<void> {
    const agentId = (ws.data as { agentId: string }).agentId;
    const text = typeof message === "string" ? message : message.toString();

    let parsed: { type: string; text?: string; requestID?: string; answers?: string[][] };
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

    if (parsed.type === "question.reply" && parsed.requestID && parsed.answers) {
      try {
        const url = `${this.openCodeUrl}/question/${parsed.requestID}/reply`;
        console.log(`[AgentServer] Question reply: POST ${url}`);
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: parsed.answers }),
        });
        if (!res.ok) {
          console.log(`[AgentServer] Question reply failed: ${res.status}`);
          this.broadcastToAgent(agentId, { type: "error", message: `Question reply failed: ${res.status}` });
        }
      } catch (err) {
        console.log(`[AgentServer] Question reply error: ${(err as Error).message}`);
        this.broadcastToAgent(agentId, { type: "error", message: `Question reply error: ${(err as Error).message}` });
      }
      return;
    }

    if (parsed.type === "question.reject" && parsed.requestID) {
      try {
        const url = `${this.openCodeUrl}/question/${parsed.requestID}/reject`;
        console.log(`[AgentServer] Question reject: POST ${url}`);
        const res = await fetch(url, {
          method: "POST",
        });
        if (!res.ok) {
          console.log(`[AgentServer] Question reject failed: ${res.status}`);
          this.broadcastToAgent(agentId, { type: "error", message: `Question reject failed: ${res.status}` });
        }
      } catch (err) {
        console.log(`[AgentServer] Question reject error: ${(err as Error).message}`);
        this.broadcastToAgent(agentId, { type: "error", message: `Question reject error: ${(err as Error).message}` });
      }
      return;
    }

    ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${parsed.type}` }));
  }

  // --- Core Message Flow ---

  private async handleUserMessage(agentId: string, text: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;

    console.log(`[AgentServer] handleUserMessage agentId=${agentId} sessionId=${session.sessionId}`);

    const metadata = await this.manager.getAgent(this.workspacePath, agentId);

    // Build prompt parts — only prepend system prompt on the first message of the session
    const parts: Array<{ type: string; text?: string; [key: string]: unknown }> = [];
    if (!session.systemPromptSent && metadata.systemPrompt) {
      const resolvedPrompt = getPromptForAgent(metadata.systemPrompt);
      parts.push({ type: "text", text: resolvedPrompt, synthetic: true });
      session.systemPromptSent = true;
    }
    parts.push({ type: "text", text });

    // Store user text for logging when turn completes
    session.userText = text;

    // Reset streaming state for new turn
    session.assistantMessageId = null;
    session.streamingParts.clear();
    session.streamingPartOrder = [];
    session.turnMessageCount = 0;
    session.completedMessages = [];

    // Immediately persist user message to conversation log
    await this.persistUserMessage(agentId, text);

    // Subscribe to SSE BEFORE the POST so we don't miss early events
    console.log(`[AgentServer] Subscribing to SSE before POST...`);
    this.ensureSSESubscription(agentId, session);

    // POST message to OpenCode and check response
    const postUrl = `${this.openCodeUrl}/session/${session.sessionId}/message`;
    console.log(`[AgentServer] POST ${postUrl}`);
    try {
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts }),
      });

      if (!res.ok) {
        const statusText = res.statusText || `HTTP ${res.status}`;
        const isBusy = res.status === 409 || res.status === 429;
        console.log(`[AgentServer] POST failed: ${res.status} ${statusText} (busy=${isBusy})`);
        const errorMessage = isBusy
          ? `Session is busy — please wait for the current response to finish (${statusText})`
          : `Failed to send message: ${statusText}`;
        this.broadcastToAgent(agentId, { type: "error", message: errorMessage });
        return;
      }
      console.log(`[AgentServer] POST response: ${res.status} ${res.statusText}`);
    } catch (err) {
      console.log(`[AgentServer] POST network error: ${(err as Error).message}`);
      this.broadcastToAgent(agentId, {
        type: "error",
        message: `Failed to send message to OpenCode: ${(err as Error).message}`,
      });
      return;
    }

  }

  /**
   * Immediately persist user message to conversation log.
   * This ensures the message survives even if the POST fails or session crashes.
   * The logConversation method's deduplication logic (lines 739-746) will handle
   * removing this entry when the full turn is logged.
   */
  private async persistUserMessage(agentId: string, text: string): Promise<void> {
    console.log(`[AgentServer] Persisting user message for ${agentId}`);
    const now = new Date().toISOString();
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

    // Append user message
    conversationLog.messages.push({
      id: `msg_user_${Date.now()}`,
      role: "user",
      contentBlocks: [{ type: "text", text }],
      timestamp: now,
    });

    const dir = path.dirname(logPath);
    await mkdir(dir, { recursive: true });
    await Bun.write(logPath, `${JSON.stringify(conversationLog, null, 2)}\n`);
  }

  // --- SSE Subscription ---

  private ensureSSESubscription(agentId: string, session: SessionState): void {
    if (session.sseAbortController) {
      console.log(`[AgentServer] SSE already subscribed for ${agentId}`);
      return;
    }

    const controller = new AbortController();
    session.sseAbortController = controller;

    const sseUrl = `${this.openCodeUrl}/event`;
    console.log(`[AgentServer] SSE subscribing to ${sseUrl} for ${agentId}`);

    (async () => {
      try {
        const res = await fetch(sseUrl, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          console.log(`[AgentServer] SSE connection failed: ${res.status}`);
          this.broadcastToAgent(agentId, { type: "error", message: `SSE connection failed: ${res.status}` });
          return;
        }

        console.log(`[AgentServer] SSE connected for ${agentId}`);
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
            this.handleSSEEvent(agentId, session, event);
          }
        }

        console.log(`[AgentServer] SSE stream ended for ${agentId}`);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.log(`[AgentServer] SSE error for ${agentId}: ${(err as Error).message}`);
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

    console.log(`[AgentServer] SSE event: ${eventType} sessionId=${eventSessionId ?? 'none'}`);

    if (eventSessionId && eventSessionId !== session.sessionId) {
      console.log(`[AgentServer] SSE event filtered: eventSessionId=${eventSessionId} !== ${session.sessionId}`);
      return;
    }

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
            // DON'T disconnect SSE here — wait for session.status: idle

            // Save completed message's content blocks
            const contentBlocks = session.streamingPartOrder
              .map((id) => session.streamingParts.get(id))
              .filter(Boolean)
              .map((part: any) => {
                const block: Record<string, unknown> = { type: part.type, text: part.text };
                if (part.type === "tool" || part.type === "tool_use" || part.type === "tool_result") {
                  if (part.tool) block.name = part.tool;
                  if (part.callID) block.tool_use_id = part.callID;
                  if (part.state?.output) block.content = typeof part.state.output === 'string' ? part.state.output : JSON.stringify(part.state.output);
                  if (part.state?.input) block.input = part.state.input;
                  if (part.state?.title) block.title = part.state.title;
                  if (part.state?.status) block.status = part.state.status;
                }
                return block;
              });

            session.completedMessages.push({ id: messageId, contentBlocks });
            session.turnMessageCount++;

            // Reset streaming state for next message in the same turn
            session.assistantMessageId = null;
            session.streamingParts = new Map();
            session.streamingPartOrder = [];

            // Log conversation incrementally on each message complete
            if (session.userText) {
              this.logConversation(agentId, session).catch(() => {});
            }
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
          // Update accumulated part — copy all known fields
          const part = session.streamingParts.get(partId) ?? { id: partId, type: "text" };
          if (partDict.text !== undefined) part.text = partDict.text as string;
          if (partDict.type !== undefined) part.type = partDict.type as string;
          if (partDict.tool !== undefined) part.tool = partDict.tool;
          if (partDict.callID !== undefined) part.callID = partDict.callID;
          if (partDict.state !== undefined) part.state = partDict.state;
          session.streamingParts.set(partId, part);
          if (!session.streamingPartOrder.includes(partId)) {
            session.streamingPartOrder.push(partId);
          }

          this.broadcastToAgent(agentId, { type: "part.updated", partId, part: partDict });
        }
        break;
      }

      case "question.asked": {
        const request = properties as { id: string; sessionID: string; questions: unknown[] };
        this.broadcastToAgent(agentId, {
          type: "question.asked",
          requestID: request.id,
          sessionID: request.sessionID,
          questions: request.questions,
        });
        break;
      }

      case "session.status": {
        const status = properties.status as Record<string, unknown> | undefined;
        if (status?.type === "idle") {
          // Log conversation now that the full turn is complete
          if (session.userText) {
            this.logConversation(agentId, session).catch(() => {});
            session.userText = null;
          }

          this.broadcastToAgent(agentId, { type: "idle" });

          // Disconnect SSE — turn is fully done
          session.sseAbortController?.abort();
          session.sseAbortController = null;
        }
        break;
      }
    }
  }

  // --- Conversation Logging ---

  private async logConversation(agentId: string, session: SessionState): Promise<void> {
    const now = new Date().toISOString();
    const userText = session.userText;
    if (!userText) return; // Nothing to log

    // Build messages array: user message + all completed assistant messages
    const logMessages: Array<Record<string, unknown>> = [];

    // User message
    logMessages.push({
      id: `msg_user_${Date.now()}`,
      role: "user",
      contentBlocks: [{ type: "text", text: userText }],
      timestamp: now,
    });

    // All completed assistant messages in this turn
    for (const completed of session.completedMessages) {
      logMessages.push({
        id: completed.id,
        role: "assistant",
        contentBlocks: completed.contentBlocks,
        timestamp: now,
      });
    }

    // If there are currently streaming parts (not yet completed), add them too
    if (session.streamingPartOrder.length > 0) {
      const currentBlocks = session.streamingPartOrder
        .map((id) => session.streamingParts.get(id))
        .filter(Boolean)
        .map((part: any) => {
          const block: Record<string, unknown> = { type: part.type, text: part.text };
          if (part.type === "tool" || part.type === "tool_use" || part.type === "tool_result") {
            if (part.tool) block.name = part.tool;
            if (part.callID) block.tool_use_id = part.callID;
            if (part.state?.output) block.content = typeof part.state.output === 'string' ? part.state.output : JSON.stringify(part.state.output);
            if (part.state?.input) block.input = part.state.input;
            if (part.state?.title) block.title = part.state.title;
            if (part.state?.status) block.status = part.state.status;
          }
          return block;
        });

      logMessages.push({
        id: session.assistantMessageId ?? `msg_asst_${Date.now()}`,
        role: "assistant",
        contentBlocks: currentBlocks,
        timestamp: now,
      });
    }

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

    // Make idempotent: find and remove any previously logged messages for this turn
    // by looking for the last user message matching the current userText
    const lastUserIdx = conversationLog.messages.findLastIndex(
      (m: any) => m.role === "user" && m.contentBlocks?.[0]?.text === userText,
    );

    if (lastUserIdx >= 0) {
      // Remove the previous snapshot of this turn (user + all assistant messages)
      conversationLog.messages = conversationLog.messages.slice(0, lastUserIdx);
    }

    conversationLog.messages.push(...logMessages);

    const dir = path.dirname(logPath);
    await mkdir(dir, { recursive: true });
    await Bun.write(logPath, `${JSON.stringify(conversationLog, null, 2)}\n`);
  }

  // --- Broadcast ---

  private broadcastToAgent(agentId: string, frame: Record<string, unknown>): void {
    const session = this.sessions.get(agentId);
    if (!session) return;
    console.log(`[AgentServer] Broadcasting ${frame.type} to ${agentId}`);
    const data = JSON.stringify(frame);
    for (const ws of session.websockets) {
      try {
        ws.send(data);
      } catch {
        // WebSocket may have closed
      }
    }
  }

  private broadcastToWorkspace(data: string): void {
    for (const ws of this.workspaceWebsockets) {
      try {
        ws.send(data);
      } catch {
        // WebSocket may have closed
      }
    }
  }

  // --- Workspace SSE Subscription ---

  private ensureWorkspaceSSESubscription(): void {
    if (this.workspaceSSEController) return;

    const controller = new AbortController();
    this.workspaceSSEController = controller;

    const sseUrl = `${this.openCodeUrl}/event`;
    console.log(`[AgentServer] Workspace SSE subscribing to ${sseUrl}`);

    (async () => {
      let reconnectDelay = 1;
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(sseUrl, {
            headers: { Accept: "text/event-stream" },
            signal: controller.signal,
          });

          if (!res.ok || !res.body) {
            console.log(`[AgentServer] Workspace SSE connection failed: ${res.status}`);
            break;
          }

          console.log(`[AgentServer] Workspace SSE connected`);
          reconnectDelay = 1; // Reset on successful connection
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
              // Broadcast raw event data to all workspace websocket clients
              this.broadcastToWorkspace(event.data);
            }
          }

          console.log(`[AgentServer] Workspace SSE stream ended`);
        } catch (err) {
          if ((err as Error).name === "AbortError") break;
          console.log(`[AgentServer] Workspace SSE error: ${(err as Error).message}`);
        }

        // Reconnect with backoff
        if (controller.signal.aborted) break;
        console.log(`[AgentServer] Workspace SSE reconnecting in ${reconnectDelay}s`);
        await new Promise((resolve) => setTimeout(resolve, reconnectDelay * 1000));
        reconnectDelay = Math.min(reconnectDelay * 2, 30);
      }

      if (this.workspaceSSEController === controller) {
        this.workspaceSSEController = null;
      }
    })();
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