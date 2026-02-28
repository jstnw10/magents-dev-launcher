# magents-cli -- Agent Reference (SKILL.md)

CLI for managing dev sessions, AI agent orchestration, and MCP workspace servers. Handles session lifecycle, Cloudflare tunnels, git worktrees, specialist-driven agents, and a 67-tool MCP server.

## Invocation

```sh
bun run apps/magents-cli/src/cli.ts <group> <command> [flags]
```

All output is JSON on stdout. Errors go to stderr as `CODE: message`.
Exit code 0 = success, 1 = error.

## Commands

| Command | Required Flags | Optional Flags | Response Shape |
|---------|---------------|----------------|----------------|
| `session start` | (none) | `--label`, `--project-root`, `--metro-port`, `--tunnel`, `--tunnel-name` + `--domain` | `{ session: SessionSummary }` |
| `session stop` | `--session-id` | (none) | `{ sessionId, stopped }` |
| `session list` | (none) | (none) | `{ sessions: SessionSummary[] }` |
| `session endpoint` | `--session-id` | (none) | `{ sessionId, metroUrl, tunnel: TunnelState }` |
| `tunnel attach` | `--session-id` | `--public-url`, `--tunnel-name` + `--domain` | `{ sessionId, tunnel: TunnelState }` |
| `tunnel detach` | `--session-id` | (none) | `{ sessionId, tunnel: TunnelState }` |
| `tunnel list` | (none) | (none) | `{ tunnels: TunnelInfo[] }` |
| `tunnel status` | `--session-id` | (none) | `{ tunnel: TunnelInfo }` |
| `worktree provision` | `--session-id` | `--source-root`, `--path` | `{ sessionId, path }` |
| `worktree cleanup` | `--session-id` | (none) | `{ sessionId, cleaned }` |
| `agent server-start` | (none) | `--workspace-path` | `{ url, pid }` |
| `agent server-stop` | (none) | `--workspace-path` | `{ stopped }` |
| `agent server-status` | (none) | `--workspace-path` | `{ running, url?, pid? }` |
| `agent create` | (none)* | `--specialist`, `--label`*, `--model`, `--workspace-path` | `{ id, label, model, specialistId? }` |
| `agent send` | `--agent-id`, `--message` | `--workspace-path` | Agent response JSON |
| `agent list` | (none) | `--workspace-path` | `{ agents: AgentMetadata[] }` |
| `agent conversation` | `--agent-id` | `--workspace-path` | Conversation JSON |
| `agent remove` | `--agent-id` | `--workspace-path` | `{ removed, agentId }` |
| `specialist list` | (none) | (none) | Formatted table (not JSON) |
| `specialist add` | (none) | (none) | Interactive editor; `{ added, id }` |
| `specialist remove` | `--name` | (none) | `{ removed, name }` |
| `mcp serve` | (none) | `--workspace-path` | Runs stdio MCP server (blocks) |

## JSON Schemas

```ts
// Session
interface SessionSummary {
  id: string;           // e.g. "sess-m3k7a2-x9f1bc"
  label: string;
  projectRoot: string;
  metroUrl: string;     // "http://127.0.0.1:<port>"
  tunnelUrl?: string;   // present when tunnel is connected
  state: "starting" | "running" | "stopped" | "error";
}

// Tunnel
interface TunnelState {
  connected: boolean;
  provider?: "cloudflare" | "none";
  publicUrl?: string;   // present when connected=true
}

interface TunnelInfo {
  sessionId: string;
  publicUrl: string;
  metroPort: number;
  config: TunnelConfig;
}

type TunnelConfig =
  | { mode: "quick" }
  | { mode: "named"; tunnelName: string; domain: string };
```

## Common Workflows

### 1. Start session with quick tunnel

```sh
bun run apps/magents-cli/src/cli.ts session start --label my-dev --tunnel
```

Parse `session.tunnelUrl` from the JSON output for the public URL.

### 2. Start session with named tunnel

```sh
bun run apps/magents-cli/src/cli.ts session start --label my-dev --tunnel --tunnel-name my-tunnel --domain dev.example.com
```

### 3. Start multiple concurrent sessions

```sh
# Session A (auto-allocates port, starting with 8081)
bun run apps/magents-cli/src/cli.ts session start --label session-a --tunnel
# Session B (auto-allocates a different port)
bun run apps/magents-cli/src/cli.ts session start --label session-b --tunnel
```

### 4. Attach tunnel to existing session

```sh
SID="<session-id-from-start>"
bun run apps/magents-cli/src/cli.ts tunnel attach --session-id "$SID"
```

### 5. List everything and parse output

```sh
# List sessions
bun run apps/magents-cli/src/cli.ts session list
# List tunnels
bun run apps/magents-cli/src/cli.ts tunnel list
# Get specific session endpoint
bun run apps/magents-cli/src/cli.ts session endpoint --session-id "$SID"
```

### 6. Full cleanup

```sh
SID="<session-id>"
# Clean worktree if provisioned
bun run apps/magents-cli/src/cli.ts worktree cleanup --session-id "$SID"
# Stop session (auto-detaches tunnel, releases port)
bun run apps/magents-cli/src/cli.ts session stop --session-id "$SID"
```

## Error Codes

| Code | Cause | Fix |
|------|-------|-----|
| `INVALID_ARGUMENT` | Missing or malformed flag value | Check flag syntax and required values |
| `PORT_IN_USE` | Requested `--metro-port` already assigned | Omit `--metro-port` to auto-allocate |
| `PORT_EXHAUSTED` | No free ports after 10 attempts | Stop unused sessions to free ports |
| `SESSION_NOT_FOUND` | Invalid `--session-id` | Run `session list` to get valid IDs |
| `TUNNEL_NOT_FOUND` | Session has no active tunnel | Attach a tunnel first with `tunnel attach` |
| `WORKTREE_NOT_FOUND` | Session has no managed worktree | Provision a worktree first with `worktree provision` |
| `SPECIALIST_NOT_FOUND` | Invalid specialist name | Run `specialist list` to see available specialists |
| `NO_INTERACTIVE_IO` | Interactive IO unavailable | Only `specialist add` requires interactive mode |
| `OPENCODE_NOT_FOUND` | OpenCode binary not in PATH | Install opencode or use `opencode set-path` |
| `ABORTED` | User cancelled interactive op | Re-run the command |

## Constraints and Gotchas

- `--tunnel-name` and `--domain` must both be provided or both omitted.
- Quick tunnels generate random `*.trycloudflare.com` URLs (non-deterministic).
- `session stop` auto-detaches the tunnel and releases the port.
- Port 8081 is only tried for the first allocation; subsequent allocations pick random ports in 8082-9999.
- `cloudflared` must be installed for tunnel commands (not needed for session/worktree commands without `--tunnel`).
- All CLI output is JSON on stdout, all errors on stderr.
- Exit code 0 = success, 1 = error.
- **MCP server uses stdio transport** — not HTTP. Connect via process spawn, not network requests.
- **`--workspace-path` must be a git repository** — the MCP server and agent commands require a git repo for branch management and workspace isolation.
- **`agent create` requires either `--specialist` or `--label`** — at least one must be provided.
- **`specialist list` outputs a formatted table**, not JSON (unlike all other commands).
- **`mcp serve` blocks** — it runs the MCP server in the foreground over stdio. Use it as a subprocess.
- **`git_stage` refuses wildcard staging** — you must specify individual file paths, not `.`, `*`, `-A`, or `--all`.
- **PR tools auto-detect** — when `pr_number` is omitted, tools detect the PR for the current branch.
- **Note storage is file-based** — data lives in `.workspace/` at the workspace root, not in a database.
- **`noteId="spec"` is special** — it always refers to the workspace specification note.

## MCP Tool Reference

The MCP server (`magents mcp serve`) exposes 67 tools over stdio. Tools are grouped by category.

### Workspace

| Tool | Params | Response |
|------|--------|----------|
| `ping` | (none) | `{ status, workspacePath }` |
| `set_workspace_title` | `title` | `{ title }` |
| `get_workspace_details` | (none) | `{ title, branch, workspacePath, gitRoot }` |
| `set_agent_name` | `agentId`, `name` | `{ agentId, name }` |

### Notes

| Tool | Params | Response |
|------|--------|----------|
| `create_note` | `title`, `content`, `tags?` | `{ noteId, title }` |
| `list_notes` | `tag?` | `{ notes: NoteMetadata[] }` |
| `read_note` | `noteId` | `{ noteId, title, content, lineCount }` |
| `delete_note` | `noteId` | `{ deleted, noteId }` |
| `set_note_content` | `noteId`, `content`, `confirm_replacement?` | `{ noteId, lineCount }` |
| `add_to_note` | `noteId`, `content`, `heading?`, `position?` | `{ noteId, lineCount }` |
| `edit_note` | `noteId`, `old_text`, `new_text` | `{ noteId, lineCount }` |
| `edit_note_lines` | `noteId`, `start_line`, `end_line`, `new_content` | `{ noteId, lineCount }` |
| `update_note_metadata` | `noteId`, `title?`, `tags?` | `{ noteId, title, tags }` |

### Comments

| Tool | Params | Response |
|------|--------|----------|
| `add_note_comment` | `noteId`, `comment`, `searchContext`, `commentTarget`, `author?`, `type?`, `threadId?`, `parentId?` | `{ commentId, threadId }` |
| `list_note_comments` | `noteId`, `includeComments?`, `since?`, `authorType?`, `status?` | `{ threads: ThreadMetadata[] }` |
| `get_comment_thread` | `noteId`, `threadId?`, `commentId?` | `{ thread, comments[] }` |
| `respond_to_comment_thread` | `noteId`, `comment`, `threadId?`, `commentId?`, `author?`, `type?` | `{ commentId, threadId }` |
| `delete_note_comment` | `noteId`, `commentId` | `{ deleted, commentId }` |

### Tasks

| Tool | Params | Response |
|------|--------|----------|
| `list_note_tasks` | `noteId` | `{ tasks: { line, text, status, taskNoteId? }[] }` |
| `update_task` | `noteId`, `lineNumber`, `newText?`, `status?`, `expectedContent?` | `{ noteId, lineNumber }` |
| `update_task_status` | `noteId`, `taskText`, `status` | `{ noteId, taskText }` |
| `mark_as_task` | `noteId`, `status`, `acceptanceCriteria?`, `estimatedEffort?`, `blockedReason?` | `{ noteId, status }` |
| `update_note_task_status` | `noteId`, `status` | `{ noteId, status }` |
| `get_my_task` | `taskNoteId` | `{ noteId, title, content, task: TaskMetadata }` |
| `convert_task_blocks` | `noteId` | `{ noteId, converted }` |
| `create_prerequisite` | `dependentNoteId`, `title`, `content?`, `status?`, `launchAgent?`, `agentModel?`, `agentInstruction?` | `{ noteId, title }` |
| `assign_agent` | `noteId`, `agentId` | `{ noteId, agentId }` |

### Agents

| Tool | Params | Response |
|------|--------|----------|
| `create_agent` | `name`, `initialMessage`, `specialist?`, `model?`, `taskNoteId?`, `createLinkedNote?`, `noteContent?`, `parentNoteId?`, `isBackground?`, `behaviorPrompt?` | `{ agentId, name }` |
| `list_agents` | `status?`, `includeCompleted?` | `{ agents: AgentInfo[] }` |
| `get_agent_status` | `agentId` | `{ agentId, name, status, ... }` |
| `send_message_to_agent` | `agentId`, `message`, `priority?` | `{ agentId, response }` |
| `read_agent_conversation` | `agentId`, `lastN?`, `startTurn?`, `endTurn?`, `includeToolCalls?` | `{ agentId, messages[] }` |
| `delegate_task` | `taskNoteId?`, `noteId?`, `taskText?`, `specialist?`, `model?`, `agentInstructions?`, `behaviorPrompt?`, `wait_mode?`, `skipAutoCommit?` | `{ agentId, taskNoteId }` |
| `send_message_to_task_agent` | `taskNoteId`, `message`, `priority?` | `{ taskNoteId, agentId }` |
| `report_to_parent` | `report` | `{ stored }` |
| `get_agent_summary` | `agentId` | `{ agentId, status, lastResponse, toolCalls }` |
| `wake_or_create_task_agent` | `taskNoteId`, `contextMessage`, `model?` | `{ agentId, created }` |
| `subscribe_to_events` | `eventTypes`, `excludeSelf?`, `batchWindow?` | `{ subscriptionId }` |
| `unsubscribe_from_events` | `subscriptionId` | `{ unsubscribed }` |

### Git

| Tool | Params | Response |
|------|--------|----------|
| `git_status` | (none) | `{ branch, staged[], modified[], untracked[], ahead, behind }` |
| `git_stage` | `paths` | `{ staged[] }` |
| `agent_commit_changes` | `message`, `files?`, `userRequested?` | `{ commitHash, message }` |
| `check_merge_conflicts` | `targetBranch?` | `{ hasConflicts, conflictFiles[] }` |

### PR / GitHub

| Tool | Params | Response |
|------|--------|----------|
| `get_pr_status` | `pr_number?` | `{ number, title, state, mergeable, checks, reviewDecision }` |
| `list_pr_review_comments` | `pr_number?` | `{ threads: ReviewThread[] }` |
| `reply_to_pr_review_comment` | `comment_id`, `body` | `{ commentId, body }` |
| `resolve_pr_review_thread` | `thread_id` | `{ resolved }` |
| `list_pr_comments` | `pr_number?` | `{ comments[] }` |
| `post_pr_comment` | `body`, `pr_number?` | `{ commentId, body }` |
| `update_pr_branch` | `pr_number?` | `{ updated }` |
| `github_api` | `endpoint`, `method?`, `body?` | GitHub API response |

### Primitives

| Tool | Params | Response |
|------|--------|----------|
| `add_reference_primitive` | `noteId`, `semanticId`, `description`, `snapshot?` | `{ noteId }` |
| `add_cli_primitive` | `noteId`, `command`, `description`, `workingDirectory?` | `{ noteId }` |
| `add_patch_primitive` | `noteId`, `filePath`, `diff`, `description` | `{ noteId }` |
| `add_agent_action_primitive` | `noteId`, `agentId`, `goal`, `description` | `{ noteId }` |
| `get_reference_docs` | `topic` | Reference documentation content |

### Events & Timeline

| Tool | Params | Response |
|------|--------|----------|
| `read_timeline` | `limit?`, `type?` | `{ events[] }` |
| `get_recent_files` | `limit?` | `{ files[] }` |
| `get_agent_activity` | `agentId?`, `minutesAgo?` | `{ agents[] }` |
| `get_workspace_summary` | `minutesAgo?` | `{ events, agents, files, git }` |
| `get_directory_changes` | `directory`, `limit?` | `{ changes[] }` |
| `query_events` | `eventType?`, `actorType?`, `actorId?`, `path?`, `minutesAgo?`, `limit?` | `{ events[] }` |

### Cross-Workspace

| Tool | Params | Response |
|------|--------|----------|
| `list_sibling_workspaces` | (none) | `{ workspaces[] }` |
| `read_external_note` | `targetWorkspaceId`, `noteId` | `{ noteId, content }` |
| `list_external_notes` | `targetWorkspaceId` | `{ notes[] }` |

### Terminal

| Tool | Params | Response |
|------|--------|----------|
| `list_terminals` | (none) | `{ terminals[] }` |
| `read_terminal_output` | `terminal_id`, `max_lines?` | `{ output }` |

## Agent Workflows

### 7. Start MCP server and connect an agent

```sh
# Start the MCP server (blocks, communicates over stdio)
bun run apps/magents-cli/src/cli.ts mcp serve --workspace-path /path/to/workspace
```

AI tools connect to this process as an MCP server. The server provides all 67 tools for workspace operations.

### 8. Create and interact with a specialist agent

```sh
# Start the OpenCode server
bun run apps/magents-cli/src/cli.ts agent server-start --workspace-path /path/to/workspace
# Create an implementor agent
bun run apps/magents-cli/src/cli.ts agent create --specialist implementor --workspace-path /path/to/workspace
# Send it a task
AGENT_ID="<agent-id-from-create>"
bun run apps/magents-cli/src/cli.ts agent send --agent-id "$AGENT_ID" --message "Fix the login validation bug"
# Check conversation
bun run apps/magents-cli/src/cli.ts agent conversation --agent-id "$AGENT_ID"
```

### 9. Agent delegation via MCP

When connected as an MCP server, a coordinator agent can delegate tasks:

1. Create a task note: `create_note` → `mark_as_task`
2. Delegate to a specialist: `delegate_task` with `specialist="implementor"`
3. Monitor progress: `get_agent_status`, `read_agent_conversation`
4. Review results: `get_agent_summary`, `report_to_parent`

### 10. Workspace note management via MCP

```
create_note → add_to_note → edit_note → add_note_comment → list_note_comments
```

Notes persist in `.workspace/notes/` as JSON files. Use `noteId="spec"` for the main workspace specification.

### 11. PR review workflow via MCP

```
get_pr_status → list_pr_review_comments → reply_to_pr_review_comment → resolve_pr_review_thread
```

PR tools auto-detect the current branch's PR when `pr_number` is omitted.

## Additional JSON Schemas

```ts
// Agent
interface AgentMetadata {
  id: string;           // e.g. "agent-abc123"
  label: string;
  status: "idle" | "responding" | "completed" | "failed";
  model?: string;
  specialistId?: string;
}

// Specialist
interface SpecialistDefinition {
  id: string;           // e.g. "implementor"
  name: string;         // e.g. "Implementor"
  description: string;
  source: "builtin" | "custom";
  defaultModel?: string;
  systemPrompt: string;
}

// Note
interface NoteMetadata {
  id: string;
  title: string;
  tags: string[];
  createdAt: string;    // ISO 8601
  updatedAt: string;    // ISO 8601
  task?: TaskMetadata;
}

// Task
interface TaskMetadata {
  status: "not_started" | "waiting" | "discussion_needed" | "in_progress" | "review_required" | "complete" | "cancelled";
  acceptanceCriteria?: string[];
  estimatedEffort?: string;
  assignedAgents?: string[];
  dependencies?: string[];
  blockedReason?: string;
}

// Comment
interface NoteComment {
  id: string;
  threadId: string;
  parentId?: string;
  author: string;
  authorType: "user" | "agent";
  type: "comment" | "suggestion" | "question" | "change-request";
  comment: string;
  targetText: string;
  createdAt: string;    // ISO 8601
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAGENTS_CLI_REGISTRY_PATH` | Override session storage file path | `~/.magents/sessions.json` |
