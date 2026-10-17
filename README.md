# ai-chat

**A self-hostable AI chat platform you plug into any product.** Your backend starts a conversation for a signed-in user; your web or mobile app chats in real time over a WebSocket; operators shape every agent — persona, prompts, knowledge, models, session rules — from a built-in dashboard, without deploys.

- **Real-time and reliable.** WebSocket delivery with acknowledgements, a durable queue between every hop, idempotent processing end to end, and resync after reconnects — no lost or duplicated messages.
- **Any model, including fully offline.** OpenAI, Anthropic (Claude), Google Gemini and Vertex AI, and any OpenAI-compatible server (Ollama, vLLM, LM Studio, gateways). Split traffic between models for A/B tests.
- **Built for conversation.** Batches what a user types in one go into a single turn, answers one turn at a time with full context, reveals multi-bubble replies like a person typing, offers suggestions, writes greetings and goodbyes, and can trigger actions in your product.
- **Sessions your way.** Conversations that never end, or ones with a fixed time limit that close with a goodbye written by the model.
- **Operable.** Admin dashboard, revision history with one-click restore, per-reply model/latency/token metadata, Prometheus metrics, health checks, data retention and per-user erasure.
- **Self-hosted.** One Docker image, MySQL and Redis. Runs on a single VM with Docker Compose or on Kubernetes with the included Helm chart. Amazon SQS is supported as an alternative queue.

Licensed under [Apache-2.0](LICENSE).

---

## Contents

1. [How it works](#how-it-works)
2. [Repository layout](#repository-layout)
3. [Quick start (Docker Compose)](#quick-start-docker-compose)
4. [First-run setup](#first-run-setup)
5. [Integrating your product](#integrating-your-product)
6. [Deploying to production](#deploying-to-production)
7. [Configuration reference](#configuration-reference)
8. [Operations](#operations)
9. [Development](#development)
10. [Security](#security)

Further reading: [docs/architecture.html](docs/architecture.html) (interactive walkthrough of every flow) · [docs/client-protocol.md](docs/client-protocol.md) (WebSocket and client API, for building SDKs for other platforms) · [docs/host-api.md](docs/host-api.md) (host API and webhooks).

---

## How it works

Three services, built from one image, share MySQL and Redis:

| Service | Role | Port |
|---|---|---|
| **chat-app** | Host API, client API, admin API and dashboard (`/admin`). Persists every message and drives the conversation: batching into turns, dispatching generations, revealing replies, ending sessions, webhooks. | 3000 |
| **chat-socket** | The WebSocket gateway. Authenticates clients, forwards their turns to a queue, and pushes server frames to them. No database. | 3001 |
| **chat-expert** | The only service that talks to models. Builds the prompt from the agent's configuration and returns structured replies. | 3002 |

```
 Your backend ──POST /v1/sessions (API key)──▶ chat-app ──▶ token
                                                   │
 Your app ──WebSocket (token)──▶ chat-socket ──queue: inbound──▶ chat-app ──queue: generation-requests──▶ chat-expert ──▶ LLM
     ▲                               ▲                              │  ▲                                        │
     └────────── frames ─────────────┘◀──── Redis pub/sub ──────────┘  └──── queue: generation-responses ◀──────┘
```

One user turn, end to end:

1. The SDK batches the user's quick messages into one **turn** and sends it over the socket; chat-socket validates it, queues it durably and acknowledges (first tick).
2. chat-app stores the messages (second tick: `turn.persisted`), shows the typing indicator, and — if no other reply is generating for this conversation — sends a generation request with the recent history, user details, host context and the actions the agent may take.
3. chat-expert assembles the prompt (master → domain → persona → language → knowledge → context → user), calls the model with a strict output schema (reply bubbles, optional suggestions, optional action) and returns the result.
4. chat-app stores the reply bubbles and schedules each one's reveal; the reveal step publishes them in order over Redis to whichever chat-socket holds the user's connection. If nobody is connected, the reply can go out as a push notification.
5. Messages that arrived while the reply was generating are answered next, together, with that reply in context.

Every hop is at-least-once with idempotent handling, so retries and redeliveries never duplicate a message. See [docs/architecture.html](docs/architecture.html) for every flow in detail.

---

## Repository layout

```
server/            The three services (NestJS, TypeScript)
  src/chat-app/      host API, client API, admin API, conversation engine
  src/chat-socket/   WebSocket gateway
  src/chat-expert/   prompt building and LLM providers
  src/shared/        config, contracts, database schema and migrations, queue drivers
  src/tools/         smoke test you can run against any deployment
dashboard/         Admin dashboard (React + Vite), served by chat-app at /admin
sdk/js/            @ai-chat/client — browser/Node SDK (ESM, CJS and a <script> bundle)
examples/          A minimal host backend + embeddable chat widget
deploy/            Docker Compose reverse proxy config and the Helm chart
docs/              Architecture walkthrough, client protocol, host API reference
Dockerfile         One image for all three services
docker-compose.yml Single-machine deployment
```

---

## Quick start (Docker Compose)

Requirements: Docker with the Compose plugin, `openssl`.

```bash
git clone <this repository> ai-chat && cd ai-chat
cp .env.example .env
```

Fill in the secrets. Each is generated once and must stay the same afterwards; `ENCRYPTION_KEY` in particular protects stored LLM credentials, so back it up.

```bash
sed -i.bak \
  -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')|" \
  -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')|" \
  -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '\n/+=')|" \
  -e "s|^MYSQL_PASSWORD=.*|MYSQL_PASSWORD=$(openssl rand -hex 16)|" \
  -e "s|^MYSQL_ROOT_PASSWORD=.*|MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16)|" \
  .env && rm .env.bak
grep -E '^(ADMIN_EMAIL|ADMIN_PASSWORD)=' .env   # your dashboard sign-in
```

Start everything:

```bash
docker compose up -d --build
docker compose ps        # chat-app becomes "healthy" after migrations run (~20 s)
```

Open **http://localhost:8080/admin**, sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, and follow [First-run setup](#first-run-setup).

Verify the whole pipeline (it creates a temporary mock provider, agent and key, chats over the socket, and removes them):

```bash
docker compose exec chat-app sh -c 'AIC_URL=http://proxy ADMIN_EMAIL=$ADMIN_EMAIL ADMIN_PASSWORD=$ADMIN_PASSWORD node dist/tools/smoke-test.js'
```

To run models locally with no external API, add Ollama:

```bash
docker compose --profile ollama up -d
docker compose exec ollama ollama pull llama3.1:8b
```

Then add a provider of type **OpenAI-compatible** with base URL `http://ollama:11434/v1` and model `llama3.1:8b`.

---

## First-run setup

The dashboard's **Overview** page shows a checklist. The steps:

1. **LLM providers → Add provider.** Choose the type and paste the credential. It is encrypted with `ENCRYPTION_KEY` and never shown again. Click **Test** to make one real call through chat-expert.

   | Type | Credential | Example model |
   |---|---|---|
   | OpenAI | API key | `gpt-4o-mini` |
   | Anthropic (Claude) | API key | `claude-opus-5-5` |
   | Google Gemini | AI Studio API key | `gemini-2.5-flash` |
   | Google Vertex AI | service-account JSON, location | `gemini-2.5-flash` |
   | OpenAI-compatible | optional key, base URL ending in `/v1` | whatever the server hosts |
   | Mock | none | `mock-1` (offline testing) |

2. **Agents → New agent.** Give it a slug (your backend uses it), choose a persona (a default one is included), optionally a domain prompt, and on the **Model** tab add a route to your provider and model.
   - **Conversation** tab: session length (never ends, or a fixed duration), opening message (template, model-written, or none), suggestions, closing message (model-written, fixed, or none) and reply language.
   - **Knowledge** tab: attach knowledge bases. **Actions** tab: things the model may trigger in your product.
   - **Playground** tab: try unsaved changes and see the exact system prompt. **Test chat** tab: a real conversation with the saved agent.
3. **API keys → Create key.** For your backend only — never ship it to a client.
4. **Settings** (optional): webhook URL and signing secret, offline delivery (push), data retention.

### Headless setup

Everything the dashboard does is an HTTP call, so setup can be scripted. The admin API uses the sign-in cookie:

```bash
URL=http://localhost:8080
curl -sc /tmp/aic.cookies -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"<ADMIN_PASSWORD>"}' $URL/admin/api/auth/login

# 1. provider
curl -sb /tmp/aic.cookies -H 'content-type: application/json' $URL/admin/api/providers \
  -d '{"name":"OpenAI","kind":"OPENAI","credentials":"sk-...","defaultModel":"gpt-4o-mini"}'
# 2. agent (persona 1 is the seeded default; provider id from the previous response)
curl -sb /tmp/aic.cookies -H 'content-type: application/json' $URL/admin/api/agents \
  -d '{"slug":"support","name":"Support","personaId":"1",
       "modelRoutes":[{"providerId":"1","model":"gpt-4o-mini","weight":100}],
       "settings":{"session":{"durationSec":null},"greeting":{"mode":"TEMPLATE","template":"Hi {{user.name}}! How can I help?"}}}'
# 3. host API key — printed once
curl -sb /tmp/aic.cookies -H 'content-type: application/json' $URL/admin/api/api-keys -d '{"name":"backend"}'
```

Every field of `settings` is optional and validated; `GET /admin/api/meta` returns all defaults and limits.

---

## Integrating your product

### Concepts

| Term | Meaning |
|---|---|
| **Agent** | What your product talks to, addressed by slug. Combines a persona, an optional domain prompt, model routes, knowledge, actions and behaviour settings. |
| **Persona** | Who the agent is: display name, avatar, tagline and the persona prompt (voice and character). Shared by many agents. |
| **Domain prompt** | What the agent helps with: subject, scope and example answers. Shared by many agents. |
| **Master prompt** | The platform-wide frame every agent opens with (honesty, scope, data-vs-instructions, reply format). |
| **Knowledge base** | Text documents placed into the prompt, in order, within the agent's budget. |
| **Conversation** | One per (agent, user id, `scope`). Opening the same triple again resumes it; a different `scope` starts a new one. |
| **Turn** | One batch of user messages typed in one go, answered by one reply of one or more bubbles. |
| **Session length** | Per agent: never ends on its own, or ends a fixed time after it opens (the timer never pauses). An open session continues where it left off when reopened; an ended one reopens read-only. |

### 1. Your backend starts the session

Call the host API with your key for the signed-in user. Send the user's id and whatever the agent should know about them and the topic:

```bash
curl -X POST https://chat.example.com/v1/sessions \
  -H "Authorization: Bearer aic_..." -H "Content-Type: application/json" \
  -d '{
    "agent": "support",
    "user": { "id": "user-123", "name": "Sam", "attributes": { "plan": "pro" } },
    "scope": "order-4521",
    "context": { "title": "Order #4521", "text": "Delivered 2 days late; the user was charged a fee." }
  }'
```

```json
{
  "conversationId": "42", "created": true, "status": "ACTIVE", "acceptingMessages": true,
  "token": "eyJ...", "tokenExpiresAt": "2026-01-01T13:00:00.000Z",
  "socketUrl": "https://chat.example.com", "apiUrl": "https://chat.example.com",
  "expiresAt": null, "...": "..."
}
```

Return `token`, `socketUrl` and `apiUrl` to your client. The token is scoped to this one conversation and expires after `SESSION_TOKEN_TTL_SEC`; to refresh it, call `POST /v1/sessions` again (or `POST /v1/sessions/:id/token`). The full host API — context updates, ending, transcripts, user erasure, push devices — is in [docs/host-api.md](docs/host-api.md).

### 2. Your client chats

**Web (bundler):** `npm install @ai-chat/client` (or use `sdk/js` from this repository).

```ts
import { ChatClient } from '@ai-chat/client';

const chat = new ChatClient({
  apiUrl, socketUrl, token,
  refreshToken: async () => (await myBackend.startChat()).token,
});
chat.on('messages', (messages) => render(messages));      // the merged transcript
chat.on('suggestions', (chips) => renderChips(chips));
chat.on('typing', (isTyping) => showTyping(isTyping));
chat.on('turnFailed', ({ turnId, retryable }) => retryable && offerRetry(() => chat.retry(turnId)));
chat.on('sessionEnded', () => disableComposer());

const session = await chat.connect();   // agent name/avatar, behaviour config, newest messages
input.oninput = () => chat.notifyTyping();
form.onsubmit = () => chat.send(input.value);
```

**Web (no bundler):** serve `sdk/js/dist/ai-chat.global.js` and use `window.AiChat.ChatClient`. A complete, working page is in [examples/host-backend](examples/host-backend).

**Mobile and other platforms:** implement [docs/client-protocol.md](docs/client-protocol.md) — socket.io over WebSocket plus a small REST API. The JavaScript SDK is the reference implementation.

### 3. Your backend receives events (optional)

Set a webhook URL and signing secret in **Settings**. ai-chat POSTs JSON events with retries:

| Event | When |
|---|---|
| `session.started` | A conversation was created. |
| `session.ended` | It ended — timer, user, host or operator. |
| `action.invoked` | The model triggered one of the agent's actions; do the work (create the ticket, hand off to a human). |
| `message.undelivered` | A reply was revealed while the user was offline (push mode "Webhook"); send your own notification. |

Verify every request: the `AIC-Signature` header is `t=<unix seconds>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`; reject a mismatch or a timestamp older than five minutes. [examples/host-backend/server.mjs](examples/host-backend/server.mjs) does this in a dozen lines.

### Try the example

```bash
npm ci && npm run build -w sdk/js
AIC_URL=http://localhost:8080 AIC_API_KEY=aic_... AIC_AGENT=support node examples/host-backend/server.mjs
open http://localhost:4000
```

---

## Deploying to production

All options run the same image. Build it yourself, or publish it from CI: pushing a `v*` tag runs [.github/workflows/release.yml](.github/workflows/release.yml), which publishes `ghcr.io/<owner>/<repo>:<version>` for amd64 and arm64.

```bash
docker build -t registry.example.com/ai-chat:0.1.0 .
docker push registry.example.com/ai-chat:0.1.0
```

### Option A — a single VM with Docker Compose and automatic HTTPS

Good for most installs up to a few thousand concurrent users.

1. Provision a VM (2 vCPU / 4 GB is plenty to start) with Docker; point a DNS record such as `chat.example.com` at it; open ports 80 and 443.
2. Follow the [Quick start](#quick-start-docker-compose), then set these in `.env`:
   ```bash
   SITE_ADDRESS=chat.example.com      # Caddy obtains and renews the TLS certificate
   HTTP_PORT=80
   HTTPS_PORT=443
   PUBLIC_APP_URL=https://chat.example.com
   ```
3. `docker compose up -d --build`, then sign in at `https://chat.example.com/admin`.
4. Back up the `mysql-data` volume (e.g. a nightly `docker compose exec mysql mysqldump ...`) and keep `.env` somewhere safe.

To scale on one machine: `docker compose up -d --scale chat-expert=3 --scale chat-socket=2`.

### Option B — Kubernetes with Helm

The chart is in [deploy/helm/ai-chat](deploy/helm/ai-chat). Bring your own MySQL 8 and Redis 7 (managed services such as RDS/Cloud SQL and ElastiCache/Memorystore, or in-cluster charts).

1. Create the database (`CREATE DATABASE aichat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`) and a user with full rights on it.
2. Create the secret (recommended over putting secrets in values):
   ```bash
   kubectl create namespace ai-chat
   kubectl -n ai-chat create secret generic ai-chat-secrets \
     --from-literal=DATABASE_URL='mysql://aichat:<password>@<mysql-host>:3306/aichat' \
     --from-literal=REDIS_URL='redis://<redis-host>:6379/0' \
     --from-literal=AUTH_SECRET="$(openssl rand -base64 48)" \
     --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 32)" \
     --from-literal=ADMIN_EMAIL='admin@example.com' \
     --from-literal=ADMIN_PASSWORD="$(openssl rand -base64 18)"
   ```
   Save `ENCRYPTION_KEY` outside the cluster too — losing it makes stored provider credentials unreadable.
3. Install:
   ```bash
   helm upgrade --install ai-chat deploy/helm/ai-chat -n ai-chat \
     --set image.repository=registry.example.com/ai-chat --set image.tag=0.1.0 \
     --set existingSecret=ai-chat-secrets \
     --set publicUrl=https://chat.example.com \
     --set ingress.host=chat.example.com \
     --set ingress.className=nginx \
     --set ingress.tls.secretName=ai-chat-tls
   kubectl -n ai-chat rollout status deploy/ai-chat-chat-app
   ```
   A pre-install/pre-upgrade Job applies database migrations first. The ingress serves everything on one host: `/socket.io` goes to chat-socket and everything else to chat-app. No sticky sessions are needed. For TLS use cert-manager or create the `ai-chat-tls` secret yourself.
4. Run the smoke test (printed by `helm install` as well):
   ```bash
   kubectl -n ai-chat exec deploy/ai-chat-chat-app -- sh -c \
     'AIC_URL=https://chat.example.com ADMIN_EMAIL=$ADMIN_EMAIL ADMIN_PASSWORD=$ADMIN_PASSWORD node dist/tools/smoke-test.js'
   ```

Every Deployment has readiness (`/readyz`, dependencies) and liveness (`/healthz`) probes, a preStop drain, a PodDisruptionBudget and a CPU-based HorizontalPodAutoscaler. Prometheus scrape annotations point at `/metrics`. Tune replicas and resources in `values.yaml`.

**AWS Load Balancer Controller instead of ingress-nginx:** set `ingress.className=alb` and use annotations such as `alb.ingress.kubernetes.io/scheme: internet-facing`, `alb.ingress.kubernetes.io/target-type: ip` and `alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=120`. The socket's 25-second ping keeps connections inside the default 60-second idle timeout either way.

### Option C — Amazon SQS instead of the Redis queue

Redis stays required (pub/sub, locks, deduplication); only the queues move. Create them (FIFO for the ordered ones):

```bash
PREFIX=ai-chat-
for q in inbound generation-responses; do
  aws sqs create-queue --queue-name ${PREFIX}${q}.fifo \
    --attributes FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=60
done
for q in generation-requests previews; do
  aws sqs create-queue --queue-name ${PREFIX}${q} --attributes VisibilityTimeout=150
done
for q in reveals webhooks; do
  aws sqs create-queue --queue-name ${PREFIX}${q} --attributes VisibilityTimeout=60
done
```

Then set `QUEUE_DRIVER=sqs`, `AWS_REGION` and `SQS_QUEUE_URL_PREFIX=https://sqs.<region>.amazonaws.com/<account-id>/ai-chat-`. Credentials come from the standard AWS chain (instance profile or IRSA via `serviceAccount.annotations`). They need `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility` and `sqs:GetQueueAttributes` on those six queues.

### Option D — without containers

Node.js 20.11+ (22 recommended), MySQL 8 and Redis 6.2+:

```bash
npm ci && npm run build
cp -r dashboard/dist server/public/dashboard
cd server
set -a; . ../.env; set +a      # plus DATABASE_URL and REDIS_URL
node dist/shared/database/migrate.js
node dist/chat-app/main.js &  node dist/chat-socket/main.js &  node dist/chat-expert/main.js &
```

Run each as a systemd service (or under a process manager) and put a reverse proxy in front that sends `/socket.io/` to port 3001 with WebSocket upgrade headers and everything else to port 3000. For nginx:

```nginx
location /socket.io/ {
  proxy_pass http://127.0.0.1:3001;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 3600s;
}
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Sizing

| Load | Starting point |
|---|---|
| chat-socket | ~10k idle connections per replica at 0.5 vCPU / 512 MB. Scale on connections or CPU. |
| chat-expert | Each replica runs `EXPERT_CONCURRENCY` (10) model calls at once. Throughput is bound by model latency: about 10 / average reply seconds replies per second per replica. |
| chat-app | Light per message. Start with 2 replicas and scale on CPU. |
| MySQL | One small instance handles millions of messages. Keep automated backups. |
| Redis | Small. Pub/sub, queues and locks only. With the Redis queue driver, enable persistence (AOF), which compose does. |

---

## Configuration reference

Every service reads the same variables; each one only requires what it uses. Defaults are shown.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `DATABASE_URL` | — (required) | app, expert | `mysql://user:password@host:3306/db` |
| `REDIS_URL` | `redis://localhost:6379/0` | all | Redis connection |
| `AUTH_SECRET` | — (required) | app, socket | ≥ 32 chars. Signs session tokens and dashboard sign-ins. Rotating it signs everyone out. |
| `ENCRYPTION_KEY` | — (required) | app, expert | 32 bytes, base64 (`openssl rand -base64 32`). Encrypts stored credentials. Never change it without re-entering credentials. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | app | Creates the first dashboard admin when none exists. Password ≥ 10 chars. |
| `PUBLIC_APP_URL` | `http://localhost:3000` | app | Public base URL, returned to hosts as `apiUrl`. |
| `PUBLIC_SOCKET_URL` | `PUBLIC_APP_URL` | app | Public WebSocket origin when not path-routed on the app URL. |
| `CORS_ORIGINS` | any | app, socket | Comma-separated browser origins allowed for the client API and socket. |
| `QUEUE_DRIVER` | `redis` | all | `redis` or `sqs`. |
| `QUEUE_PREFIX` | `aic` | all | Prefix for Redis keys and channels; lets several installs share one Redis. |
| `SQS_QUEUE_URL_PREFIX`, `AWS_REGION` | — | all | Required with `QUEUE_DRIVER=sqs`. |
| `RUN_MIGRATIONS` | `true` | app | Apply migrations on boot. The Helm chart sets `false` and uses its Job. |
| `DASHBOARD_ENABLED` | `true` | app | Serve the dashboard at `/admin`. |
| `SESSION_TOKEN_TTL_SEC` | `3600` | app | Client token lifetime. |
| `ADMIN_SESSION_TTL_SEC` | `43200` | app | Dashboard sign-in lifetime. |
| `GENERATION_TIMEOUT_MS` | `90000` | app | A generation not answered in this time fails the turn (retryable). |
| `LLM_TIMEOUT_MS` | `30000` | expert | One model call. One retry is made on retryable errors. |
| `EXPERT_CONCURRENCY` | `10` | expert | Concurrent model calls per chat-expert process. |
| `CONFIG_CACHE_TTL_MS` | `15000` | expert | How quickly dashboard changes reach chat-expert. |
| `SOCKET_MAX_TURNS_PER_MINUTE` | `20` | socket | Per-connection send limit. |
| `HOST_API_RATE_LIMIT_PER_MINUTE` | `1200` | app | Per API key, per process. |
| `CLIENT_API_RATE_LIMIT_PER_MINUTE` | `120` | app | Per conversation, per process. |
| `SOCKET_PING_INTERVAL_MS` / `_TIMEOUT_MS` | `25000` / `20000` | socket | Keep below your load balancer's idle timeout. |
| `SOCKET_SHUTDOWN_GRACE_MS` | `3000` | socket | Drain window on SIGTERM. |
| `APP_PORT` / `SOCKET_PORT` / `EXPERT_PORT` | `3000` / `3001` / `3002` | — | Listen ports. |
| `DATABASE_POOL_SIZE` | `10` | app | MySQL connections per chat-app process (chat-expert uses 5). |
| `TRUST_PROXY` | `true` | all | Trust `X-Forwarded-*` from the reverse proxy. |
| `LOG_LEVEL` / `LOG_PRETTY` | `info` / `false` | all | JSON logs to stdout; `LOG_PRETTY=true` for development. |
| `METRICS_ENABLED` | `true` | all | Serve `/metrics`. |

Agent behaviour (session length, greeting, suggestions, farewell, language, reply limits, history, knowledge budget, batching, pacing, actions) is configured per agent in the dashboard, not by environment.

---

## Operations

**Health.** Every service serves `GET /healthz` (process up, for liveness) and `GET /readyz` (database, Redis and queue reachable, for readiness).

**Metrics** (`GET /metrics`, Prometheus):

| Metric | |
|---|---|
| `aic_llm_request_duration_ms{provider_kind,model,kind,status}` | model call latency |
| `aic_llm_tokens_total{provider_kind,model,direction}` | token usage |
| `aic_generations_total{kind,status,failure_reason}` | generation outcomes |
| `aic_turn_first_part_ms` | user turn received → first reply bubble published |
| `aic_parts_published_total{delivery}` | delivery path: socket, offline |
| `aic_turns_received_total{outcome}` | persisted, duplicates, rejections by reason |
| `aic_sessions_total{event,reason}` | conversations created and ended |
| `aic_socket_connections_total{outcome}` | handshakes accepted and rejected |
| `aic_webhook_deliveries_total{event,outcome}` | webhook delivered, retried, failed |

Suggested alerts: `rate(aic_generations_total{status="failed"}[5m])` above a few percent; p90 of `aic_turn_first_part_ms` above your target; any `/readyz` failing for more than a minute.

**Logs** are JSON lines on stdout, labelled with `service` and `context`. API keys, passwords, tokens and secrets are redacted.

**Tracing a reply.** In the dashboard, **Conversations → a conversation** shows every message with the model, latency, tokens and the revision of the agent, persona, domain prompt and master prompt that produced it. Each config page has a **History** with restore.

**Upgrades.** Migrations are backward compatible with the previous release. With Helm the migration Job runs before the rollout; with Compose `RUN_MIGRATIONS=true` applies them as chat-app starts. Deploy chat-expert before chat-app when a release notes a queue contract change. In general: run `docker compose pull && docker compose up -d`, or `helm upgrade`.

**Backups.** MySQL holds everything durable. Redis holds only in-flight work, but with the Redis queue driver it is worth persisting (AOF) so queued work survives a restart. Keep `ENCRYPTION_KEY` and `AUTH_SECRET` in your secret store.

**Data.** `DELETE /v1/users/:id` erases one user's conversations, messages, action records and push tokens. **Settings → Data retention** deletes ended conversations after N days.

**Troubleshooting**

| Symptom | Check |
|---|---|
| Dashboard says "no answer from chat-expert" | chat-expert running and on the same `REDIS_URL` / `QUEUE_PREFIX`; its `/readyz`. |
| Turns fail with `NOT_CONFIGURED` | The agent has no model route, or the provider is disabled or missing a credential. Use **Test** on the provider. |
| Turns fail with `TIMEOUT` | Model too slow for `LLM_TIMEOUT_MS`, or chat-expert overloaded (scale it up or raise `EXPERT_CONCURRENCY`). |
| Client never connects | `/socket.io` must route to chat-socket with WebSocket upgrade enabled. Check `PUBLIC_SOCKET_URL` and `CORS_ORIGINS`. |
| `UNAUTHORIZED` on the socket | Token expired: provide `refreshToken` to the SDK. Or `AUTH_SECRET` differs between chat-app and chat-socket. |
| Provider credentials "unreadable" | `ENCRYPTION_KEY` changed. Restore it, or re-enter the credentials. |
| No typing indicator or replies on reconnect | Expected to resync automatically; confirm the client calls `GET /v1/client/messages?after=` (the SDK does). |

---

## Development

Requirements: Node.js 22, MySQL 8 (5.7 works for development) and Redis.

```bash
npm ci
npm run build -w sdk/js                 # the dashboard imports the SDK
cp .env.example .env                    # fill secrets; add DATABASE_URL and REDIS_URL
set -a; . ./.env; set +a
npm run dev:app      # chat-app on :3000 (runs migrations)
npm run dev:socket   # chat-socket on :3001
npm run dev:expert   # chat-expert on :3002
npm run dev:dashboard  # dashboard with hot reload on http://localhost:5173/admin (proxies the APIs)
```

Tests:

```bash
npm test                                         # server unit tests + SDK tests
REDIS_URL=redis://localhost:6379/15 npm run test:integration -w server   # queue ordering against real Redis
npm run typecheck && npm run lint
AIC_URL=http://localhost:3000 AIC_SOCKET_URL=http://localhost:3001 \
  ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run smoke:dev -w server          # end to end
```

Coding conventions for contributors are in [CLAUDE.md](CLAUDE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Security

- **Host API keys** are server-to-server credentials. Only their SHA-256 is stored, and each is shown once.
- **Session tokens** are scoped to one conversation and short-lived. A client can never read or write another conversation, whatever it sends.
- **The dashboard** uses an httpOnly, SameSite=Strict cookie. Passwords are hashed with scrypt, and sign-in is rate limited.
- **Secrets at rest** (LLM credentials, webhook secret, FCM service account) are encrypted with AES-256-GCM under `ENCRYPTION_KEY` and are never returned by the API.
- **Prompt injection.** Knowledge, host context, user attributes and user messages are fenced as information-only in the prompt. Actions can only be triggered if offered, and arguments are validated against the action's declared parameters.
- **Rate limits** apply per socket, per API key and per conversation. Per-turn message count and size limits come from the agent and are enforced twice.
- Report vulnerabilities as described in [SECURITY.md](SECURITY.md).
