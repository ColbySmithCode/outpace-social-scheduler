# Outpace Social Scheduler

Full-stack social media scheduling platform built entirely on Cloudflare's free tier. Supports YouTube (live) and LinkedIn (live). Facebook is stubbed.

## Architecture

```
frontend/          ← React 18 + Vite + React Router (SPA)
worker/            ← Hono.js on Cloudflare Worker
  src/
    routes/
      youtube.js   ← OAuth, upload initiation, resumable chunk relay
      linkedin.js  ← OAuth, post scheduling
      schedule.js  ← Cron-triggered publisher
    lib/
      kv.js        ← KV helpers (OAuth state, tokens, scheduled posts)
      r2.js        ← R2 multipart upload + range read helpers
      lock.js      ← Optimistic locking for cron
```

**Bindings used:** KV (tokens + scheduled posts), R2 (video storage), Cron Trigger (publisher)

## Key Commands

```bash
# Worker
cd worker && wrangler dev

# Frontend
cd frontend && npm run dev

# Deploy
wrangler deploy
cd frontend && npm run build && wrangler pages deploy dist/
```

## Secrets

```bash
wrangler secret put ANTHROPIC_API_KEY      # not currently used, reserved
wrangler secret put CLOUDFLARE_API_TOKEN   # for R2 management ops
wrangler secret put CLOUDFLARE_ACCOUNT_ID
wrangler secret put AUTH_SECRET            # frontend → worker auth

# LinkedIn OAuth
wrangler secret put LINKEDIN_CLIENT_ID
wrangler secret put LINKEDIN_CLIENT_SECRET

# Facebook (stubbed — not yet implemented)
wrangler secret put FACEBOOK_APP_ID
wrangler secret put FACEBOOK_APP_SECRET
```

## Key Technical Patterns

### YouTube Resumable Upload
Videos are never fully loaded into memory. Flow:
1. Client uploads file to R2 via multipart (8MB chunks, `file.slice()`)
2. Worker initiates a YouTube resumable upload session (gets upload URI)
3. Cron reads R2 in 8MB range reads (`Range: bytes=X-Y`) and relays to YouTube
4. Byte offset is persisted in KV between cron runs

### Optimistic Locking (cron deduplication)
```js
// In schedule.js — prevents double-publish if two cron invocations race
const result = await db.prepare(
  "UPDATE posts SET status='processing' WHERE id=? AND status='pending'"
).bind(id).run();
if (result.meta.changes === 0) return; // another invocation got it
```

### OAuth State via KV
State tokens expire in 5 minutes (`expirationTtl: 300`) and are deleted on first use. Do not extend the TTL — short-lived state prevents CSRF replay.

## Known Limitations (documented intentionally)

- **LinkedIn**: no refresh token in their OAuth flow. Users must re-auth every 60 days.
- **Facebook**: routes exist, returns 501. Planned for a future sprint.
- **No retry UI**: failed posts stay in `error` state. Manual re-queue only.
- **Hardcoded worker URL**: `outpace-social-worker.coleblanco.workers.dev` is referenced in the frontend config. Update `frontend/src/config.js` before deploying to a new account.

## What Not to Change

- The `status` enum values (`pending`, `processing`, `published`, `error`) — the cron query filters on `'pending'` exactly.
- R2 chunk size (8MB) — YouTube's resumable upload API requires chunks to be multiples of 256KB and ≥5MB except for the final chunk. 8MB is the safe default.
- KV key prefix conventions: `oauth-state-{platform}-{state}`, `token-{platform}-{userId}`, `post-{id}`.
