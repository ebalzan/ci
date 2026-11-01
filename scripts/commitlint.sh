#!/usr/bin/env bash
#
# commitlint.sh [commitlint args…] — commitlint with THE rule
# (commitlint.config.mjs), from this repo's installed root package. The PR
# check's "Conventional title" and "Conventional commits" steps
# (actions/pr-checks) run it.
set -euo pipefail

ci_root="$(dirname "${BASH_SOURCE[0]}")/.."
exec "$ci_root/node_modules/.bin/commitlint" --config "$ci_root/commitlint.config.mjs" "$@"
