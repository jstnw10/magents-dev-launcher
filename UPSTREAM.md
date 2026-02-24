# Upstream Information

This repository is a customized fork of the `expo-dev-launcher` package from the Expo monorepo.

## Source

- **Upstream repo**: https://github.com/expo/expo
- **Commit hash**: `5a2ca2ea2380eedbafe0bbde7703d4f110ad7eaf`
- **Package path**: `packages/expo-dev-launcher/`
- **Local monorepo package path**: `packages/magents-dev-launcher/`
- **SDK version**: 55
- **Original version**: `55.0.8`
- **Fork version**: `55.0.8-magents.1`
- **Date of extraction**: 2026-02-23

## Rebasing Instructions

To pull upstream changes and reapply magents patches:

### 1. Add upstream remote (one-time setup)

```bash
git remote add upstream https://github.com/expo/expo.git
```

### 2. Fetch the upstream commit or branch you want to update to

```bash
git fetch upstream main --depth=1
# Or fetch a specific commit:
# git fetch upstream <commit-hash> --depth=1
```

### 3. Extract the updated package files

```bash
# Create a temporary directory for the upstream source
mkdir /tmp/expo-upstream
cd /tmp/expo-upstream
git clone --depth 1 https://github.com/expo/expo.git .
# Or checkout a specific commit:
# git fetch origin <new-commit-hash> --depth=1 && git checkout <new-commit-hash>

# Copy the upstream files (excluding .git)
rsync -av --exclude='.git' packages/expo-dev-launcher/ /path/to/magents-dev-launcher/packages/magents-dev-launcher/
```

### 4. Review and resolve conflicts

```bash
cd /path/to/magents-dev-launcher
git diff  # Review all changes from upstream

# Restore magents-specific customizations:
# - package.json version should remain as X.Y.Z-magents.N
# - README.md should keep the fork-specific content
# - UPSTREAM.md should be updated with the new commit hash and date
```

### 5. Update this file

After rebasing, update the commit hash and date in this `UPSTREAM.md` file to reflect the new upstream source.

### 6. Bump the fork version

Update `package.json` version to increment the magents suffix (e.g., `55.0.8-magents.2`), or update the base version if the upstream version changed (e.g., `55.1.0-magents.1`).

### 7. Test and commit

```bash
# Run any relevant tests
# Commit with a clear message referencing the upstream commit
git add -A
git commit -m "chore: rebase on upstream expo-dev-launcher <new-commit-hash>"
```
