# Developer Workflow: Parallel Worktrees, Tunnels, and Selective CI

This runbook covers local multi-session development and Wave 3 CI/release wiring.

## 1. Create parallel git worktrees

From the repository root:

```bash
git worktree add ../magents-session-a -b feat/session-a
git worktree add ../magents-session-b -b feat/session-b
```

Use one worktree per parallel session so each branch can run independently.

## 2. Share a CLI registry across sessions

`@magents/cli` stores session state in `MAGENTS_CLI_REGISTRY_PATH`. Point both worktrees to the same file:

```bash
export MAGENTS_CLI_REGISTRY_PATH="$PWD/.magents/sessions.json"
```

Optional tunnel domain override:

```bash
export MAGENTS_TUNNEL_DOMAIN="trycloudflare.com"
```

## 3. Start two sessions (one per worktree)

In worktree A:

```bash
cd ../magents-session-a
MAGENTS_CLI_REGISTRY_PATH="$MAGENTS_CLI_REGISTRY_PATH" \
  bun run --filter @magents/cli start -- \
  session start --label device-a --project-root "$PWD" --metro-port 8081 --tunnel
```

In worktree B:

```bash
cd ../magents-session-b
MAGENTS_CLI_REGISTRY_PATH="$MAGENTS_CLI_REGISTRY_PATH" \
  bun run --filter @magents/cli start -- \
  session start --label device-b --project-root "$PWD" --metro-port 8082 --tunnel
```

List and inspect session endpoints from either worktree:

```bash
MAGENTS_CLI_REGISTRY_PATH="$MAGENTS_CLI_REGISTRY_PATH" \
  bun run --filter @magents/cli start -- session list

MAGENTS_CLI_REGISTRY_PATH="$MAGENTS_CLI_REGISTRY_PATH" \
  bun run --filter @magents/cli start -- session endpoint --session-id <session-id>
```

## 4. Worktree and tunnel lifecycle hooks

Provision/cleanup hooks:

```bash
MAGENTS_CLI_REGISTRY_PATH="$MAGENTS_CLI_REGISTRY_PATH" \
  bun run --filter @magents/cli start -- worktree provision --session-id <session-id> --source-root "$PWD"

MAGENTS_CLI_REGISTRY_PATH="$MAGENTS_CLI_REGISTRY_PATH" \
  bun run --filter @magents/cli start -- worktree cleanup --session-id <session-id>
```

Tunnel attach/detach:

```bash
MAGENTS_CLI_REGISTRY_PATH="$MAGENTS_CLI_REGISTRY_PATH" \
  bun run --filter @magents/cli start -- tunnel attach --session-id <session-id>

MAGENTS_CLI_REGISTRY_PATH="$MAGENTS_CLI_REGISTRY_PATH" \
  bun run --filter @magents/cli start -- tunnel detach --session-id <session-id>
```

Note: current `worktree` commands are orchestration hooks and do not run full `git worktree` lifecycle operations.

## 5. Run selective CI locally

Preview changed-target selection:

```bash
./scripts/ci/changed-targets.sh origin/main HEAD
```

Run selective checks:

```bash
./scripts/ci/run-selective.sh lint origin/main HEAD
./scripts/ci/run-selective.sh test origin/main HEAD
FORCE=true ./scripts/ci/run-selective.sh typecheck origin/main HEAD
```

Force a full local run regardless of changed targets:

```bash
FULL_RUN=true ./scripts/ci/run-selective.sh lint origin/main HEAD
FULL_RUN=true ./scripts/ci/run-selective.sh test origin/main HEAD
FULL_RUN=true FORCE=true ./scripts/ci/run-selective.sh typecheck origin/main HEAD
```

## 6. Release reusable packages

Use GitHub Actions workflow **Release Packages** (`.github/workflows/release-packages.yml`):

- `package`: `@magents/dev-launcher`, `@magents/protocol`, `@magents/sdk`, or `all`
- `dry_run`: default `true`
- `npm_tag`: default `next`
- `version`: optional semver override for single-package releases

The workflow runs package-scoped `lint/test/typecheck/build` (with `--force`) before `npm publish`.
