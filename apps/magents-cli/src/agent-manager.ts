import { mkdir } from "node:fs/promises";
import path from "node:path";

import { OrchestrationError } from "./types";

// --- Interfaces ---

export interface OpenCodeClientInterface {
  session: {
    create(params?: {
      directory?: string;
      title?: string;
    }): Promise<{
      data: { id: string; slug: string; title: string };
    }>;
    prompt(params: {
      path: { id: string };
      body: {
        parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
      };
    }): Promise<{
      data?: {
        info: {
          id: string;
          role: string;
          tokens?: { input: number; output: number };
          cost?: number;
        };
        parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
      };
    }>;
    messages(params: {
      path: { id: string };
    }): Promise<{
      data: Array<{
        info: {
          id: string;
          role: string;
          time: { created: number };
        };
        parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
      }>;
    }>;
    delete(params: { path: { id: string } }): Promise<void>;
  };
}

export interface AgentMetadata {
  agentId: string;
  sessionId: string;
  label: string;
  model?: string;
  agent?: string;
  specialistId?: string;
  systemPrompt?: string;
  createdAt: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  parts: unknown[];
  timestamp: string;
  tokens?: { input: number; output: number };
  cost?: number;
}

export interface Conversation {
  agentId: string;
  sessionId: string;
  messages: ConversationMessage[];
}

export interface AgentManagerOptions {
  client: OpenCodeClientInterface;
}

// --- Helpers ---

function generateAgentId(): string {
  const uuid = Bun.randomUUIDv7().replace(/-/g, "");
  // Skip the timestamp prefix (first 12 hex chars) and use the random portion
  return `agent-${uuid.slice(12, 20)}`;
}

function agentsDir(workspacePath: string): string {
  return path.join(workspacePath, ".workspace", "opencode", "agents");
}

function conversationsDir(workspacePath: string): string {
  return path.join(workspacePath, ".workspace", "opencode", "conversations");
}

function agentFilePath(workspacePath: string, agentId: string): string {
  return path.join(agentsDir(workspacePath), `${agentId}.json`);
}

function conversationFilePath(workspacePath: string, agentId: string): string {
  return path.join(conversationsDir(workspacePath), `${agentId}.json`);
}

function extractTextContent(
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>,
): string {
  return parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("");
}

// --- AgentManager ---

export class AgentManager {
  private readonly client: OpenCodeClientInterface;

  constructor(options: AgentManagerOptions) {
    this.client = options.client;
  }

  async createAgent(
    workspacePath: string,
    options: {
      label: string;
      model?: string;
      agent?: string;
      specialistId?: string;
      systemPrompt?: string;
    },
  ): Promise<AgentMetadata> {
    const result = await this.client.session.create({
      directory: workspacePath,
      title: options.label,
    });

    const agentId = generateAgentId();
    const metadata: AgentMetadata = {
      agentId,
      sessionId: result.data.id,
      label: options.label,
      model: options.model,
      agent: options.agent,
      specialistId: options.specialistId,
      systemPrompt: options.systemPrompt,
      createdAt: new Date().toISOString(),
    };

    const dir = agentsDir(workspacePath);
    await mkdir(dir, { recursive: true });
    await Bun.write(
      agentFilePath(workspacePath, agentId),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );

    return metadata;
  }

  async listAgents(workspacePath: string): Promise<AgentMetadata[]> {
    const dir = agentsDir(workspacePath);
    const dirFile = Bun.file(dir);

    // If the directory doesn't exist, return empty
    try {
      const glob = new Bun.Glob("*.json");
      const agents: AgentMetadata[] = [];
      for await (const entry of glob.scan({ cwd: dir })) {
        const file = Bun.file(path.join(dir, entry));
        const raw = await file.text();
        agents.push(JSON.parse(raw) as AgentMetadata);
      }
      return agents;
    } catch {
      return [];
    }
  }

  async getAgent(
    workspacePath: string,
    agentId: string,
  ): Promise<AgentMetadata> {
    const filePath = agentFilePath(workspacePath, agentId);
    const file = Bun.file(filePath);

    if (!(await file.exists())) {
      throw new OrchestrationError(
        "AGENT_NOT_FOUND",
        `Agent "${agentId}" not found.`,
      );
    }

    const raw = await file.text();
    return JSON.parse(raw) as AgentMetadata;
  }

  async removeAgent(
    workspacePath: string,
    agentId: string,
  ): Promise<void> {
    const metadata = await this.getAgent(workspacePath, agentId);

    // Delete the OpenCode session
    await this.client.session.delete({ path: { id: metadata.sessionId } });

    // Remove metadata file
    const metaFile = agentFilePath(workspacePath, agentId);
    const meta = Bun.file(metaFile);
    if (await meta.exists()) {
      await Bun.file(metaFile).delete();
    }

    // Remove conversation file if it exists
    const convFile = conversationFilePath(workspacePath, agentId);
    const conv = Bun.file(convFile);
    if (await conv.exists()) {
      await Bun.file(convFile).delete();
    }
  }

  async sendMessage(
    workspacePath: string,
    agentId: string,
    text: string,
  ): Promise<ConversationMessage> {
    const metadata = await this.getAgent(workspacePath, agentId);

    // Build prompt parts — inject specialist system prompt if present
    const promptParts: Array<{ type: string; text?: string; [key: string]: unknown }> = [];
    if (metadata.systemPrompt) {
      promptParts.push({ type: "text", text: metadata.systemPrompt, synthetic: true });
    }
    promptParts.push({ type: "text", text });

    const result = await this.client.session.prompt({
      path: { id: metadata.sessionId },
      body: {
        parts: promptParts,
      },
    });

    const now = new Date().toISOString();

    // Build user message
    const userMessage: ConversationMessage = {
      role: "user",
      content: text,
      parts: [{ type: "text", text }],
      timestamp: now,
    };

    // Build assistant message
    const responseParts = result.data?.parts ?? [];
    const assistantMessage: ConversationMessage = {
      role: "assistant",
      content: extractTextContent(responseParts),
      parts: responseParts,
      timestamp: now,
      tokens: result.data?.info.tokens,
      cost: result.data?.info.cost,
    };

    // Append to conversation file
    const conversation = await this.loadOrCreateConversation(
      workspacePath,
      agentId,
      metadata.sessionId,
    );
    conversation.messages.push(userMessage, assistantMessage);
    await this.saveConversation(workspacePath, conversation);

    return assistantMessage;
  }

  async getConversation(
    workspacePath: string,
    agentId: string,
  ): Promise<Conversation> {
    const metadata = await this.getAgent(workspacePath, agentId);
    return this.loadOrCreateConversation(
      workspacePath,
      agentId,
      metadata.sessionId,
    );
  }

  private async loadOrCreateConversation(
    workspacePath: string,
    agentId: string,
    sessionId: string,
  ): Promise<Conversation> {
    const filePath = conversationFilePath(workspacePath, agentId);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      const raw = await file.text();
      return JSON.parse(raw) as Conversation;
    }

    return { agentId, sessionId, messages: [] };
  }

  private async saveConversation(
    workspacePath: string,
    conversation: Conversation,
  ): Promise<void> {
    const dir = conversationsDir(workspacePath);
    await mkdir(dir, { recursive: true });
    await Bun.write(
      conversationFilePath(workspacePath, conversation.agentId),
      `${JSON.stringify(conversation, null, 2)}\n`,
    );
  }
}
