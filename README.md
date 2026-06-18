# Outpace Social Scheduler

**A full-stack social media scheduling platform — built entirely on Cloudflare's free tier.**

Outpace produces high-volume video and social content: YouTube Shorts, LinkedIn posts, and eventually Facebook. Before this tool, publishing meant logging into each platform separately, uploading each video manually, copy-pasting captions, and trying to maintain a consistent schedule across three different dashboards. Missed days meant lost momentum.

This is a self-hosted scheduling dashboard that lets the team batch-upload content, schedule weeks of posts in advance, and have them publish automatically — with no one touching a keyboard at publish time. An AI layer then analyzes which content themes are actually driving views, so the team knows what to make more of.

---

## What It Does

**Schedule posts** across YouTube, LinkedIn, and Facebook from a single composer. Set the date, time, and platforms once — the system handles publishing.

**Bulk upload videos** — drop a folder of YouTube Shorts, set a frequency (daily / every other day / MWF), pick a start date and time. Each video gets a D1 post record created. The cron picks them up and publishes on schedule over the coming weeks.

**AI-generated descriptions** — click "Generate Descriptions" on the bulk upload page and the system calls Cloudflare Workers AI (Llama 3.1 8B) for each video filename, returning punchy 2–3 sentence YouTube descriptions with hashtags. No manual caption writing for bulk content.

**Content intelligence** — the Insights page fetches live YouTube stats for published posts, sends all post titles to AI for theme clustering, and surfaces which content topics are driving the most views on a 0–100 relative scale. Cross-referenced with ActiveCampaign email open/click rates if connected.

---

## Architecture

```
React Frontend (Cloudflare Pages)
        │
        ▼
Hono.js API Worker (Cloudflare Workers)
  │       │        │        │        │
  ▼       ▼        ▼        ▼        ▼
 D1    R2 Bucket  KV    Workers AI  Cron
 SQLite  Media    OAuth   Llama 3.1  Every
 posts   storage  state   8B         5 min
```

**Cron job (every 5 minutes)** — queries D1 for posts due within the next minute, uses optimistic locking (`UPDATE WHERE status='pending'`, check `meta.changes === 0`) to prevent double-publishing in overlapping runs, then dispatches to the appropriate publisher.

**YouTube resumable uploads** — YouTube's upload protocol requires chunked delivery for video files. Running inside a Cloudflare Worker (128 MB memory limit, no persistent TCP), the publisher uses R2 range reads (`env.MEDIA.get(key, { range: { offset, length } })`) to stream exactly 8 MB at a time without loading the full video into memory. YouTube's `308 Resume Incomplete` response carries the byte offset for each subsequent chunk. On failure, the code queries YouTube's upload status to resync the offset before retrying (up to 5 attempts per chunk).

**OAuth state via KV** — the standard OAuth CSRF problem: generate a random `state` value, store `{ redirectUri }` in KV with a 5-minute TTL, redirect to the provider, validate state on callback, delete from KV on first use. Clean stateless solution for Workers' ephemeral execution model.

**Client-side multipart upload** — for files >50 MB, the frontend chunks the file using `file.slice()` and uploads parts sequentially to three Worker endpoints (initiate / part / complete) that map directly to R2's native multipart upload API. Uses `FileReader` instead of `file.arrayBuffer()` for Safari compatibility.

---

## Publishing Platforms

| Platform | Status | Notes |
|---|---|---|
| YouTube | ✅ Live | Resumable upload, auto `#Shorts` tag injection, token refresh |
| LinkedIn | ✅ Live | Text posts, image posts, multi-image carousels via asset registration |
| Facebook | 🔄 Planned | OAuth connect stub returns 501; publisher throws |

---

## Technical Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, React Router, Vite |
| Backend | Hono.js on Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| File storage | Cloudflare R2 |
| Cache / state | Cloudflare KV |
| AI | Cloudflare Workers AI (Llama 3.1 8B) |
| Hosting | Cloudflare Pages (frontend) |
| Cron | Cloudflare Cron Triggers (every 5 min) |
| Language | JavaScript (ES modules), JSX |

All infrastructure runs on Cloudflare's free tier.

---

## Project Structure

```
outpace-social/
├── worker/
│   ├── src/
│   │   ├── index.js          # Hono app, route mounting
│   │   ├── cron.js           # Scheduled publisher (optimistic locking)
│   │   ├── middleware/auth.js # Session token validation
│   │   ├── routes/
│   │   │   ├── posts.js      # CRUD, stats, filtering
│   │   │   ├── media.js      # R2 upload (single-shot + multipart)
│   │   │   ├── platforms.js  # OAuth connect/callback/disconnect
│   │   │   ├── ai.js         # Description generation
│   │   │   ├── activecampaign.js  # Email analytics integration
│   │   │   └── insights.js   # YouTube stats + AI clustering
│   │   └── publishers/
│   │       ├── youtube.js    # Resumable upload, R2 range reads
│   │       ├── linkedin.js   # UGC Posts API, carousels
│   │       └── facebook.js   # Stub (not yet implemented)
│   └── wrangler.toml
├── frontend/
│   └── src/
│       ├── pages/            # Dashboard, Compose, BulkUpload, Calendar, Insights, Settings
│       ├── components/       # PostCard, PostComposer, ScheduleCalendar, MediaUpload
│       └── lib/              # API client, auth context, theme
├── schema.sql
├── migrations/
└── README.md
```

---

## Setup

**Worker:**
```bash
cd worker
npm install
wrangler d1 create outpace-social
wrangler kv:namespace create KV
wrangler r2 bucket create outpace-media
wrangler deploy
```

**Required secrets:**
```bash
wrangler secret put JWT_SECRET
wrangler secret put TEAM_PASSWORD
wrangler secret put LINKEDIN_CLIENT_ID
wrangler secret put LINKEDIN_CLIENT_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

**Frontend:**
```bash
cd frontend
npm install
npm run build
wrangler pages deploy dist --project-name outpace-social
```

Update `src/lib/api.js` with your deployed worker URL before building.

---

## Known Limitations

- **LinkedIn** doesn't issue refresh tokens — reconnect required when the token expires (~60 days)
- **Facebook** publisher is not yet implemented
- No retry UI for failed posts — status is permanently `failed` until manually rescheduled
- AI description generation in bulk upload calls Workers AI sequentially (could be parallelized)
- No R2 media cleanup — published files are not deleted after publishing

---

## Context

Built for Outpace, a business coaching and content brand. The bulk upload flow is the highest-use feature — the team shoots a batch of Shorts, drops the folder, generates descriptions, and schedules 3–4 weeks of content in under 10 minutes.
