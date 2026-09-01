#!/usr/bin/env sh
set -eu

: "${CRON_SECRET:?CRON_SECRET is required}"

base_url="${PETRICHOR_CRON_BASE_URL:-https://petrichor.genejm.one}"
curl --fail --silent --show-error \
    --connect-timeout 10 \
    --max-time 60 \
    --header "Authorization: Bearer ${CRON_SECRET}" \
    "${base_url%/}/api/external-source/cron-refresh" \
    >/dev/null
