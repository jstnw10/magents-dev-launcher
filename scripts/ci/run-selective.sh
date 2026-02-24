#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <lint|test|typecheck|build> [base_ref] [head_ref]" >&2
  exit 1
fi

TASK="$1"
BASE_REF="${2:-${BASE_REF:-}}"
HEAD_REF="${3:-${HEAD_REF:-HEAD}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolved_base_ref=""
resolved_head_ref=""
resolved_full_run="0"
resolved_has_targets="0"
resolved_targets=""

while IFS="=" read -r key value; do
  case "${key}" in
    BASE_REF)
      resolved_base_ref="${value}"
      ;;
    HEAD_REF)
      resolved_head_ref="${value}"
      ;;
    FULL_RUN)
      resolved_full_run="${value}"
      ;;
    HAS_TARGETS)
      resolved_has_targets="${value}"
      ;;
    TARGETS)
      resolved_targets="${value}"
      ;;
  esac
done < <("${SCRIPT_DIR}/changed-targets.sh" "${BASE_REF}" "${HEAD_REF}")

full_run_override="${FULL_RUN:-false}"
force_override="${FORCE:-false}"

run_full=0
if [[ "${resolved_full_run}" == "1" || "${full_run_override}" == "true" || "${full_run_override}" == "1" ]]; then
  run_full=1
fi

use_force=0
if [[ "${force_override}" == "true" || "${force_override}" == "1" ]]; then
  use_force=1
fi

cmd=(bunx turbo run "${TASK}")

if [[ "${run_full}" -eq 1 ]]; then
  echo "Running full repository ${TASK}."
else
  if [[ "${resolved_has_targets}" != "1" || -z "${resolved_targets}" ]]; then
    echo "No matching workspace targets changed between ${resolved_base_ref} and ${resolved_head_ref}; skipping ${TASK}."
    exit 0
  fi

  # shellcheck disable=SC2206
  target_list=(${resolved_targets})
  echo "Running ${TASK} for changed targets: ${resolved_targets}"
  for target in "${target_list[@]}"; do
    cmd+=("--filter=${target}")
  done
fi

if [[ "${use_force}" -eq 1 ]]; then
  cmd+=("--force")
fi

printf 'Command:'
for segment in "${cmd[@]}"; do
  printf ' %q' "${segment}"
done
printf '\n'

"${cmd[@]}"
