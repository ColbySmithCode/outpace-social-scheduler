# Adding a New Social Platform

Follow this pattern exactly — it's how YouTube and LinkedIn were built.

1. **OAuth route** (`src/routes/{platform}.js`):
   - GET /{platform}/auth → redirect to platform OAuth URL with state stored in KV (5 min TTL)
   - GET /{platform}/callback → exchange code for token, store in KV as `token-{platform}-{userId}`, delete state key

2. **Schedule route**:
   - POST /{platform}/schedule → validate token exists, store post in KV as `post-{id}` with `status: pending`

3. **Publisher** (in `src/routes/schedule.js` cron handler):
   - Add a case for the new platform in the cron switch
   - Use optimistic locking: UPDATE status='processing' WHERE status='pending', check changes===0

4. Add platform to the frontend platform selector dropdown.
5. Document known limitations (token expiry, rate limits, API quirks) in README.md Known Limitations section.
