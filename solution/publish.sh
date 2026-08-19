#!/bin/bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
install -d /app/publisher
install -m 0644 "$script_dir/release-publisher.mjs" /app/publisher/release-publisher.mjs
