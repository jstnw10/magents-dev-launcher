#!/usr/bin/env bash
set -euo pipefail

BASE_REF="${1:-${BASE_REF:-}}"
HEAD_REF="${2:-${HEAD_REF:-HEAD}}"

if [[ -z "${BASE_REF}" ]]; then
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    BASE_REF="origin/main"
  elif git rev-parse --verify main >/dev/null 2>&1; then
    BASE_REF="main"
  elif git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    BASE_REF="HEAD~1"
  else
    BASE_REF="HEAD"
  fi
fi

if ! git rev-parse --verify "${BASE_REF}" >/dev/null 2>&1; then
  echo "Unable to resolve base ref: ${BASE_REF}" >&2
  exit 1
fi

if ! git rev-parse --verify "${HEAD_REF}" >/dev/null 2>&1; then
  echo "Unable to resolve head ref: ${HEAD_REF}" >&2
  exit 1
fi

CHANGED_FILES="$(git diff --name-only "${BASE_REF}...${HEAD_REF}")"

full_run=0
target_app=0
target_cli=0
target_dev_launcher=0
target_protocol=0
target_sdk=0

if [[ -z "${CHANGED_FILES}" ]]; then
  full_run=1
else
  while IFS= read -r file; do
    case "${file}" in
      apps/magents/*)
        target_app=1
        ;;
      apps/magents-cli/*)
        target_cli=1
        ;;
      packages/magents-dev-launcher/*)
        target_dev_launcher=1
        ;;
      packages/protocol/*)
        target_protocol=1
        ;;
      packages/sdk/*)
        target_sdk=1
        ;;
      docs/*|README.md|CHANGELOG.md|UPSTREAM.md|.gitignore|.gitattributes|.npmignore)
        ;;
      .github/*|turbo.json|package.json|bun.lock|tooling/*|scripts/ci/*)
        full_run=1
        ;;
      apps/*|packages/*)
        full_run=1
        ;;
      *)
        full_run=1
        ;;
    esac
  done <<< "${CHANGED_FILES}"
fi

# Shared package changes fan out to known dependents.
if [[ "${target_protocol}" -eq 1 ]]; then
  target_sdk=1
  target_cli=1
  target_dev_launcher=1
fi

if [[ "${target_sdk}" -eq 1 ]]; then
  target_cli=1
  target_dev_launcher=1
fi

targets=()
if [[ "${target_app}" -eq 1 ]]; then
  targets+=("@magents/app")
fi
if [[ "${target_cli}" -eq 1 ]]; then
  targets+=("@magents/cli")
fi
if [[ "${target_dev_launcher}" -eq 1 ]]; then
  targets+=("@magents/dev-launcher")
fi
if [[ "${target_protocol}" -eq 1 ]]; then
  targets+=("@magents/protocol")
fi
if [[ "${target_sdk}" -eq 1 ]]; then
  targets+=("@magents/sdk")
fi

target_string="${targets[*]:-}"
has_targets=0
if [[ -n "${target_string}" ]]; then
  has_targets=1
fi

echo "BASE_REF=${BASE_REF}"
echo "HEAD_REF=${HEAD_REF}"
echo "FULL_RUN=${full_run}"
echo "HAS_TARGETS=${has_targets}"
echo "TARGETS=${target_string}"
