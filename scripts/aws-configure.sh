#!/usr/bin/env bash
# Headless first-run setup: adds an OpenAI provider, creates a support agent,
# creates a host API key, and runs a real (non-mock) end-to-end test.
#
# Usage:
#   AIC_HOST=http://<ip>:8080 AIC_OPENAI_KEY=sk-... ./scripts/aws-configure.sh
#
# Environment variables:
#   AIC_HOST        Base URL of the deployed stack     (required)
#   AIC_OPENAI_KEY  Your OpenAI API key                (required)
#   AIC_ADMIN_EMAIL Admin email     (default: admin@example.com from .env.example)
#   AIC_ADMIN_PASS  Admin password  (required if not set in AIC_ADMIN_PASS)
#                   Read from ~/.ai-chat-deploy.env if not provided

set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[34m→\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

AIC_HOST="${AIC_HOST:-}"
AIC_OPENAI_KEY="${AIC_OPENAI_KEY:-}"

[[ -n "$AIC_HOST" ]] || die "AIC_HOST is required. Example: AIC_HOST=http://1.2.3.4:8080"
[[ -n "$AIC_OPENAI_KEY" ]] || die "AIC_OPENAI_KEY is required."

# Load credentials from the file written by aws-deploy.sh if not provided
if [[ -z "${AIC_ADMIN_PASS:-}" && -f ~/.ai-chat-deploy.env ]]; then
  # shellcheck source=/dev/null
  source ~/.ai-chat-deploy.env 2>/dev/null || true
  AIC_ADMIN_PASS="${ADMIN_PASSWORD:-}"
fi
AIC_ADMIN_EMAIL="${AIC_ADMIN_EMAIL:-${ADMIN_EMAIL:-admin@example.com}}"
AIC_ADMIN_PASS="${AIC_ADMIN_PASS:-}"

[[ -n "$AIC_ADMIN_PASS" ]] || die "Admin password not found. Set AIC_ADMIN_PASS or ensure ~/.ai-chat-deploy.env exists."

COOKIES=$(mktemp)
trap 'rm -f "$COOKIES"' EXIT

req() {
  local method="$1" path="$2"
  shift 2
  curl -sf -b "$COOKIES" -c "$COOKIES" \
    -H "content-type: application/json" \
    -X "$method" \
    "$AIC_HOST$path" "$@"
}

bold "ai-chat first-run setup"
info "Host: $AIC_HOST"
info "Admin: $AIC_ADMIN_EMAIL"

# ── 1. Sign in ─────────────────────────────────────────────────────────────────
bold "Step 1 — Admin sign-in"
req POST /admin/api/auth/login -d "{\"email\":\"$AIC_ADMIN_EMAIL\",\"password\":\"$AIC_ADMIN_PASS\"}" >/dev/null
ok "Signed in"

# ── 2. OpenAI provider ─────────────────────────────────────────────────────────
bold "Step 2 — OpenAI provider"
PROVIDER=$(req POST /admin/api/providers -d "{
  \"name\": \"OpenAI\",
  \"kind\": \"OPENAI\",
  \"credentials\": \"$AIC_OPENAI_KEY\",
  \"defaultModel\": \"gpt-4o-mini\"
}")
PROVIDER_ID=$(echo "$PROVIDER" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
ok "Provider created (id: $PROVIDER_ID)"

# Test that the provider actually reaches OpenAI
info "Testing provider connection..."
TEST_RESULT=$(req POST "/admin/api/providers/$PROVIDER_ID/test" -d "{\"model\":\"gpt-4o-mini\"}" 2>&1 || echo '{"ok":false}')
echo "$TEST_RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); exit(0 if r.get('ok') else 1)" \
  && ok "Provider test passed — gpt-4o-mini reachable" \
  || { info "Provider test response: $TEST_RESULT"; die "Provider test failed. Check your OpenAI API key."; }

# ── 3. Agent ───────────────────────────────────────────────────────────────────
bold "Step 3 — Support agent"
# Get the seeded persona
PERSONA_ID=$(req GET /admin/api/personas | python3 -c "import sys,json; ps=json.load(sys.stdin); print(ps[0]['id'])")
info "Using persona id: $PERSONA_ID"

AGENT=$(req POST /admin/api/agents -d "{
  \"slug\": \"support\",
  \"name\": \"Support\",
  \"personaId\": \"$PERSONA_ID\",
  \"modelRoutes\": [{\"providerId\": \"$PROVIDER_ID\", \"model\": \"gpt-4o-mini\", \"weight\": 100}],
  \"settings\": {
    \"session\": {\"durationSec\": null},
    \"greeting\": {\"mode\": \"LLM\"},
    \"chips\": {\"source\": \"LLM\", \"count\": 3},
    \"farewell\": {\"mode\": \"LLM\"}
  }
}")
AGENT_ID=$(echo "$AGENT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
ok "Agent 'support' created (id: $AGENT_ID)"

# ── 4. Host API key ────────────────────────────────────────────────────────────
bold "Step 4 — Host API key"
API_KEY_RESP=$(req POST /admin/api/api-keys -d '{"name":"backend"}')
HOST_API_KEY=$(echo "$API_KEY_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])")
ok "Host API key created"

# Save to file for the test step
echo "AIC_API_KEY=$HOST_API_KEY" >> ~/.ai-chat-deploy.env
echo "AIC_HOST=$AIC_HOST"        >> ~/.ai-chat-deploy.env

# ── 5. End-to-end test with real LLM ──────────────────────────────────────────
bold "Step 5 — End-to-end test (real LLM call)"
SESSION=$(curl -sf \
  -H "Authorization: Bearer $HOST_API_KEY" \
  -H "content-type: application/json" \
  -X POST "$AIC_HOST/v1/sessions" \
  -d '{"agent":"support","user":{"id":"e2e-test-001","name":"Tester"}}')
TOKEN=$(echo "$SESSION" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
SOCKET_URL=$(echo "$SESSION" | python3 -c "import sys,json; print(json.load(sys.stdin)['socketUrl'])")

ok "Session created"
info "Socket URL: $SOCKET_URL"
info "Token starts with: ${TOKEN:0:20}..."

# Poll for the greeting message (LLM-written, arrives within ~10 s)
info "Waiting for LLM greeting (up to 30 s)..."
for i in $(seq 1 15); do
  MSGS=$(curl -sf \
    -H "Authorization: Bearer $TOKEN" \
    "$AIC_HOST/v1/client/messages" 2>/dev/null || echo '{"messages":[]}')
  MSG_COUNT=$(echo "$MSGS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('messages',[])))")
  if [[ "$MSG_COUNT" -gt 0 ]]; then
    GREETING=$(echo "$MSGS" | python3 -c "import sys,json; msgs=json.load(sys.stdin)['messages']; print(msgs[0].get('body','') if msgs else '')")
    ok "LLM greeting received: \"${GREETING:0:80}...\""
    break
  fi
  [[ $i -lt 15 ]] || die "No greeting received within 30 seconds. Check logs: $AIC_HOST"
  sleep 2
done

# Send a message
curl -sf \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -X POST "$AIC_HOST/v1/client/turns" \
  -d '{"messages":[{"body":"Hello, can you tell me about yourself in one sentence?"}]}' >/dev/null

info "Message sent. Waiting for reply (up to 30 s)..."
for i in $(seq 1 15); do
  MSGS=$(curl -sf \
    -H "Authorization: Bearer $TOKEN" \
    "$AIC_HOST/v1/client/messages" 2>/dev/null || echo '{"messages":[]}')
  REPLY=$(echo "$MSGS" | python3 -c "
import sys, json
msgs = json.load(sys.stdin).get('messages', [])
agent_msgs = [m for m in msgs if m.get('senderType') == 'AGENT' and m.get('kind') not in ('GREETING',)]
print(agent_msgs[-1]['body'] if agent_msgs else '')
" 2>/dev/null || echo "")
  if [[ -n "$REPLY" ]]; then
    ok "Agent reply: \"${REPLY:0:120}...\""
    break
  fi
  [[ $i -lt 15 ]] || die "No reply received within 30 seconds."
  sleep 2
done

# ── 6. Summary ─────────────────────────────────────────────────────────────────
bold "Setup complete!"
echo ""
echo "  Dashboard:    $AIC_HOST/admin"
echo "  Admin email:  $AIC_ADMIN_EMAIL"
echo "  Host API key: $HOST_API_KEY"
echo ""
echo "  All credentials saved to ~/.ai-chat-deploy.env"
echo ""
echo "  To embed the chat widget in a web page:"
echo "    AIC_URL=$AIC_HOST AIC_API_KEY=$HOST_API_KEY AIC_AGENT=support node examples/host-backend/server.mjs"
echo ""
echo "  When you buy a domain, run:"
echo "    scripts/aws-add-domain.sh <your-domain.com>"
