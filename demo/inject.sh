#!/usr/bin/env bash
# Cause a demo incident (or clear it), then watch NavFlow correlate it in the console.
#   ./inject.sh error_spike         # 5xx storm
#   ./inject.sh latency             # p99 blows past the timeout
#   ./inject.sh dependency_outage   # the DB dependency goes down
#   ./inject.sh clear               # roll back — faults cleared
set -euo pipefail
scenario="${1:-error_spike}"
curl -s -X POST http://localhost:8080/demo/inject \
  -H 'content-type: application/json' \
  -d "{\"scenario\":\"${scenario}\"}"
echo
