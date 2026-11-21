#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p dist/server dist/.openai
npx --yes esbuild@0.25.12 worker/index.mjs --bundle --format=esm --loader:.html=text --outfile=dist/server/index.js
cp .openai/hosting.json dist/.openai/hosting.json
