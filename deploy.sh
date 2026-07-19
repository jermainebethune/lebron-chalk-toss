#!/usr/bin/env bash
#
# Deploy, then email a summary — but only if the deploy actually worked.
#
# The first version of this piped wrangler into tee and chained the notifier
# with &&. That silently reported success on a failed deploy, because the exit
# status of a pipeline is the LAST command's (tee), not wrangler's. Capturing
# the status directly is the fix.
#
# Cloudflare has no "Worker deployed" notification alert type at all — checked
# against every alert type on the account. The only Workers alert is log-based
# observability, which fires on errors, not deployments. Pages has a deploy
# alert group; Workers does not, and connecting Workers Builds does not add one.
# So we send the mail ourselves.
#
# Only fires for `npm run deploy`. A bare `wrangler deploy` skips it.

set -uo pipefail

LOG=/tmp/chalk-deploy.log
HEY="${HOME}/bin/hey"
TO="jermaine@hey.com"
WORKER="chalk-toss"
SITE="https://chalk.jermainebethune.com"
API="https://chalk-toss.jermaine-e7a.workers.dev"

echo "→ deploying ${WORKER}…"
npx wrangler deploy 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}

if [ "$STATUS" -ne 0 ]; then
  echo "✗ deploy failed (exit ${STATUS}) — no email sent"
  exit "$STATUS"
fi

[ -x "$HEY" ] || { echo "✓ deployed. (hey CLI not found at $HEY — no email)"; exit 0; }

VERSION="$(sed -n 's/.*Current Version ID: *//p' "$LOG" | tail -1)"
[ -n "$VERSION" ] || VERSION="(not captured)"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
MSG="$(git log -1 --pretty=%s 2>/dev/null || echo 'no commit message')"
WHEN="$(date '+%Y-%m-%d %H:%M %Z')"

# Check the thing we just shipped actually answers, so the email reports
# reality rather than merely that wrangler exited 0.
HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "${API}/api/health" --max-time 20 || echo 000)"
if [ "$HEALTH" = "200" ]; then
  HEALTH_LINE="live and healthy (HTTP 200)"
else
  HEALTH_LINE="DEPLOYED BUT HEALTH CHECK FAILED (HTTP ${HEALTH}) — check it"
fi

BODY="$(cat <<EOF
${WORKER} deployed at ${WHEN}.

Status:   ${HEALTH_LINE}
Commit:   ${COMMIT} — ${MSG}
Version:  ${VERSION}

Site:     ${SITE}
API:      ${API}

Sent by deploy.sh. Only fires on npm run deploy.
EOF
)"

if "$HEY" compose --to "$TO" --subject "Deployed: ${WORKER} — ${MSG}" -m "$BODY" >/dev/null 2>&1; then
  echo "✓ deployed. Email sent to ${TO}."
else
  echo "✓ deployed. (email failed — deploy itself was fine)"
fi
