#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <@magents/dev-launcher|@magents/protocol|@magents/sdk|all> [version]" >&2
  exit 1
fi

SELECTION="$1"
VERSION_INPUT="${2:-${VERSION:-}}"
DRY_RUN_INPUT="${DRY_RUN:-true}"
NPM_TAG_INPUT="${NPM_TAG:-next}"

if [[ "${SELECTION}" == "all" && -n "${VERSION_INPUT}" ]]; then
  echo "Version override is only supported for single-package releases." >&2
  exit 1
fi

if [[ "${DRY_RUN_INPUT}" != "true" && "${DRY_RUN_INPUT}" != "false" && "${DRY_RUN_INPUT}" != "1" && "${DRY_RUN_INPUT}" != "0" ]]; then
  echo "DRY_RUN must be true/false/1/0." >&2
  exit 1
fi

dry_run="true"
if [[ "${DRY_RUN_INPUT}" == "false" || "${DRY_RUN_INPUT}" == "0" ]]; then
  dry_run="false"
fi

if [[ "${dry_run}" == "false" && -z "${NPM_TOKEN:-}" ]]; then
  echo "NPM_TOKEN is required for non-dry-run publishing." >&2
  exit 1
fi

package_path() {
  case "$1" in
    "@magents/dev-launcher")
      echo "packages/magents-dev-launcher"
      ;;
    "@magents/protocol")
      echo "packages/protocol"
      ;;
    "@magents/sdk")
      echo "packages/sdk"
      ;;
    *)
      echo "Unknown package: $1" >&2
      exit 1
      ;;
  esac
}

verify_package() {
  local package_name="$1"
  echo "Verifying ${package_name}..."
  bunx turbo run lint test typecheck build --filter="${package_name}" --force
}

bump_version_if_requested() {
  local package_dir="$1"
  if [[ -z "${VERSION_INPUT}" ]]; then
    return
  fi

  echo "Setting ${package_dir} version to ${VERSION_INPUT}..."
  (
    cd "${package_dir}"
    npm version "${VERSION_INPUT}" --no-git-tag-version --allow-same-version
  )
}

publish_package() {
  local package_name="$1"
  local package_dir
  package_dir="$(package_path "${package_name}")"

  verify_package "${package_name}"
  bump_version_if_requested "${package_dir}"

  echo "Publishing ${package_name} from ${package_dir} (tag: ${NPM_TAG_INPUT}, dry-run: ${dry_run})..."
  if [[ "${dry_run}" == "true" ]]; then
    (
      cd "${package_dir}"
      npm publish --dry-run --tag "${NPM_TAG_INPUT}"
    )
  else
    (
      cd "${package_dir}"
      npm publish --access public --provenance --tag "${NPM_TAG_INPUT}"
    )
  fi
}

if [[ "${SELECTION}" == "all" ]]; then
  publish_package "@magents/protocol"
  publish_package "@magents/sdk"
  publish_package "@magents/dev-launcher"
else
  publish_package "${SELECTION}"
fi
