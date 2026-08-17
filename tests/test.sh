#!/bin/bash
set -euo pipefail

mkdir -p /logs/verifier
rm -f /app/releases.duckdb /app/distribution-gateway/data/gateway.json

node /app/distribution-gateway/server.js >/tmp/distribution-gateway.log 2>&1 &
gateway_pid=$!
cleanup() {
  kill "$gateway_pid" 2>/dev/null || true
  wait "$gateway_pid" 2>/dev/null || true
}
trap cleanup EXIT

for attempt in $(seq 1 50); do
  if node -e "fetch('http://127.0.0.1:7070/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    break
  fi
  sleep 0.1
  if [ "$attempt" -eq 50 ]; then
    cat /tmp/distribution-gateway.log >&2 || true
    exit 1
  fi
done

set +e
python3 -m pytest --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py -rA
code=$?
set -e

if [ "$code" -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi

exit "$code"
