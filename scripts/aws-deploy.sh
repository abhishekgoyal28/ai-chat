#!/usr/bin/env bash
# Provisions an EC2 instance in ap-south-1, copies the repo, starts the stack,
# and runs the built-in smoke test.
#
# Prerequisites on the machine running this script:
#   - AWS CLI v2 configured (aws configure, or IAM role / env vars)
#   - An existing EC2 key pair, or let this script create one
#   - rsync
#
# Usage:
#   AIC_KEY_NAME=my-key ./scripts/aws-deploy.sh
#   AIC_KEY_NAME=ai-chat-key AIC_INSTANCE_ID=i-0abc123 ./scripts/aws-deploy.sh  # re-deploy to existing instance
#
# Environment variables (all optional — the script picks sensible defaults):
#   AIC_REGION        AWS region              (default: ap-south-1)
#   AIC_KEY_NAME      EC2 key pair name       (default: ai-chat-key; created if absent)
#   AIC_KEY_PATH      Path to the .pem file   (default: ~/.ssh/$AIC_KEY_NAME.pem)
#   AIC_INSTANCE_TYPE EC2 instance type       (default: t3.medium)
#   AIC_INSTANCE_ID   Re-use an existing instance instead of launching one
#   AIC_ELASTIC_IP    Existing Elastic IP allocation ID to associate

set -euo pipefail

REGION="${AIC_REGION:-ap-south-1}"
KEY_NAME="${AIC_KEY_NAME:-ai-chat-key}"
KEY_PATH="${AIC_KEY_PATH:-$HOME/.ssh/$KEY_NAME.pem}"
INSTANCE_TYPE="${AIC_INSTANCE_TYPE:-t3.medium}"
INSTANCE_ID="${AIC_INSTANCE_ID:-}"
ELASTIC_IP_ALLOC="${AIC_ELASTIC_IP:-}"
SG_NAME="ai-chat-sg"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[34m→\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. Sanity checks ───────────────────────────────────────────────────────────
command -v aws   >/dev/null || die "AWS CLI not found. Install from https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
command -v rsync >/dev/null || die "rsync not found. brew install rsync / apt install rsync"
aws sts get-caller-identity --region "$REGION" --output text >/dev/null 2>&1 || die "AWS credentials not configured. Run: aws configure"

bold "ai-chat AWS deployment — region: $REGION"

# ── 1. Key pair ────────────────────────────────────────────────────────────────
bold "Step 1 — EC2 key pair"
if aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$REGION" --output text >/dev/null 2>&1; then
  ok "Key pair '$KEY_NAME' already exists"
  [[ -f "$KEY_PATH" ]] || die "Key pair exists in AWS but $KEY_PATH not found locally. Download it or set AIC_KEY_PATH."
else
  info "Creating key pair '$KEY_NAME'..."
  aws ec2 create-key-pair \
    --key-name "$KEY_NAME" \
    --region "$REGION" \
    --query 'KeyMaterial' \
    --output text > "$KEY_PATH"
  chmod 400 "$KEY_PATH"
  ok "Created and saved to $KEY_PATH"
fi

# ── 2. Security group ──────────────────────────────────────────────────────────
bold "Step 2 — Security group"
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters "Name=isDefault,Values=true" \
  --query 'Vpcs[0].VpcId' --output text)

SG_ID=$(aws ec2 describe-security-groups \
  --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)

if [[ "$SG_ID" == "None" || -z "$SG_ID" ]]; then
  info "Creating security group '$SG_NAME'..."
  SG_ID=$(aws ec2 create-security-group \
    --group-name "$SG_NAME" \
    --description "ai-chat: SSH, HTTP, HTTPS" \
    --vpc-id "$VPC_ID" \
    --region "$REGION" \
    --query 'GroupId' --output text)
  # SSH from anywhere (tighten to your IP in production)
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 22   --cidr 0.0.0.0/0 >/dev/null
  # HTTP/HTTPS for Caddy
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 80   --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 443  --cidr 0.0.0.0/0 >/dev/null
  # Direct HTTP for smoke test before a domain is set
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 8080 --cidr 0.0.0.0/0 >/dev/null
  ok "Created security group $SG_ID"
else
  ok "Reusing security group $SG_ID"
fi

# ── 3. EC2 instance ────────────────────────────────────────────────────────────
bold "Step 3 — EC2 instance"
if [[ -z "$INSTANCE_ID" ]]; then
  info "Finding latest Ubuntu 22.04 AMI in $REGION..."
  AMI_ID=$(aws ec2 describe-images \
    --region "$REGION" \
    --owners 099720109477 \
    --filters \
      "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
      "Name=state,Values=available" \
      "Name=architecture,Values=x86_64" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --output text)
  info "AMI: $AMI_ID"

  # User-data: install Docker + Compose on first boot
  USER_DATA=$(base64 <<'SCRIPT'
#!/bin/bash
set -e
apt-get update -qq
apt-get install -y -qq apt-transport-https ca-certificates curl gnupg lsb-release rsync
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
usermod -aG docker ubuntu
systemctl enable docker
systemctl start docker
touch /var/lib/cloud/instance/docker-ready
SCRIPT
)

  info "Launching $INSTANCE_TYPE instance..."
  INSTANCE_ID=$(aws ec2 run-instances \
    --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --user-data "$USER_DATA" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=ai-chat},{Key=Project,Value=ai-chat}]" \
    --query 'Instances[0].InstanceId' \
    --output text)
  ok "Launched $INSTANCE_ID"
else
  ok "Reusing instance $INSTANCE_ID"
fi

# Wait until running
info "Waiting for instance to be running..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
ok "Instance is running"

# ── 4. Elastic IP ──────────────────────────────────────────────────────────────
bold "Step 4 — Elastic IP"
if [[ -z "$ELASTIC_IP_ALLOC" ]]; then
  info "Allocating Elastic IP..."
  ELASTIC_IP_ALLOC=$(aws ec2 allocate-address \
    --region "$REGION" \
    --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Project,Value=ai-chat}]" \
    --query 'AllocationId' --output text)
  ok "Allocated $ELASTIC_IP_ALLOC"
fi

aws ec2 associate-address \
  --region "$REGION" \
  --instance-id "$INSTANCE_ID" \
  --allocation-id "$ELASTIC_IP_ALLOC" \
  --allow-reassociation >/dev/null
PUBLIC_IP=$(aws ec2 describe-addresses \
  --region "$REGION" \
  --allocation-ids "$ELASTIC_IP_ALLOC" \
  --query 'Addresses[0].PublicIp' --output text)
ok "Elastic IP: $PUBLIC_IP"

SSH="ssh -i $KEY_PATH -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$PUBLIC_IP"

# ── 5. Wait for SSH + Docker ───────────────────────────────────────────────────
bold "Step 5 — Waiting for SSH and Docker"
info "Waiting for SSH (may take ~90 seconds)..."
for i in $(seq 1 30); do
  if $SSH "echo ok" 2>/dev/null; then break; fi
  [[ $i -lt 30 ]] || die "SSH not available after 5 minutes"
  sleep 10
done
ok "SSH is up"

info "Waiting for Docker installation from user-data..."
for i in $(seq 1 18); do
  if $SSH "[ -f /var/lib/cloud/instance/docker-ready ]" 2>/dev/null; then break; fi
  [[ $i -lt 18 ]] || die "Docker did not install within 3 minutes"
  sleep 10
done
ok "Docker is ready"

# ── 6. Copy the repo ────────────────────────────────────────────────────────────
bold "Step 6 — Copying repository"
info "rsyncing $REPO_DIR → ubuntu@$PUBLIC_IP:~/ai-chat ..."
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dashboard/node_modules' \
  --exclude 'sdk/js/node_modules' \
  --exclude 'server/node_modules' \
  --exclude '.env' \
  --exclude '*.pem' \
  -e "ssh -i $KEY_PATH -o StrictHostKeyChecking=no" \
  "$REPO_DIR/" "ubuntu@$PUBLIC_IP:~/ai-chat/"
ok "Repository synced"

# ── 7. Generate .env and start ─────────────────────────────────────────────────
bold "Step 7 — Generating secrets and starting services"
# Generate secrets on the remote machine (openssl is available on Ubuntu)
$SSH bash <<'REMOTE'
cd ~/ai-chat
cp .env.example .env

# Generate secrets
AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')
ADMIN_PASS=$(openssl rand -base64 18 | tr -d '\n/+=')
MYSQL_PASS=$(openssl rand -hex 16)
MYSQL_ROOT_PASS=$(openssl rand -hex 16)

sed -i \
  -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$AUTH_SECRET|" \
  -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$ENCRYPTION_KEY|" \
  -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMIN_PASS|" \
  -e "s|^MYSQL_PASSWORD=.*|MYSQL_PASSWORD=$MYSQL_PASS|" \
  -e "s|^MYSQL_ROOT_PASSWORD=.*|MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASS|" \
  .env

echo "--- .env credentials (save these!) ---"
grep -E '^(ADMIN_EMAIL|ADMIN_PASSWORD|ENCRYPTION_KEY)=' .env
echo "--------------------------------------"

# Fix PUBLIC_APP_URL to the EC2 IP (will be updated when domain is purchased)
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
sed -i "s|^PUBLIC_APP_URL=.*|PUBLIC_APP_URL=http://$PUBLIC_IP:8080|" .env

docker compose up -d --build
REMOTE

ok "Services starting (build + migrations take ~2 minutes)..."

# ── 8. Wait for healthy ────────────────────────────────────────────────────────
bold "Step 8 — Waiting for chat-app to become healthy"
for i in $(seq 1 24); do
  STATUS=$($SSH "docker compose -f ~/ai-chat/docker-compose.yml ps --format json 2>/dev/null | python3 -c \"import sys,json; data=sys.stdin.read().strip(); rows=[json.loads(l) for l in data.split('\n') if l]; print(next((r.get('Health','') for r in rows if 'chat-app' in r.get('Name','')), 'waiting'))\" 2>/dev/null" || echo "waiting")
  if [[ "$STATUS" == "healthy" ]]; then break; fi
  [[ $i -lt 24 ]] || die "chat-app did not become healthy after 4 minutes"
  sleep 10
done
ok "chat-app is healthy"

# ── 9. Smoke test ──────────────────────────────────────────────────────────────
bold "Step 9 — Smoke test"
info "Running built-in smoke test (uses Mock provider)..."
$SSH "docker compose -f ~/ai-chat/docker-compose.yml exec -T chat-app \
  sh -c 'AIC_URL=http://proxy ADMIN_EMAIL=\$ADMIN_EMAIL ADMIN_PASSWORD=\$ADMIN_PASSWORD \
  node dist/tools/smoke-test.js'" && ok "All smoke tests passed" || die "Smoke test failed — check: ssh -i $KEY_PATH ubuntu@$PUBLIC_IP"

# ── 10. Summary ────────────────────────────────────────────────────────────────
bold "Deployment complete"
echo ""
echo "  Dashboard:  http://$PUBLIC_IP:8080/admin"
echo "  SSH:        ssh -i $KEY_PATH ubuntu@$PUBLIC_IP"
echo "  Instance:   $INSTANCE_ID"
echo "  Elastic IP: $PUBLIC_IP (allocation: $ELASTIC_IP_ALLOC)"
echo ""
echo "  Admin credentials are in ~/.ai-chat-deploy.env — keep this safe:"
$SSH "grep -E '^(ADMIN_EMAIL|ADMIN_PASSWORD)=' ~/ai-chat/.env" | tee ~/.ai-chat-deploy.env
echo ""
echo "  Next: run scripts/aws-configure.sh to add your OpenAI key and create an agent."
echo "        AIC_HOST=http://$PUBLIC_IP:8080 AIC_OPENAI_KEY=sk-... scripts/aws-configure.sh"
