// src/agent-server.ts
import { mkdir } from "node:fs/promises";
import path from "node:path";

// src/types.ts
class OrchestrationError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "OrchestrationError";
    this.code = code;
  }
}

// src/prompt-templates.ts
var SPECIALIST_PLACEHOLDER = "{SPECIALIST_ROLE_CONTENT}";
var workspaceTemplate = `# Magents Agent

You are an AI coding assistant with access to the codebase and workspace tools.

## Workspace Tools

You have access to tools for interacting with the workspace:
- File operations: read, write, search files
- Shell commands: run terminal commands
- Notes: read and write workspace notes
- Git: stage, commit, check status

## Guidelines

1. Focus on the workspace context — be aware of what files exist and their structure
2. Use the specification document for planning and documentation
3. Reference specific files when discussing code
4. Be context-aware — responses should be relevant to the current task
5. Make minimal, clean changes that follow existing patterns

## Agent Collaboration

You can delegate tasks to specialist agents:
- **Implementor**: Executes implementation tasks, writes code
- **Verifier**: Reviews work and verifies completeness
- **Coordinator**: Plans work, breaks down tasks, coordinates sub-agents

When delegating, provide clear instructions and acceptance criteria.`;
var taskFocusedTemplate = `${workspaceTemplate}

---

# Task-Focused Agent

You are working on a specific delegated task. Stay focused on your assigned work.

## Guidelines
1. Read your task description carefully
2. Implement only what is asked — no scope creep
3. Follow existing code patterns and conventions
4. Test your changes before reporting completion
5. Report back with a clear summary of what you did`;
var taskLoopTemplate = `# Your Specialist Role

<specialist_role>
${SPECIALIST_PLACEHOLDER}
</specialist_role>

The instructions in <specialist_role> define your primary function. Prioritize them above general guidance.

---

${workspaceTemplate}

---

# Task Loop Agent

You work on a task using a shared markdown note as your working memory.

## Session Flow

**First turn:**
1. Read your task description and acceptance criteria
2. Set status to in-progress
3. Propose your approach or ask clarifying questions

**Every turn:** Update your task note before ending:
- Log file changes
- Record any learnings or mistakes to avoid
- Update progress

## Single-Task Scope (IMPORTANT)

You are assigned ONE task only. When complete:
1. Mark task as complete
2. Report back with a 1-3 sentence summary
3. Do NOT look for other tasks

## Verification

Run verification commands (tests, typecheck, lint) on completion.

---

## Role Reminder

Stay within task scope. No refactors, no scope creep. Report when complete.`;
function getPromptForAgent(systemPrompt) {
  if (systemPrompt && systemPrompt.length > 0) {
    return taskLoopTemplate.replace(SPECIALIST_PLACEHOLDER, systemPrompt);
  }
  return workspaceTemplate;
}

// src/agent-server.ts
var DEFAULT_AGENT_SERVER_PORT = 4097;
function serverInfoDir(workspacePath) {
  return path.join(workspacePath, ".workspace", "agent-manager");
}
function serverInfoPath(workspacePath) {
  return path.join(serverInfoDir(workspacePath), "server.json");
}
function conversationLogPath(workspacePath, agentId) {
  return path.join(workspacePath, ".workspace", "opencode", "conversations", `${agentId}.json`);
}
function extractAgentIdFromPath(pathname) {
  const match = pathname.match(/^\/agent\/([^/]+)/);
  return match ? match[1] : null;
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}
function parseSSEChunk(buffer) {
  const events = [];
  let remainder = buffer;
  while (true) {
    const idx = remainder.indexOf(`

`);
    if (idx === -1)
      break;
    const block = remainder.slice(0, idx);
    remainder = remainder.slice(idx + 2);
    if (!block.trim())
      continue;
    let eventType;
    let data = "";
    for (const line of block.split(`
`)) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).trim();
        if (data)
          data += `
`;
        data += value;
      }
    }
    if (data) {
      events.push({ event: eventType, data });
    }
  }
  return { events, remainder };
}

class AgentServer {
  workspacePath;
  manager;
  openCodeUrl;
  port;
  specialistRegistry;
  server = null;
  sessions = new Map;
  constructor(options) {
    this.workspacePath = options.workspacePath;
    this.manager = options.manager;
    this.openCodeUrl = options.openCodeUrl.replace(/\/$/, "");
    this.port = options.port ?? DEFAULT_AGENT_SERVER_PORT;
    this.specialistRegistry = options.specialistRegistry;
  }
  async start() {
    const self = this;
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      async fetch(req, server) {
        return self.handleRequest(req, server);
      },
      websocket: {
        open(ws) {
          const agentId = ws.data.agentId;
          const session = self.sessions.get(agentId);
          if (session) {
            session.websockets.add(ws);
          }
        },
        async message(ws, message) {
          await self.handleWebSocketMessage(ws, message);
        },
        close(ws) {
          const agentId = ws.data.agentId;
          const session = self.sessions.get(agentId);
          if (session) {
            session.websockets.delete(ws);
            if (session.websockets.size === 0 && session.streamingPartOrder.length > 0) {
              self.logConversation(agentId, session).catch(() => {});
            }
          }
        }
      }
    });
    const info = {
      port: this.port,
      url: `http://127.0.0.1:${this.port}`,
      startedAt: new Date().toISOString()
    };
    await this.persistServerInfo(info);
    return info;
  }
  async stop() {
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
  async handleRequest(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;
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
            streamingParts: new Map,
            streamingPartOrder: [],
            websockets: new Set,
            sseAbortController: null,
            userText: null,
            turnMessageCount: 0,
            completedMessages: [],
            systemPromptSent: false
          });
        }
        const upgraded = server.upgrade(req, { data: { agentId } });
        if (!upgraded) {
          return errorResponse("WebSocket upgrade failed", 500);
        }
        return;
      } catch (err) {
        if (err instanceof OrchestrationError && err.code === "AGENT_NOT_FOUND") {
          return errorResponse(`Agent not found: ${agentId}`, 404);
        }
        throw err;
      }
    }
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
            source: s.source
          }))
        });
      } catch (err) {
        return errorResponse(err.message, 500);
      }
    }
    if (method === "POST" && pathname === "/agent") {
      try {
        const body = await req.json();
        if (!body.label)
          return errorResponse("Missing required field: label");
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
          systemPrompt
        });
        return jsonResponse(metadata, 201);
      } catch (err) {
        return errorResponse(err.message, 500);
      }
    }
    if (method === "GET" && pathname === "/agent") {
      const agents = await this.manager.listAgents(this.workspacePath);
      return jsonResponse({ agents });
    }
    if (method === "GET" && pathname.match(/^\/agent\/[^/]+$/) && !pathname.includes("/conversation")) {
      const agentId = extractAgentIdFromPath(pathname);
      try {
        const metadata = await this.manager.getAgent(this.workspacePath, agentId);
        return jsonResponse(metadata);
      } catch (err) {
        if (err instanceof OrchestrationError && err.code === "AGENT_NOT_FOUND") {
          return errorResponse(`Agent not found: ${agentId}`, 404);
        }
        return errorResponse(err.message, 500);
      }
    }
    if (method === "DELETE" && pathname.match(/^\/agent\/[^/]+$/)) {
      const agentId = extractAgentIdFromPath(pathname);
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
        return errorResponse(err.message, 500);
      }
    }
    if (method === "GET" && pathname.match(/^\/agent\/[^/]+\/conversation$/)) {
      const agentId = extractAgentIdFromPath(pathname);
      try {
        const conversation = await this.manager.getConversation(this.workspacePath, agentId);
        const metadata = await this.manager.getAgent(this.workspacePath, agentId);
        const sourceMessages = conversation.messages;
        const response = {
          id: agentId,
          metadata: {
            label: metadata.label,
            specialistId: metadata.specialistId,
            model: metadata.model
          },
          messages: sourceMessages.map((msg, index) => ({
            id: msg.id ?? `msg_${index}`,
            role: msg.role,
            contentBlocks: msg.contentBlocks ?? msg.parts?.map((p) => ({
              type: p.type ?? "text",
              text: p.text,
              name: p.name,
              input: p.input,
              content: p.content,
              tool_use_id: p.tool_use_id
            })) ?? [{ type: "text", text: msg.content ?? "" }],
            timestamp: msg.timestamp
          }))
        };
        return jsonResponse(response);
      } catch (err) {
        if (err instanceof OrchestrationError && err.code === "AGENT_NOT_FOUND") {
          return errorResponse(`Agent not found: ${agentId}`, 404);
        }
        return errorResponse(err.message, 500);
      }
    }
    return errorResponse("Not found", 404);
  }
  async handleWebSocketMessage(ws, message) {
    const agentId = ws.data.agentId;
    const text = typeof message === "string" ? message : message.toString();
    let parsed;
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
  async handleUserMessage(agentId, text) {
    const session = this.sessions.get(agentId);
    if (!session)
      return;
    console.log(`[AgentServer] handleUserMessage agentId=${agentId} sessionId=${session.sessionId}`);
    const metadata = await this.manager.getAgent(this.workspacePath, agentId);
    const parts = [];
    if (!session.systemPromptSent && metadata.systemPrompt) {
      const resolvedPrompt = getPromptForAgent(metadata.systemPrompt);
      parts.push({ type: "text", text: resolvedPrompt, synthetic: true });
      session.systemPromptSent = true;
    }
    parts.push({ type: "text", text });
    session.userText = text;
    session.assistantMessageId = null;
    session.streamingParts.clear();
    session.streamingPartOrder = [];
    session.turnMessageCount = 0;
    session.completedMessages = [];
    await this.persistUserMessage(agentId, text);
    console.log(`[AgentServer] Subscribing to SSE before POST...`);
    this.ensureSSESubscription(agentId, session);
    const postUrl = `${this.openCodeUrl}/session/${session.sessionId}/message`;
    console.log(`[AgentServer] POST ${postUrl}`);
    try {
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts })
      });
      if (!res.ok) {
        const statusText = res.statusText || `HTTP ${res.status}`;
        const isBusy = res.status === 409 || res.status === 429;
        console.log(`[AgentServer] POST failed: ${res.status} ${statusText} (busy=${isBusy})`);
        const errorMessage = isBusy ? `Session is busy — please wait for the current response to finish (${statusText})` : `Failed to send message: ${statusText}`;
        this.broadcastToAgent(agentId, { type: "error", message: errorMessage });
        return;
      }
      console.log(`[AgentServer] POST response: ${res.status} ${res.statusText}`);
    } catch (err) {
      console.log(`[AgentServer] POST network error: ${err.message}`);
      this.broadcastToAgent(agentId, {
        type: "error",
        message: `Failed to send message to OpenCode: ${err.message}`
      });
      return;
    }
  }
  async persistUserMessage(agentId, text) {
    console.log(`[AgentServer] Persisting user message for ${agentId}`);
    const now = new Date().toISOString();
    const logPath = conversationLogPath(this.workspacePath, agentId);
    let conversationLog;
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
            model: metadata.model
          },
          messages: []
        };
      }
    } catch {
      const metadata = await this.manager.getAgent(this.workspacePath, agentId);
      conversationLog = {
        id: agentId,
        metadata: {
          label: metadata.label,
          specialistId: metadata.specialistId,
          model: metadata.model
        },
        messages: []
      };
    }
    conversationLog.messages.push({
      id: `msg_user_${Date.now()}`,
      role: "user",
      contentBlocks: [{ type: "text", text }],
      timestamp: now
    });
    const dir = path.dirname(logPath);
    await mkdir(dir, { recursive: true });
    await Bun.write(logPath, `${JSON.stringify(conversationLog, null, 2)}
`);
  }
  ensureSSESubscription(agentId, session) {
    if (session.sseAbortController) {
      console.log(`[AgentServer] SSE already subscribed for ${agentId}`);
      return;
    }
    const controller = new AbortController;
    session.sseAbortController = controller;
    const sseUrl = `${this.openCodeUrl}/event`;
    console.log(`[AgentServer] SSE subscribing to ${sseUrl} for ${agentId}`);
    (async () => {
      try {
        const res = await fetch(sseUrl, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal
        });
        if (!res.ok || !res.body) {
          console.log(`[AgentServer] SSE connection failed: ${res.status}`);
          this.broadcastToAgent(agentId, { type: "error", message: `SSE connection failed: ${res.status}` });
          return;
        }
        console.log(`[AgentServer] SSE connected for ${agentId}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder;
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done)
            break;
          buffer += decoder.decode(value, { stream: true });
          const { events, remainder } = parseSSEChunk(buffer);
          buffer = remainder;
          for (const event of events) {
            this.handleSSEEvent(agentId, session, event);
          }
        }
        console.log(`[AgentServer] SSE stream ended for ${agentId}`);
      } catch (err) {
        if (err.name !== "AbortError") {
          console.log(`[AgentServer] SSE error for ${agentId}: ${err.message}`);
          this.broadcastToAgent(agentId, { type: "error", message: `SSE error: ${err.message}` });
        }
      } finally {
        if (session.sseAbortController === controller) {
          session.sseAbortController = null;
        }
      }
    })();
  }
  handleSSEEvent(agentId, session, event) {
    let json;
    try {
      json = JSON.parse(event.data);
    } catch {
      return;
    }
    const eventType = json.type ?? "";
    const properties = json.properties ?? {};
    const eventSessionId = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID;
    console.log(`[AgentServer] SSE event: ${eventType} sessionId=${eventSessionId ?? "none"}`);
    if (eventSessionId && eventSessionId !== session.sessionId) {
      console.log(`[AgentServer] SSE event filtered: eventSessionId=${eventSessionId} !== ${session.sessionId}`);
      return;
    }
    switch (eventType) {
      case "message.updated": {
        const info = properties.info;
        if (!info)
          break;
        const role = info.role;
        const messageId = info.id;
        if (role === "assistant" && messageId) {
          if (!session.assistantMessageId) {
            session.assistantMessageId = messageId;
            this.broadcastToAgent(agentId, { type: "message.start", messageId });
          }
          const time = info.time;
          if (time?.completed) {
            const tokens = info.tokens;
            const cost = info.cost;
            this.broadcastToAgent(agentId, {
              type: "message.complete",
              messageId,
              tokens,
              cost
            });
            const contentBlocks = session.streamingPartOrder.map((id) => session.streamingParts.get(id)).filter(Boolean).map((part) => {
              const block = { type: part.type, text: part.text };
              if (part.type === "tool" || part.type === "tool_use" || part.type === "tool_result") {
                if (part.tool)
                  block.name = part.tool;
                if (part.callID)
                  block.tool_use_id = part.callID;
                if (part.state?.output)
                  block.content = typeof part.state.output === "string" ? part.state.output : JSON.stringify(part.state.output);
                if (part.state?.input)
                  block.input = part.state.input;
                if (part.state?.title)
                  block.title = part.state.title;
                if (part.state?.status)
                  block.status = part.state.status;
              }
              return block;
            });
            session.completedMessages.push({ id: messageId, contentBlocks });
            session.turnMessageCount++;
            session.assistantMessageId = null;
            session.streamingParts = new Map;
            session.streamingPartOrder = [];
            if (session.userText) {
              this.logConversation(agentId, session).catch(() => {});
            }
          }
        }
        break;
      }
      case "message.part.delta": {
        if (!session.assistantMessageId)
          break;
        const deltaMsgId = properties.messageID;
        if (deltaMsgId && deltaMsgId !== session.assistantMessageId)
          break;
        const partId = properties.partID;
        const field = properties.field;
        const delta = properties.delta;
        if (partId && field && delta !== undefined) {
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
        if (!session.assistantMessageId)
          break;
        const partDict = properties.part;
        if (!partDict)
          break;
        const partMsgId = partDict.messageID;
        if (partMsgId && partMsgId !== session.assistantMessageId)
          break;
        const partId = partDict.id;
        if (partId) {
          const part = session.streamingParts.get(partId) ?? { id: partId, type: "text" };
          if (partDict.text !== undefined)
            part.text = partDict.text;
          if (partDict.type !== undefined)
            part.type = partDict.type;
          if (partDict.tool !== undefined)
            part.tool = partDict.tool;
          if (partDict.callID !== undefined)
            part.callID = partDict.callID;
          if (partDict.state !== undefined)
            part.state = partDict.state;
          session.streamingParts.set(partId, part);
          if (!session.streamingPartOrder.includes(partId)) {
            session.streamingPartOrder.push(partId);
          }
          this.broadcastToAgent(agentId, { type: "part.updated", partId, part: partDict });
        }
        break;
      }
      case "session.status": {
        const status = properties.status;
        if (status?.type === "idle") {
          if (session.userText) {
            this.logConversation(agentId, session).catch(() => {});
            session.userText = null;
          }
          this.broadcastToAgent(agentId, { type: "idle" });
          session.sseAbortController?.abort();
          session.sseAbortController = null;
        }
        break;
      }
    }
  }
  async logConversation(agentId, session) {
    const now = new Date().toISOString();
    const userText = session.userText;
    if (!userText)
      return;
    const logMessages = [];
    logMessages.push({
      id: `msg_user_${Date.now()}`,
      role: "user",
      contentBlocks: [{ type: "text", text: userText }],
      timestamp: now
    });
    for (const completed of session.completedMessages) {
      logMessages.push({
        id: completed.id,
        role: "assistant",
        contentBlocks: completed.contentBlocks,
        timestamp: now
      });
    }
    if (session.streamingPartOrder.length > 0) {
      const currentBlocks = session.streamingPartOrder.map((id) => session.streamingParts.get(id)).filter(Boolean).map((part) => {
        const block = { type: part.type, text: part.text };
        if (part.type === "tool" || part.type === "tool_use" || part.type === "tool_result") {
          if (part.tool)
            block.name = part.tool;
          if (part.callID)
            block.tool_use_id = part.callID;
          if (part.state?.output)
            block.content = typeof part.state.output === "string" ? part.state.output : JSON.stringify(part.state.output);
          if (part.state?.input)
            block.input = part.state.input;
          if (part.state?.title)
            block.title = part.state.title;
          if (part.state?.status)
            block.status = part.state.status;
        }
        return block;
      });
      logMessages.push({
        id: session.assistantMessageId ?? `msg_asst_${Date.now()}`,
        role: "assistant",
        contentBlocks: currentBlocks,
        timestamp: now
      });
    }
    const logPath = conversationLogPath(this.workspacePath, agentId);
    let conversationLog;
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
            model: metadata.model
          },
          messages: []
        };
      }
    } catch {
      const metadata = await this.manager.getAgent(this.workspacePath, agentId);
      conversationLog = {
        id: agentId,
        metadata: {
          label: metadata.label,
          specialistId: metadata.specialistId,
          model: metadata.model
        },
        messages: []
      };
    }
    const lastUserIdx = conversationLog.messages.findLastIndex((m) => m.role === "user" && m.contentBlocks?.[0]?.text === userText);
    if (lastUserIdx >= 0) {
      conversationLog.messages = conversationLog.messages.slice(0, lastUserIdx);
    }
    conversationLog.messages.push(...logMessages);
    const dir = path.dirname(logPath);
    await mkdir(dir, { recursive: true });
    await Bun.write(logPath, `${JSON.stringify(conversationLog, null, 2)}
`);
  }
  broadcastToAgent(agentId, frame) {
    const session = this.sessions.get(agentId);
    if (!session)
      return;
    console.log(`[AgentServer] Broadcasting ${frame.type} to ${agentId}`);
    const data = JSON.stringify(frame);
    for (const ws of session.websockets) {
      try {
        ws.send(data);
      } catch {}
    }
  }
  async persistServerInfo(info) {
    const dir = serverInfoDir(this.workspacePath);
    await mkdir(dir, { recursive: true });
    await Bun.write(serverInfoPath(this.workspacePath), `${JSON.stringify(info, null, 2)}
`);
  }
  async removeServerInfo() {
    try {
      await Bun.file(serverInfoPath(this.workspacePath)).delete();
    } catch {}
  }
}
export {
  DEFAULT_AGENT_SERVER_PORT,
  AgentServer
};
