# ai-chat Demo

A public demo site for the ai-chat platform, deployable to **Cloudflare Pages**.

Users sign in with Google and chat with an agent (default: the built-in guide agent "Ava").

## Architecture

```
Browser → Cloudflare Pages (static HTML)
              ↓  Google OAuth redirect
        functions/api/auth/google.js   (initiates OAuth)
        functions/api/auth/callback.js (exchanges code, creates ai-chat session)
              ↓  URL hash with session token
        index.html (loads ChatClient SDK, connects to ai-chat via WebSocket)
```

No database or KV store needed — OAuth state is HMAC-signed and the session token
is passed in the URL hash (never logged server-side).

## Deploy

### 1. Create a Google OAuth app

1. Open [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add Authorized redirect URI: `https://<your-pages-domain>/api/auth/callback`
4. Copy the Client ID and Client Secret

### 2. Deploy to Cloudflare Pages

```bash
npm run build -w sdk/js
cp sdk/js/dist/ai-chat.global.js demo/
cd demo
npx wrangler pages deploy . --project-name ai-chat-agent
```

Or connect the repo in the [Cloudflare Pages dashboard](https://dash.cloudflare.com/?to=/:account/pages).

### 3. Set secrets

```bash
npx wrangler pages secret put GOOGLE_CLIENT_ID    --project-name ai-chat-agent
npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name ai-chat-agent
npx wrangler pages secret put OAUTH_SECRET         --project-name ai-chat-agent
npx wrangler pages secret put AIC_API_URL          --project-name ai-chat-agent
npx wrangler pages secret put AIC_HOST_API_KEY     --project-name ai-chat-agent
npx wrangler pages secret put AIC_AGENT_SLUG       --project-name ai-chat-agent
```

| Secret | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `OAUTH_SECRET` | Any random 32+ character string (`openssl rand -hex 32`) |
| `AIC_API_URL` | Your ai-chat deployment's HTTPS URL, e.g. `https://chat.example.com`. Must be a hostname, not a bare IP (Cloudflare rejects IP fetches with error 1003), and HTTPS (browsers block mixed content). |
| `AIC_HOST_API_KEY` | Your ai-chat host API key (`aic_...`) |
| `AIC_AGENT_SLUG` | The agent to demo, e.g. `guide` |

### 4. Admin dashboard on this site

`functions/admin/[[path]].js` forwards `/admin/*` to the deployment, so the dashboard opens at
`https://<your-pages-domain>/admin`. On the deployment, set:

- `DASHBOARD_PUBLIC_URL=https://<your-pages-domain>`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (the same OAuth client works), with the extra
  redirect URI `https://<your-pages-domain>/admin/api/auth/google/callback`

Visitors who sign in with Google get a guest account: they see everything and can change only what they create.

### 5. Test it

Visit your Pages URL and click "Chat with Ava" or "Explore the admin dashboard".

## Local development

```bash
npx wrangler pages dev . --binding GOOGLE_CLIENT_ID=<id> \
  --binding GOOGLE_CLIENT_SECRET=<secret> \
  --binding OAUTH_SECRET=<secret> \
  --binding AIC_API_URL=http://localhost:3000 \
  --binding AIC_HOST_API_KEY=aic_... \
  --binding AIC_AGENT_SLUG=guide
```
