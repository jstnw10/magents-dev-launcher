import type { AgentManager } from "../agent-manager.js";
import type { SpecialistRegistry } from "../specialist-registry.js";

export interface ToolContext {
  workspacePath: string;
  getAgentManager?: () => Promise<{ manager: AgentManager; serverUrl: string }>;
  specialistRegistry?: SpecialistRegistry;
}
