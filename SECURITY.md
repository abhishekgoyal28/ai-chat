# Security policy

## Reporting a vulnerability

Please report security issues privately — do not open a public issue. Use the
repository's **Security → Report a vulnerability** form (GitHub private
vulnerability reporting). Include the affected version, a description, and
steps to reproduce if you have them.

You will receive an acknowledgement within 3 working days and an assessment
within 10. Fixes are released as patch versions, with credit to the reporter
unless you prefer otherwise.

## Supported versions

The latest minor release receives security fixes.

## Hardening checklist for operators

- Serve only over HTTPS and set `PUBLIC_APP_URL` to the `https://` URL (the dashboard cookie is then marked `Secure`).
- Generate `AUTH_SECRET` and `ENCRYPTION_KEY` with `openssl rand` and keep them in a secret store.
- Set `CORS_ORIGINS` to your product's origins.
- Set a webhook signing secret and verify `AIC-Signature` on every event.
- Give dashboard members the EDITOR role unless they need ADMIN.
- Keep MySQL and Redis on a private network.
