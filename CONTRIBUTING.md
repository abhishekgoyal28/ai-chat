# Contributing

Thanks for helping improve ai-chat.

1. Open an issue first for anything larger than a small fix, so the approach can be agreed.
2. Fork, branch, and keep changes focused — one concern per pull request.
3. Follow the conventions in [CLAUDE.md](CLAUDE.md): controllers thin, business logic in services, every database query in a repository, no foreign keys or database enums, migrations backward compatible.
4. Add or update tests with every behaviour change, then run:
   ```bash
   npm run typecheck && npm run lint && npm test
   REDIS_URL=redis://localhost:6379/15 npm run test:integration -w server
   ```
   and the end-to-end smoke test (see README → Development).
5. Update the README or `docs/` when behaviour or configuration changes, and add an entry to the changelog section of your pull request description.

By contributing you agree that your contributions are licensed under the Apache License 2.0.

## Changing a wire contract

`server/src/shared/contracts/` holds the socket protocol and the queue contracts. They are versioned:

- Socket protocol changes must stay backward compatible with released SDKs (add fields; never repurpose them). Update `docs/client-protocol.md` and `sdk/js` in the same pull request.
- Queue contract changes bump `GENERATION_SCHEMA_VERSION`; widen `SUPPORTED_*_VERSIONS` first so consumers accept both versions, and note the deploy order (chat-expert before chat-app) in the release notes.
