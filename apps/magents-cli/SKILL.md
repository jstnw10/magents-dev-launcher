# magents-cli -- Agent Reference (SKILL.md)

CLI for managing Expo/React Native dev sessions with Cloudflare tunnel support and git worktree isolation.

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

## Constraints and Gotchas

- `--tunnel-name` and `--domain` must both be provided or both omitted.
- Quick tunnels generate random `*.trycloudflare.com` URLs (non-deterministic).
- `session stop` auto-detaches the tunnel and releases the port.
- Port 8081 is only tried for the first allocation; subsequent allocations pick random ports in 8082-9999.
- `cloudflared` must be installed for tunnel commands (not needed for session/worktree commands without `--tunnel`).
- All output is JSON on stdout, all errors on stderr.
- Exit code 0 = success, 1 = error.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAGENTS_CLI_REGISTRY_PATH` | Override session storage file path | `~/.magents/sessions.json` |
