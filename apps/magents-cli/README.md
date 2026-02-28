# @magents/cli

Command-line tool for managing magents development sessions, AI agent orchestration, and MCP workspace servers. It handles session lifecycle, port allocation, Cloudflare tunnel management, git worktree provisioning, specialist-driven agent creation, and a 67-tool MCP server for AI workspace operations.

## Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0+)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (only required for tunnel features)

## Installation

From the monorepo root:

```bash
bun install
```

## Usage

```
magents <group> <command> [options]
```

All commands output JSON to stdout. Errors are printed to stderr in the format `CODE: message`. Exit code is `0` on success, `1` on error.

Run via Bun:

```bash
bun run apps/magents-cli/src/cli.ts session list
```

Or using the package script:

```bash
cd apps/magents-cli
bun start -- session list
```

---

## Command Reference

### Session Commands

#### `session start`

Create a new development session with an allocated metro port.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--label` | string | `session-{timestamp}` | Human-readable session label |
| `--project-root` | string | Current directory | Path to the project root |
| `--metro-port` | number | Auto-allocated | Specific metro port to use |
| `--tunnel` | boolean | `false` | Enable Cloudflare tunnel on creation |
| `--tunnel-name` | string | | Named tunnel identifier (requires `--domain`) |
| `--domain` | string | | Custom domain for named tunnel (requires `--tunnel-name`) |

```bash
# Basic session
magents session start --label my-feature

# Session with specific port and tunnel
magents session start --label my-feature --metro-port 8085 --tunnel

# Session with named tunnel
magents session start --label my-feature --tunnel --tunnel-name my-tunnel --domain dev.example.com
```

Example output:

```json
{
  "session": {
    "id": "sess-m1abc2-x7k9f3",
    "label": "my-feature",
    "projectRoot": "/Users/dev/my-project",
    "metroUrl": "http://127.0.0.1:8081",
    "tunnelUrl": null,
    "state": "running"
  }
}
```

#### `session stop`

Stop a running session. Automatically detaches any active tunnel and releases the allocated port.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--session-id` | string | Yes | Session ID to stop |

```bash
magents session stop --session-id sess-m1abc2-x7k9f3
```

```json
{
  "sessionId": "sess-m1abc2-x7k9f3",
  "stopped": true
}
```

#### `session list`

List all sessions in the registry.

```bash
magents session list
```

```json
{
  "sessions": [
    {
      "id": "sess-m1abc2-x7k9f3",
      "label": "my-feature",
      "projectRoot": "/Users/dev/my-project",
      "metroUrl": "http://127.0.0.1:8081",
      "tunnelUrl": "https://random-words.trycloudflare.com",
      "state": "running"
    }
  ]
}
```

#### `session endpoint`

Get connection endpoints for a session (metro URL and tunnel info).

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--session-id` | string | Yes | Session ID to query |

```bash
magents session endpoint --session-id sess-m1abc2-x7k9f3
```

```json
{
  "sessionId": "sess-m1abc2-x7k9f3",
  "metroUrl": "http://127.0.0.1:8081",
  "tunnel": {
    "connected": true,
    "provider": "cloudflare",
    "publicUrl": "https://random-words.trycloudflare.com"
  }
}
```

---

### Tunnel Commands

#### `tunnel attach`

Attach a Cloudflare tunnel to an existing session.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--session-id` | string | Yes | Session to attach tunnel to |
| `--public-url` | string | No | Use an external URL instead of spawning cloudflared |
| `--tunnel-name` | string | No | Named tunnel identifier (requires `--domain`) |
| `--domain` | string | No | Custom domain (requires `--tunnel-name`) |

```bash
# Quick tunnel (random trycloudflare.com URL)
magents tunnel attach --session-id sess-m1abc2-x7k9f3

# Named tunnel with custom domain
magents tunnel attach --session-id sess-m1abc2-x7k9f3 --tunnel-name my-tunnel --domain dev.example.com

# Manual URL (no cloudflared process spawned)
magents tunnel attach --session-id sess-m1abc2-x7k9f3 --public-url https://my-proxy.example.com
```

```json
{
  "sessionId": "sess-m1abc2-x7k9f3",
  "tunnel": {
    "connected": true,
    "provider": "cloudflare",
    "publicUrl": "https://random-words.trycloudflare.com"
  }
}
```

#### `tunnel detach`

Detach and terminate the tunnel for a session.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--session-id` | string | Yes | Session to detach tunnel from |

```bash
magents tunnel detach --session-id sess-m1abc2-x7k9f3
```

```json
{
  "sessionId": "sess-m1abc2-x7k9f3",
  "tunnel": {
    "connected": false,
    "provider": "none"
  }
}
```

#### `tunnel list`

List all active tunnels across sessions.

```bash
magents tunnel list
```

```json
{
  "tunnels": [
    {
      "sessionId": "sess-m1abc2-x7k9f3",
      "publicUrl": "https://random-words.trycloudflare.com",
      "metroPort": 8081,
      "config": {
        "mode": "quick"
      }
    }
  ]
}
```

#### `tunnel status`

Get detailed tunnel information for a specific session.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--session-id` | string | Yes | Session to query |

```bash
magents tunnel status --session-id sess-m1abc2-x7k9f3
```

```json
{
  "tunnel": {
    "sessionId": "sess-m1abc2-x7k9f3",
    "publicUrl": "https://random-words.trycloudflare.com",
    "metroPort": 8081,
    "config": {
      "mode": "quick"
    }
  }
}
```

---

### Worktree Commands

#### `worktree provision`

Set up a git worktree for a session. Updates the session's `projectRoot` to point at the new worktree path.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--session-id` | string | Yes | Session to provision worktree for |
| `--source-root` | string | No | Source repository root (defaults to session's project root) |
| `--path` | string | No | Custom worktree path (defaults to `{sourceRoot}/.magents/{sessionId}`) |

```bash
magents worktree provision --session-id sess-m1abc2-x7k9f3

# With custom path
magents worktree provision --session-id sess-m1abc2-x7k9f3 --path /tmp/worktrees/my-feature
```

```json
{
  "sessionId": "sess-m1abc2-x7k9f3",
  "path": "/Users/dev/my-project/.magents/sess-m1abc2-x7k9f3"
}
```

#### `worktree cleanup`

Remove the worktree for a session and restore the original project root.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--session-id` | string | Yes | Session to clean up |

```bash
magents worktree cleanup --session-id sess-m1abc2-x7k9f3
```

```json
{
  "sessionId": "sess-m1abc2-x7k9f3",
  "cleaned": true
}
```

---

### Agent Commands

Manage AI agents through an OpenCode server backend. All agent commands accept `--workspace-path` (defaults to current directory).

#### `agent server-start`

Start the OpenCode server for a workspace.

```bash
magents agent server-start --workspace-path /path/to/workspace
```

```json
{
  "url": "http://127.0.0.1:4892",
  "pid": 12345
}
```

#### `agent server-stop`

Stop the OpenCode server for a workspace.

```bash
magents agent server-stop --workspace-path /path/to/workspace
```

```json
{
  "stopped": true
}
```

#### `agent server-status`

Check whether the OpenCode server is running.

```bash
magents agent server-status --workspace-path /path/to/workspace
```

```json
{
  "running": true,
  "url": "http://127.0.0.1:4892",
  "pid": 12345
}
```

#### `agent create`

Create a new agent, optionally from a specialist template.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--specialist` | string | No* | Specialist name to use as template |
| `--label` | string | No* | Human-readable label (*required if no `--specialist`) |
| `--model` | string | No | Model override (defaults to specialist's `defaultModel`) |
| `--workspace-path` | string | No | Workspace path (defaults to cwd) |

```bash
# Create from specialist
magents agent create --specialist implementor --workspace-path /path/to/workspace

# Create with custom label
magents agent create --label "Bug Fixer" --workspace-path /path/to/workspace
```

```json
{
  "id": "agent-abc123",
  "label": "implementor",
  "model": "claude-sonnet-4-20250514",
  "specialistId": "implementor"
}
```

#### `agent send`

Send a message to an agent and get the response.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--agent-id` | string | Yes | Agent ID to message |
| `--message` | string | Yes | Message content |
| `--workspace-path` | string | No | Workspace path |

```bash
magents agent send --agent-id agent-abc123 --message "Fix the login bug"
```

#### `agent list`

List all agents in a workspace.

```bash
magents agent list --workspace-path /path/to/workspace
```

```json
{
  "agents": [
    {
      "id": "agent-abc123",
      "label": "implementor",
      "status": "idle"
    }
  ]
}
```

#### `agent conversation`

Get an agent's conversation history.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--agent-id` | string | Yes | Agent ID to query |
| `--workspace-path` | string | No | Workspace path |

```bash
magents agent conversation --agent-id agent-abc123
```

#### `agent remove`

Remove an agent from the workspace.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--agent-id` | string | Yes | Agent ID to remove |
| `--workspace-path` | string | No | Workspace path |

```bash
magents agent remove --agent-id agent-abc123
```

```json
{
  "removed": true,
  "agentId": "agent-abc123"
}
```

---

### Specialist Commands

Manage specialist templates that define agent roles, system prompts, and model configurations.

#### `specialist list`

List all registered specialists (built-in and custom).

```bash
magents specialist list
```

```
  ID             NAME           SOURCE    DESCRIPTION
  implementor    Implementor    builtin   Focused implementation agent...
  verifier       Verifier       builtin   Code review and verification agent...
```

#### `specialist add`

Interactively create a custom specialist (opens `$EDITOR`).

```bash
magents specialist add
```

#### `specialist remove`

Remove a custom specialist.

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--name` | string | Yes | Specialist ID to remove |

```bash
magents specialist remove --name my-reviewer
```

```json
{
  "removed": true,
  "name": "my-reviewer"
}
```

---

### MCP Server

The MCP (Model Context Protocol) server exposes 67 tools over stdio for AI agent workspace operations. It provides notes, tasks, comments, git operations, agent management, and more.

#### Starting the Server

```bash
magents mcp serve [--workspace-path <path>]
```

The server communicates over **stdio** using the MCP protocol. AI coding tools (Claude Code, OpenCode, etc.) connect to it as an MCP server process.

#### Tool Inventory

All 67 tools organized by category:

##### Workspace (4 tools)

| Tool | Description |
|------|-------------|
| `ping` | Health check for the magents MCP server |
| `set_workspace_title` | Set or update the workspace title. Also renames the git branch to match |
| `get_workspace_details` | Get workspace metadata including title, git branch, and paths |
| `set_agent_name` | Set or update an agent's display name |

##### Notes (9 tools)

| Tool | Description |
|------|-------------|
| `create_note` | Create a new note in the workspace |
| `list_notes` | List all notes in the workspace |
| `read_note` | Read the content of a specific note. Use noteId='spec' for the workspace specification |
| `delete_note` | Delete a note from the workspace |
| `set_note_content` | Replace the entire content of a note |
| `add_to_note` | Add content to an existing note. Supports positioning: end, start, or after a specific heading |
| `edit_note` | Surgically edit a note by replacing specific text (str_replace style) |
| `edit_note_lines` | Edit specific lines in a note by replacing a range of lines |
| `update_note_metadata` | Update the title and/or tags of a note without changing the content |

##### Comments (5 tools)

| Tool | Description |
|------|-------------|
| `add_note_comment` | Add a comment anchored to specific text in a note |
| `list_note_comments` | List comment threads on a note with optional filtering |
| `get_comment_thread` | Get a complete comment thread with all replies |
| `respond_to_comment_thread` | Add a reply to an existing comment thread |
| `delete_note_comment` | Delete a specific comment from a note |

##### Tasks (9 tools)

| Tool | Description |
|------|-------------|
| `list_note_tasks` | List all task checkboxes in a note. Returns task text, status, linked task note IDs, and line numbers |
| `update_task` | Update a specific task line by line number. Can change text, status, or both |
| `update_task_status` | Find a task by matching its text content and update its checkbox status |
| `mark_as_task` | Convert a note into a task by adding task metadata (status, acceptance criteria) |
| `update_note_task_status` | Update the task metadata status on a task note |
| `get_my_task` | Read a task note and return its full content with task metadata |
| `convert_task_blocks` | Convert all task blocks (@@@task or \`\`\`task) in a note into linked Task Notes |
| `create_prerequisite` | Create a new prerequisite task note and link it as a dependency to an existing task |
| `assign_agent` | Assign an existing agent to a task note. Multiple agents can be assigned to the same task |

##### Agents (12 tools)

| Tool | Description |
|------|-------------|
| `create_agent` | Create a new agent. Optionally specify a specialist and/or an initial message |
| `list_agents` | List all agents in the workspace |
| `get_agent_status` | Get the status and metadata of a specific agent |
| `send_message_to_agent` | Send a message to an agent and return the response |
| `read_agent_conversation` | Read an agent's conversation history. Optionally limit to the last N messages |
| `delegate_task` | Delegate a task note to a new agent. Creates an agent, sends the task content, and updates the task note |
| `send_message_to_task_agent` | Send a message to the agent assigned to a task note |
| `report_to_parent` | Store a completion report for an agent. Used by delegated agents to report results |
| `get_agent_summary` | Get a summary of what another agent did, including status, last response, and tool call counts |
| `wake_or_create_task_agent` | Wake an existing agent assigned to a task, or create a new one if none is found |
| `subscribe_to_events` | Subscribe to workspace events. Returns a subscription ID for later unsubscribing |
| `unsubscribe_from_events` | Unsubscribe from workspace events using a subscription ID |

##### Git (4 tools)

| Tool | Description |
|------|-------------|
| `git_status` | Get structured git status: branch, staged/modified/untracked files, ahead/behind counts |
| `git_stage` | Stage specific files for commit. Must specify individual file paths — refuses '.', '*', '-A', '--all' |
| `agent_commit_changes` | Commit changes with a message. Optionally auto-stages specified files |
| `check_merge_conflicts` | Check if merging current branch into a target branch would cause conflicts, without modifying the working tree |

##### PR / GitHub (8 tools)

| Tool | Description |
|------|-------------|
| `get_pr_status` | Get structured PR status: title, state, mergeability, checks, review decision |
| `list_pr_review_comments` | List inline review comment threads on a PR, grouped by thread with resolved/unresolved status |
| `reply_to_pr_review_comment` | Reply to a PR review comment thread by comment ID |
| `resolve_pr_review_thread` | Resolve a PR review thread by its GraphQL thread ID |
| `list_pr_comments` | List general (non-review) comments on a PR |
| `post_pr_comment` | Post a general comment on a PR |
| `update_pr_branch` | Update a PR branch from the base branch (merge upstream changes) |
| `github_api` | Generic GitHub REST API proxy. Escape hatch for any GitHub operation not covered by specific tools |

##### Primitives (5 tools)

| Tool | Description |
|------|-------------|
| `add_reference_primitive` | Add a code reference primitive to a note. Creates a link to specific code in the codebase |
| `add_cli_primitive` | Add a CLI command primitive to a note. Creates an executable command block |
| `add_patch_primitive` | Add a patch primitive to a note. Creates an applyable code diff block |
| `add_agent_action_primitive` | Add an agent action primitive to a note. Creates a triggerable agent task block |
| `get_reference_docs` | Get detailed documentation for workspace features. Available topics: diagrams, ws-blocks, tasks |

##### Events & Timeline (6 tools)

| Tool | Description |
|------|-------------|
| `read_timeline` | Read recent workspace events from the timeline log. Optionally filter by event type |
| `get_recent_files` | Get recently modified files in the workspace based on git history |
| `get_agent_activity` | Get recent agent activity by scanning agent metadata files |
| `get_workspace_summary` | Get a comprehensive summary of workspace activity including events, agents, files, and git status |
| `get_directory_changes` | Get recent changes to files in a specific directory based on git history |
| `query_events` | Query workspace events with advanced filters. All filters are optional |

##### Cross-Workspace (3 tools)

| Tool | Description |
|------|-------------|
| `list_sibling_workspaces` | List other workspaces that share the same git repository |
| `read_external_note` | Read a note from a sibling workspace. Validates the target shares the same git repo |
| `list_external_notes` | List all notes in a sibling workspace |

##### Terminal (2 tools)

| Tool | Description |
|------|-------------|
| `list_terminals` | List active terminal sessions in the workspace. Validates PIDs are still running |
| `read_terminal_output` | Read output from a terminal session. Strips ANSI escape codes and returns the last N lines |

#### Storage Model

The MCP server uses file-based JSON storage in the `.workspace/` directory at the workspace root:

```
.workspace/
  config.json          Workspace metadata (title, branch)
  notes/               Note content and metadata
  comments/            Comment threads per note
  events/              Timeline event logs
  agents/              Agent metadata files
  subscriptions/       Event subscription records
  tasks/               Task metadata
```

#### Architecture

```
magents mcp serve
  |
  +-- McpServer (stdio transport)
        |
        +-- workspace-tools    Workspace metadata, agent naming
        +-- note-tools         CRUD for workspace notes
        +-- comment-tools      Threaded comments on notes
        +-- task-tools         Task management, delegation, prerequisites
        +-- agent-tools        Agent CRUD, messaging, event subscriptions
        +-- git-tools          Git status, staging, commits, merge checks
        +-- pr-tools           GitHub PR status, comments, reviews
        +-- primitive-tools    Code refs, CLI blocks, patches, agent actions
        +-- event-tools        Timeline, activity, file changes, event queries
        +-- cross-workspace-tools  Sibling workspace discovery and note reading
        +-- terminal-tools     Terminal session listing and output reading
        |
        +-- note-storage       File-based note persistence
        +-- comment-storage    File-based comment persistence
        +-- event-storage      Timeline event logging
        +-- subscription-storage  Event subscription tracking
```

---

## Port Allocation

Ports are automatically allocated when `--metro-port` is not specified:

1. The first session attempts port **8081** (React Native default).
2. Subsequent sessions receive a random port in the range **8082--9999**.
3. Each candidate port is checked for system-level availability using `net.createServer()`.
4. Both the session registry and in-memory tracking are consulted to avoid collisions.
5. Up to **10 retries** are attempted before raising a `PORT_EXHAUSTED` error.

When a session is stopped, its port is released back into the pool.

## Tunnel Modes

The CLI supports three ways to expose a session over the network:

### Quick Tunnel

Spawns `cloudflared tunnel --url http://localhost:PORT` and parses the generated `trycloudflare.com` URL from stderr. No Cloudflare account required.

```bash
magents tunnel attach --session-id sess-m1abc2-x7k9f3
```

### Named Tunnel

Uses a pre-configured Cloudflare tunnel with a custom domain. Requires a Cloudflare account and tunnel setup.

```bash
magents tunnel attach --session-id sess-m1abc2-x7k9f3 \
  --tunnel-name my-tunnel --domain dev.example.com
```

Both `--tunnel-name` and `--domain` must be provided together.

### Manual URL

Bypasses cloudflared entirely. Use this when you have your own proxy or tunneling solution.

```bash
magents tunnel attach --session-id sess-m1abc2-x7k9f3 \
  --public-url https://my-proxy.example.com
```

## Architecture

```
magents CLI
  |
  +-- SessionOrchestrator     Central coordinator for session operations
  |     |
  |     +-- FileSessionRegistry      Persists sessions to ~/.magents/sessions.json
  |     +-- SystemPortAllocator      Finds available ports on the system
  |     +-- CloudflareTunnelManager  Spawns and manages cloudflared processes
  |     +-- GitWorktreeManager       Provisions and cleans up git worktrees
  |
  +-- ControlClient / LocalControlTransport
  |     Bridges the @magents/sdk ControlClient to the local orchestrator
  |
  +-- AgentManager              Creates, messages, and manages AI agents
  |     +-- OpenCodeServer      Manages the OpenCode backend server process
  |     +-- OpenCodeClient      HTTP client for OpenCode API
  |
  +-- SpecialistRegistry        Loads built-in and custom specialist definitions
  |
  +-- McpServer (stdio)         67-tool MCP server for AI workspace operations
        +-- NoteStorage         File-based note persistence (.workspace/notes/)
        +-- CommentStorage      File-based comment persistence (.workspace/comments/)
        +-- EventStorage        Timeline event logging (.workspace/events/)
```

| Component | File | Responsibility |
|-----------|------|----------------|
| `SessionOrchestrator` | `src/orchestrator.ts` | Coordinates sessions, tunnels, worktrees, and ports |
| `FileSessionRegistry` | `src/registry.ts` | Persists session records to disk as JSON |
| `SystemPortAllocator` | `src/port-allocator.ts` | Allocates free system ports with collision avoidance |
| `CloudflareTunnelManager` | `src/tunnel.ts` | Manages cloudflared child processes |
| `GitWorktreeManager` | `src/worktree.ts` | Provisions git worktree directories |
| `LocalControlTransport` | `src/control-transport.ts` | Routes SDK commands to the orchestrator in-process |
| `AgentManager` | `src/agent-manager.ts` | Agent CRUD, messaging, and conversation retrieval |
| `SpecialistRegistry` | `src/specialist-registry.ts` | Loads/manages specialist role definitions |
| `OpenCodeServer` | `src/opencode-server.ts` | Start/stop/status for OpenCode backend process |
| `McpServer` | `src/mcp/server.ts` | MCP protocol server with 67 workspace tools |
| `NoteStorage` | `src/mcp/note-storage.ts` | File-based note CRUD in `.workspace/` |
| `CommentStorage` | `src/mcp/comment-storage.ts` | File-based threaded comments per note |
| `EventStorage` | `src/mcp/event-storage.ts` | Timeline event logging and querying |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAGENTS_CLI_REGISTRY_PATH` | `~/.magents/sessions.json` | Override the session registry file location |

### Registry Format

Sessions are persisted to a JSON file:

```json
{
  "version": 1,
  "sessions": [
    {
      "id": "sess-m1abc2-x7k9f3",
      "label": "my-feature",
      "projectRoot": "/Users/dev/my-project",
      "metroPort": 8081,
      "state": "running",
      "tunnel": {
        "connected": true,
        "provider": "cloudflare",
        "publicUrl": "https://random-words.trycloudflare.com"
      },
      "worktree": {
        "sourceRoot": "/Users/dev/my-project",
        "path": "/Users/dev/my-project/.magents/sess-m1abc2-x7k9f3"
      }
    }
  ]
}
```

## Error Codes

| Code | Description |
|------|-------------|
| `INVALID_ARGUMENT` | Missing or invalid flag value |
| `PORT_IN_USE` | The requested metro port is already assigned to an active session |
| `PORT_EXHAUSTED` | No available port found after 10 attempts |
| `SESSION_NOT_FOUND` | The specified session ID does not exist in the registry |
| `TUNNEL_NOT_FOUND` | No active tunnel exists for the specified session |
| `WORKTREE_NOT_FOUND` | The specified session does not have a managed worktree |
| `SPECIALIST_NOT_FOUND` | The specified specialist name does not exist in the registry |
| `NO_INTERACTIVE_IO` | Interactive IO required but not available (e.g., `specialist add`) |
| `OPENCODE_NOT_FOUND` | OpenCode binary not found in PATH |
| `ABORTED` | User aborted an interactive operation |

Errors are written to stderr in the format:

```
CODE: Human-readable message
```

## Testing

The test suite contains 613 tests across 35 files.

```bash
# Run all tests
bun test

# Run a specific test file
bun test src/cli.test.ts
bun test src/tunnel.test.ts
bun test src/port-allocator.test.ts

# Run MCP tool tests
bun test src/mcp/note-tools.test.ts
bun test src/mcp/agent-tools.test.ts
bun test src/mcp/task-tools.test.ts
bun test src/mcp/comment-tools.test.ts
bun test src/mcp/git-tools.test.ts
bun test src/mcp/pr-tools.test.ts

# Type checking
bun run typecheck
```

## Development

### Project Structure

```
apps/magents-cli/
  src/
    cli.ts                   CLI entry point and argument parsing
    types.ts                 Shared types, interfaces, and error class
    orchestrator.ts          Session orchestration logic
    tunnel.ts                Cloudflare tunnel process management
    port-allocator.ts        System port allocation
    registry.ts              File-based session persistence
    worktree.ts              Git worktree management
    control-transport.ts     SDK bridge for in-process command routing
    agent-manager.ts         Agent CRUD, messaging, conversation retrieval
    specialist-registry.ts   Specialist role definitions (built-in + custom)
    opencode-server.ts       OpenCode backend process management
    opencode-client.ts       HTTP client for OpenCode API
    opencode-resolver.ts     Detect/resolve OpenCode binary path
    workspace-manager.ts     Workspace create/list/archive/destroy
    workspace-config.ts      Workspace configuration helpers
    global-config.ts         Global config (~/.magents/config.json)
    init.ts                  Project initialization
    link.ts                  Workspace linking
    convex-sync.ts           Cloud sync via Convex
    mcp/
      server.ts              MCP server entry point and tool registration
      types.ts               Shared MCP types (NoteMetadata, TaskMetadata, etc.)
      utils.ts               Shared MCP utilities (sanitizeId, timestamps)
      workspace-tools.ts     Workspace metadata tools (4 tools)
      note-tools.ts          Note CRUD tools (9 tools)
      comment-tools.ts       Comment thread tools (5 tools)
      task-tools.ts          Task management tools (9 tools)
      agent-tools.ts         Agent interaction tools (12 tools)
      git-tools.ts           Git operations tools (4 tools)
      pr-tools.ts            GitHub PR tools (8 tools)
      primitive-tools.ts     Rich content primitive tools (5 tools)
      event-tools.ts         Timeline and event tools (6 tools)
      cross-workspace-tools.ts  Cross-workspace tools (3 tools)
      terminal-tools.ts      Terminal session tools (2 tools)
      note-storage.ts        File-based note persistence
      comment-storage.ts     File-based comment persistence
      event-storage.ts       Timeline event storage
      subscription-storage.ts  Event subscription tracking
      git-utils.ts           Git helper functions
      reference-docs.ts      Reference documentation content
  package.json
  tsconfig.json
```

### Dependencies

- `@magents/protocol` -- Shared protocol types and command definitions
- `@magents/sdk` -- ControlClient and transport interfaces
- `@modelcontextprotocol/sdk` -- MCP server framework (stdio transport)
- `zod` -- Schema validation for MCP tool parameters
