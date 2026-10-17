#!/usr/bin/env bash
# Switches an already-running stack from HTTP on :8080 to HTTPS on the
# given domain. Caddy handles certificate issuance automatically — the only
# requirement is that the domain's A record already points at the Elastic IP.
#
# Usage:
#   AIC_KEY_PATH=~/.ssh/ai-chat-key.pem scripts/aws-add-domain.sh chat.yourdomain.com
#
# Environment variables:
#   AIC_KEY_PATH   Path to the EC2 SSH key  (default: ~/.ssh/ai-chat-key.pem)
#   AIC_HOST_IP    EC2 public IP             (read from ~/.ai-chat-deploy.env if absent)

set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[34m→\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

DOMAIN="${1:-}"
[[ -n "$DOMAIN" ]] || die "Usage: $0 <domain.example.com>"

KEY_PATH="${AIC_KEY_PATH:-$HOME/.ssh/ai-chat-key.pem}"
[[ -f "$KEY_PATH" ]] || die "SSH key not found: $KEY_PATH. Set AIC_KEY_PATH."

# Load IP from saved deploy env if not given
if [[ -z "${AIC_HOST_IP:-}" && -f ~/.ai-chat-deploy.env ]]; then
  AIC_HOST_IP=$(grep '^AIC_HOST=' ~/.ai-chat-deploy.env | head -1 | sed 's|.*//||;s|:.*||' || true)
fi
AIC_HOST_IP="${AIC_HOST_IP:-}"
[[ -n "$AIC_HOST_IP" ]] || die "Cannot determine EC2 IP. Set AIC_HOST_IP or ensure ~/.ai-chat-deploy.env has AIC_HOST=http://<ip>:..."

SSH="ssh -i $KEY_PATH -o StrictHostKeyChecking=no ubuntu@$AIC_HOST_IP"

bold "Adding domain: $DOMAIN → $AIC_HOST_IP"

# Verify DNS resolves to this IP before touching TLS (Caddy would fail anyway)
info "Checking DNS resolution..."
RESOLVED=$(dig +short "$DOMAIN" A 2>/dev/null | head -1 || nslookup "$DOMAIN" 2>/dev/null | grep 'Address:' | tail -1 | awk '{print $2}' || echo "")
if [[ "$RESOLVED" != "$AIC_HOST_IP" ]]; then
  echo "  DNS currently resolves $DOMAIN → ${RESOLVED:-<no answer>}"
  echo "  Expected: $AIC_HOST_IP"
  echo ""
  echo "  Add this DNS record first:"
  echo "    Type: A"
  echo "    Name: $DOMAIN  (or the subdomain part if using Route 53)"
  echo "    Value: $AIC_HOST_IP"
  echo "    TTL: 300"
  echo ""
  read -rp "  Continue anyway (only if DNS is already set and propagation is in progress)? [y/N] " CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || die "Aborted."
fi

info "Updating .env on the remote instance..."
$SSH bash -s -- "$DOMAIN" <<'REMOTE'
DOMAIN="$1"
cd ~/ai-chat
sed -i \
  -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$DOMAIN|" \
  -e "s|^HTTP_PORT=.*|HTTP_PORT=80|" \
  -e "s|^HTTPS_PORT=.*|HTTPS_PORT=443|" \
  -e "s|^PUBLIC_APP_URL=.*|PUBLIC_APP_URL=https://$DOMAIN|" \
  .env
echo "Updated .env:"
grep -E '^(SITE_ADDRESS|HTTP_PORT|HTTPS_PORT|PUBLIC_APP_URL)=' .env
REMOTE

info "Restarting proxy to pick up new config..."
$SSH "cd ~/ai-chat && docker compose restart proxy"

ok "Done!"
echo ""
echo "  Caddy will obtain a certificate from Let's Encrypt automatically."
echo "  Wait ~30 seconds, then open: https://$DOMAIN/admin"
echo ""
echo "  To check Caddy logs: ssh -i $KEY_PATH ubuntu@$AIC_HOST_IP 'docker compose -f ~/ai-chat/docker-compose.yml logs proxy --tail=50'"
