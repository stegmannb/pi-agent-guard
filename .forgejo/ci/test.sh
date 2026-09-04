#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

pnpm install --frozen-lockfile --ignore-scripts
npm_config_script_shell="$(command -v bash)"
export npm_config_script_shell
npm run --ignore-scripts verify
