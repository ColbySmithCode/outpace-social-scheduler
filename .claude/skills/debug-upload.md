# Debugging a Stuck YouTube Upload

1. Get the post ID from the KV list: `wrangler kv key list --namespace-id=<KV_ID> --prefix=upload-`
2. Check byte offset: `wrangler kv key get --namespace-id=<KV_ID> upload-{postId}`
   - `byteOffset` = how many bytes YouTube has received
   - `totalSize` = full file size
   - If byteOffset < totalSize and status is 'processing', the cron is still running (check logs)
   - If byteOffset < totalSize and status is 'pending', the cron hasn't picked it up yet
3. Check cron logs: `wrangler tail outpace-social-worker --format=pretty`
4. If the YouTube upload URI has expired (>24h), the upload must restart from 0. Set status back to 'pending' and clear byteOffset.
