#!/bin/bash
set -euo pipefail

install -d /app/publisher
install -m 0644 /solution/release-publisher.mjs /app/publisher/release-publisher.mjs
