# @magents/cli

Command-line tool for managing magents development sessions. It handles session lifecycle, port allocation, Cloudflare tunnel management, and git worktree provisioning.

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
  +-- SessionOrchestrator     Central coordinator for all operations
  |     |
  |     +-- FileSessionRegistry      Persists sessions to ~/.magents/sessions.json
  |     +-- SystemPortAllocator      Finds available ports on the system
  |     +-- CloudflareTunnelManager  Spawns and manages cloudflared processes
  |     +-- GitWorktreeManager       Provisions and cleans up git worktrees
  |
  +-- ControlClient / LocalControlTransport
        Bridges the @magents/sdk ControlClient to the local orchestrator
```

| Component | File | Responsibility |
|-----------|------|----------------|
| `SessionOrchestrator` | `src/orchestrator.ts` | Coordinates sessions, tunnels, worktrees, and ports |
| `FileSessionRegistry` | `src/registry.ts` | Persists session records to disk as JSON |
| `SystemPortAllocator` | `src/port-allocator.ts` | Allocates free system ports with collision avoidance |
| `CloudflareTunnelManager` | `src/tunnel.ts` | Manages cloudflared child processes |
| `GitWorktreeManager` | `src/worktree.ts` | Provisions git worktree directories |
| `LocalControlTransport` | `src/control-transport.ts` | Routes SDK commands to the orchestrator in-process |

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

Errors are written to stderr in the format:

```
CODE: Human-readable message
```

## Testing

The test suite contains 48 tests across 3 files.

```bash
# Run all tests
bun test

# Run a specific test file
bun test src/cli.test.ts
bun test src/tunnel.test.ts
bun test src/port-allocator.test.ts

# Type checking
bun run typecheck
```

## Development

### Project Structure

```
apps/magents-cli/
  src/
    cli.ts                 CLI entry point and argument parsing
    cli.test.ts            CLI integration tests
    types.ts               Shared types, interfaces, and error class
    orchestrator.ts        Session orchestration logic
    tunnel.ts              Cloudflare tunnel process management
    tunnel.test.ts         Tunnel manager tests
    port-allocator.ts      System port allocation
    port-allocator.test.ts Port allocator tests
    registry.ts            File-based session persistence
    worktree.ts            Git worktree management
    control-transport.ts   SDK bridge for in-process command routing
  package.json
  tsconfig.json
```

### Dependencies

- `@magents/protocol` -- Shared protocol types and command definitions
- `@magents/sdk` -- ControlClient and transport interfaces
