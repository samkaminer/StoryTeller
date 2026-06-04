# Social Publishing Build Checklist

Implementation plan for turning the June 3, 2026 social publishing design into repo-specific engineering work for this codebase.

## Scope guardrails

- Keep story publishing take-scoped. In this repo, a "take" is currently a `reports/{reportId}` document with `report_type === "final_telling"` plus its single `responses/{responseDocId}` media row, not a standalone `story_takes` collection yet.
- Do not extend the existing best-effort TikTok/Instagram share buttons. Replace them with server-backed publish flows on the story results page and keep download/share as explicit fallback.
- Keep publishing server-owned. Do not store TikTok or Meta tokens in browser-managed Firestore writes the way Gmail currently does.

## Current codebase anchors

- Story docs are created in [public/story.html](/Users/samuelkaminer/Desktop/Storyteller%20AI/public/story.html:936) under `stories`.
- Final-telling take docs are created in [server.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server.js:3134) under `reports`, with the media row created at [server.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server.js:3144).
- When recording stops, the active take is attached to the story via `stories.finalReportId` in [server.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server.js:3185).
- Media is uploaded through the story-specific endpoint in [server.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server.js:7857) and finalized by the media queue in [server/utils/mediaQueue.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/utils/mediaQueue.js:360).
- Story result loading and take selection live in [server/routes/stories.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/routes/stories.js:104) and [public/story-result.html](/Users/samuelkaminer/Desktop/Storyteller%20AI/public/story-result.html:272).
- Current auth for protected API routes is `requireAuth` in [server/middleware/auth.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/middleware/auth.js:1).
- Existing OAuth precedent is Gmail popup flow in [server/routes/gmail-oauth.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/routes/gmail-oauth.js:1) and [public/js/user-settings.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/public/js/user-settings.js:286), but that pattern stores tokens on the client and should not be reused as-is.
- Modular routes are mounted in [server.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server.js:648).
- The repo now has server-only `socialAccounts`, `socialAuthStates`, and `socialPublishJobs` rules in [firestore.rules](/Users/samuelkaminer/Desktop/Storyteller%20AI/firestore.rules:184), plus a mounted social route surface in [server/routes/social.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/routes/social.js:1). Treat connected accounts as existing backend foundation, not a greenfield area.

## Required schema changes

### 1. Normalize take media onto the final-telling report doc

Reason: `server/routes/stories.js` currently has to scan `reports/{reportId}/responses` to find the take asset. Publishing jobs should not depend on that fanout read.

Add these fields to `reports/{takeReportId}` when `report_type === "final_telling"`:

```json
{
  "take_response_doc_id": "uuid",
  "take_video_gcs_url": "gs://bucket/story_videos/...",
  "take_audio_gcs_url": "gs://bucket/story_audio/...",
  "take_thumbnail_gcs_url": "gs://bucket/story_thumbnails/...",
  "take_media_processed_at": "Timestamp",
  "take_media_processing_error": "string|null",
  "take_media_processing_failed_at": "Timestamp|null"
}
```

Implementation notes:

- Write the initial `take_response_doc_id` when the final-telling report is created in [server.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server.js:3134).
- Update the remaining take media fields from [server/utils/mediaQueue.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/utils/mediaQueue.js:360) at the same time the response subdoc is updated.
- Update [server/routes/stories.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/routes/stories.js:70) to prefer these normalized fields before falling back to the existing response scan.
- Do not reuse the legacy top-level `responses` APIs for story publishing. Story publishing should resolve the selected take from the final-telling `reports` doc plus its `reports/{id}/responses/{id}` media subdoc only.

### 2. Add a server-only social accounts collection

Do not store social tokens on `users/{uid}`. Keep only non-sensitive display data in API responses.

Create `socialAccounts/{socialAccountId}`:

```json
{
  "userId": "firebase uid",
  "platform": "tiktok|instagram",
  "platformAccountId": "string",
  "displayName": "string|null",
  "username": "string|null",
  "status": "active|reauth_required|revoked|disconnected",
  "isPrimary": true,
  "loginProvider": "tiktok_oauth|facebook_login_for_business",
  "scopes": ["..."],
  "accessToken": {
    "ciphertext": "base64",
    "iv": "base64",
    "tag": "base64",
    "keyVersion": "v1"
  },
  "refreshToken": {
    "ciphertext": "base64",
    "iv": "base64",
    "tag": "base64",
    "keyVersion": "v1"
  },
  "tokenExpiresAt": "Timestamp|null",
  "refreshTokenExpiresAt": "Timestamp|null",
  "connectedAt": "Timestamp",
  "lastValidatedAt": "Timestamp|null",
  "lastRefreshAt": "Timestamp|null",
  "updatedAt": "Timestamp",
  "meta": {
    "openId": "string|null",
    "igUserId": "string|null",
    "facebookPageId": "string|null",
    "facebookPageName": "string|null"
  }
}
```

Launch constraint:

- Enforce one active account per `(userId, platform)` in V1.
- Use API responses to expose only `socialAccountId`, `platform`, `displayName`, `username`, `status`, and `connectedAt`.

### 3. Add a durable publish jobs collection

Create `socialPublishJobs/{publishJobId}`:

```json
{
  "userId": "firebase uid",
  "storyId": "stories doc id",
  "takeReportId": "reports doc id",
  "takeResponseDocId": "reports/{id}/responses/{id}",
  "socialAccountId": "socialAccounts doc id",
  "platform": "tiktok|instagram",
  "publishMode": "tiktok_draft|tiktok_direct|instagram_reel",
  "status": "queued|validating|uploading|uploaded|awaiting_user_action|publishing|published|failed|retryable|canceled",
  "caption": "string",
  "platformOptions": {
    "privacyLevel": "string|null",
    "disableComment": false,
    "disableDuet": false,
    "disableStitch": false,
    "shareToFeed": true,
    "coverOffsetMs": 0
  },
  "mediaSnapshot": {
    "videoGcsUrl": "gs://bucket/...",
    "audioGcsUrl": "gs://bucket/...|null",
    "thumbnailGcsUrl": "gs://bucket/...|null",
    "mimeType": "video/mp4|null",
    "durationSec": 0,
    "width": 0,
    "height": 0,
    "fileSizeBytes": 0
  },
  "platformPublishId": "string|null",
  "platformContainerId": "string|null",
  "platformPostId": "string|null",
  "platformPermalink": "string|null",
  "attemptCount": 0,
  "lastError": {
    "code": "string|null",
    "message": "string|null",
    "retryable": true,
    "httpStatus": 0
  },
  "queuedAt": "Timestamp",
  "startedAt": "Timestamp|null",
  "completedAt": "Timestamp|null",
  "lastPolledAt": "Timestamp|null",
  "nextPollAt": "Timestamp|null",
  "createdAt": "Timestamp",
  "updatedAt": "Timestamp"
}
```

Create `socialPublishJobs/{publishJobId}/events/{eventId}`:

```json
{
  "type": "job_created|validation_passed|upload_started|upload_finished|status_polled|publish_succeeded|publish_failed|retry_requested",
  "status": "job status at event time",
  "message": "human-readable status",
  "platformCode": "string|null",
  "httpStatus": 0,
  "attempt": 0,
  "payloadRedacted": {},
  "createdAt": "Timestamp"
}
```

### 4. Add durable OAuth state storage

Current `express-session` usage in [server.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server.js:419) uses the default in-memory session store and `cookie.secure: false`. That is not enough to protect production social OAuth callbacks.

Create `socialAuthStates/{state}` with short TTL:

```json
{
  "userId": "firebase uid",
  "platform": "tiktok|instagram",
  "storyId": "stories doc id|null",
  "takeReportId": "reports doc id|null",
  "codeVerifier": "string|null",
  "redirectPath": "/story-result.html?storyId=...",
  "createdAt": "Timestamp",
  "expiresAt": "Timestamp",
  "usedAt": "Timestamp|null"
}
```

Notes:

- For the current web-server OAuth flow, `codeVerifier` is optional and should stay `null` unless a future mobile or desktop PKCE client type is introduced.
- If you prefer not to persist this collection, replace it with a signed, encrypted `state` token. Do not depend on memory-backed session state alone.

## Repo changes by phase

### Phase 0: replace misleading short-video share behavior

- [ ] Update [public/story-result.html](/Users/samuelkaminer/Desktop/Storyteller%20AI/public/story-result.html:285) so TikTok and Instagram are labeled as manual fallback until the real publish flow is present.
- [ ] Keep `download` and copy-link actions intact, but stop presenting manual download as if it were a native TikTok/Instagram integration.
- [ ] Do not add new Firestore writes in the browser for social state.

### Phase 1: server foundation and take normalization

- [ ] Keep using the existing [server/routes/social.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/routes/social.js:1) and `server/utils/social-*` helpers as the base for connected accounts. Extend them rather than recreating the module surface.
- [ ] Update [server/utils/mediaQueue.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/utils/mediaQueue.js:370) to normalize take media fields onto the `reports/{takeReportId}` doc.
- [ ] Update [server/routes/stories.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/routes/stories.js:70) to return the normalized take media and a publish summary stub for the selected take.
- [ ] Keep `.env.example` aligned with the social foundation already present. Add only publish-specific config that does not exist yet.

### Phase 2: OAuth and connected accounts

- [ ] Keep the existing `POST /api/social/tiktok/connect/start`, `GET /api/social/tiktok/connect/callback`, `POST /api/social/instagram/connect/start`, `GET /api/social/instagram/connect/callback`, and `GET /api/social/accounts` routes as the connected-account base.
- [ ] Add `DELETE /api/social/accounts/:socialAccountId` or a soft-disconnect route that clears encrypted tokens server-side and marks the account `disconnected`.
- [ ] Use `requireAuth` from [server/middleware/auth.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/middleware/auth.js:1) on all connect/account routes.
- [ ] Store tokens only on the server in `socialAccounts`; never return ciphertext or raw tokens to the browser.
- [ ] Add rate limiting for connect start/callback routes in [server/middleware/rateLimiter.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/middleware/rateLimiter.js:1).

Implementation choice for Instagram:

- [ ] Use `Instagram API with Facebook Login` first, not the old client-side Basic Display pattern.
- [ ] Reason: the official Meta content-publishing flow supports resumable video uploads via `rupload.facebook.com`, which matches private GCS-hosted take assets better than public `video_url` handoff.

### Phase 3: TikTok draft publish pipeline

- [ ] Add `server/utils/socialPublishQueue.js` only when the first real publish worker lands.
- [ ] On boot in [server.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server.js:834), initialize the social publish queue and rehydrate jobs stuck in `queued`, `uploading`, `publishing`, or `awaiting_user_action`.
- [ ] Implement `POST /api/stories/:storyId/takes/:takeId/publish/tiktok`.
- [ ] Validate story ownership against the same story doc checks used in [server/routes/stories.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/routes/stories.js:20).
- [ ] Resolve the selected take by `takeId`, not by `stories.finalReportId`.
- [ ] Validate that `take_video_gcs_url` exists and points to a finished asset before job creation.
- [ ] Query TikTok creator info before rendering or submitting account options so privacy/comment/duet/stitch choices come from the current creator profile.
- [ ] Use TikTok file upload for V1 draft publishing, not pull-from-URL. This avoids TikTok domain verification requirements for draft uploads.
- [ ] Record returned TikTok publish identifiers on `socialPublishJobs`.
- [ ] Poll status into the job doc until terminal state; add webhook handling later only if polling proves insufficient.

### Phase 4: Instagram Reels publish pipeline

- [ ] Implement `POST /api/stories/:storyId/takes/:takeId/publish/instagram`.
- [ ] Add preflight validation for aspect ratio, codec, duration, and file size before calling Meta.
- [ ] Create the Instagram media container with `media_type=REELS`.
- [ ] Use resumable upload for video transfer so the server streams from GCS to Meta instead of relying on expiring signed URLs.
- [ ] Publish via `/<IG_ID>/media_publish`.
- [ ] Poll container status into `socialPublishJobs` until terminal state.
- [ ] Surface Page Publishing Authorization failures and token/permission failures as first-class retry states, not generic 500s.

### Phase 5: results-page UI and take-scoped history

- [ ] Replace the TikTok and Instagram buttons in [public/story-result.html](/Users/samuelkaminer/Desktop/Storyteller%20AI/public/story-result.html:319) with publish cards tied to the currently selected take.
- [ ] Extract the new publish UI into `public/js/story/social-publishing.js` instead of growing the existing inline script further.
- [ ] Keep the current take picker behavior from [public/story-result.html](/Users/samuelkaminer/Desktop/Storyteller%20AI/public/story-result.html:587), but wire publish actions to `currentSelectedTake`.
- [ ] Add a publish drawer or modal on the results page with:
  - [ ] connected account state
  - [ ] editable caption
  - [ ] TikTok privacy and interaction settings
  - [ ] Instagram share-to-feed and cover offset controls
  - [ ] job status and retry state
- [ ] Add `GET /api/stories/:storyId/publishes?takeId=:takeId` to populate take-scoped history.
- [ ] Keep manual download as a separate fallback control.

### Phase 6: retry, observability, and hardening

- [ ] Implement `GET /api/social/publishes/:publishJobId`.
- [ ] Implement `POST /api/social/publishes/:publishJobId/retry`.
- [ ] Redact platform error payloads before persisting event records.
- [ ] Add structured logs for `userId`, `storyId`, `takeReportId`, `platform`, `publishJobId`, and external request ids.
- [ ] Add a replay/cleanup job for stuck publishes after server restarts.
- [ ] Decide whether TikTok webhook support is worth adding after polling behavior is measured in staging.

## API surface to add

- `POST /api/social/tiktok/connect/start`
- `GET /api/social/tiktok/connect/callback`
- `POST /api/social/instagram/connect/start`
- `GET /api/social/instagram/connect/callback`
- `GET /api/social/accounts`
- `DELETE /api/social/accounts/:socialAccountId`
- `POST /api/stories/:storyId/takes/:takeId/publish/tiktok`
- `POST /api/stories/:storyId/takes/:takeId/publish/instagram`
- `GET /api/stories/:storyId/publishes?takeId=:takeId`
- `GET /api/social/publishes/:publishJobId`
- `POST /api/social/publishes/:publishJobId/retry`

## Firestore indexes to add

There is no committed `firestore.indexes.json` in this repo today. Add one at repo root or explicitly document these console-created indexes.

- [ ] `socialAccounts`: `userId ASC, platform ASC, status ASC`
- [ ] `socialPublishJobs`: `userId ASC, createdAt DESC`
- [ ] `socialPublishJobs`: `storyId ASC, takeReportId ASC, createdAt DESC`
- [ ] `socialPublishJobs`: `status ASC, nextPollAt ASC`
- [ ] `reports`: `story_id ASC, report_type ASC, start_timestamp DESC`

## Firestore rules changes

- [ ] Keep `socialAccounts`, `socialPublishJobs`, and `socialAuthStates` server-only. Do not expose direct browser reads/writes for those collections.
- [ ] If a browser-facing convenience summary is added to `users/{uid}`, keep it non-sensitive and continue using the existing owner-only rule in [firestore.rules](/Users/samuelkaminer/Desktop/Storyteller%20AI/firestore.rules:98).
- [ ] Do not copy the Gmail pattern of storing third-party tokens from the browser into Firestore.

## Missing env vars

Keep `.env.example` aligned to these values and add any missing publish-specific settings:

- [ ] `SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64=`
- [ ] `SOCIAL_TOKEN_ENCRYPTION_KEY_VERSION=v1`
- [ ] `SOCIAL_OAUTH_STATE_TTL_MINUTES=10`
- [ ] `TIKTOK_CLIENT_KEY=`
- [ ] `TIKTOK_CLIENT_SECRET=`
- [ ] `TIKTOK_REDIRECT_URI=${BASE_URL}/api/social/tiktok/connect/callback`
- [ ] `TIKTOK_WEBHOOK_VERIFY_TOKEN=` if webhook phase is added
- [ ] `TIKTOK_CONNECT_SCOPES=user.info.basic,video.upload`
- [ ] `META_APP_ID=`
- [ ] `META_APP_SECRET=`
- [ ] `META_REDIRECT_URI=${BASE_URL}/api/social/instagram/connect/callback`
- [ ] `META_GRAPH_API_VERSION=v23.0`
- [ ] `META_CONNECT_SCOPES=instagram_basic,instagram_content_publish,pages_read_engagement,pages_show_list`
- [ ] `META_WEBHOOK_VERIFY_TOKEN=` reserved for a later webhook phase

## Third-party setup requirements

### TikTok

- [ ] Register a TikTok developer app and add the Content Posting API product.
- [ ] Get approval for `video.upload` for V1 draft uploads.
- [ ] Store and use the TikTok user access token plus open ID.
- [ ] For this repo's server-rendered connect flow, use the standard web auth code flow. Do not assume PKCE or `code_verifier` is required unless the client type changes to mobile or desktop.
- [ ] If direct post is added later, enable the Direct Post configuration and get approval for `video.publish`.
- [ ] If direct post is added later, expect private-only visibility until TikTok audit is completed for the client.
- [ ] Do not use TikTok pull-from-URL in V1 unless a verified domain or URL prefix is in place.

### Instagram / Meta

- [ ] Create a Meta app on the Instagram Platform.
- [ ] Implement the login flow required by the chosen publish path. For this repo, prefer `Facebook Login for Business`.
- [ ] Require an Instagram professional account.
- [ ] Require that the Instagram professional account is connected to a Facebook Page.
- [ ] Plan for Page Publishing Authorization blocking some Pages.
- [ ] Request `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`, and `pages_show_list` for the current `/me/accounts` page-resolution path.
- [ ] If the Page role comes through Business Manager, be ready to request `ads_management` and `ads_read`.
- [ ] Reserve Meta webhook configuration early, but do not treat a webhook endpoint as a hard blocker for connected accounts or the first polling-based publish backend.

## Blockers and non-negotiable implementation decisions

- [ ] Token security guardrail: keep TikTok and Meta credentials behind the existing server-only encryption helpers. Do not regress to raw-token persistence or browser-visible account payloads.
- [ ] OAuth state guardrail: the app session setup in [server.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server.js:419) is still memory-backed, so social callbacks must continue using durable OAuth state or signed encrypted state tokens rather than session memory.
- [ ] Results-page complexity: [public/story-result.html](/Users/samuelkaminer/Desktop/Storyteller%20AI/public/story-result.html:372) is already a large inline script. Extract social publishing UI/state into a dedicated file before adding drawer logic.
- [ ] Take lookup gap: publishing should target the exact selected `takeId`; do not infer from `stories.finalReportId`.
- [ ] Queue durability gap: the existing queue pattern is process-local. Social publish jobs need Firestore-backed rehydration so retries survive restarts.
- [ ] Instagram upload strategy: do not rely on ephemeral signed GCS URLs for Meta ingestion when resumable upload is available.
- [ ] Firestore deployment gap: there is no committed indexes manifest; add one if this feature will be deployed repeatedly across environments.

## Testing checklist

- [ ] Keep extending `server/tests/social.routes.test.js` for auth, callback sanitization, disconnect behavior, and publish-route validation.
- [ ] Add `server/tests/social.queue.test.js` covering job state transitions, retries, and restart rehydration.
- [ ] Extend [server/tests/stories.routes.test.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/tests/stories.routes.test.js:1) to verify normalized take media fields and publish-summary data on `/api/stories/:storyId`.
- [ ] Add browser-level coverage for take selection + publish drawer behavior on `story-result.html`.
- [ ] Add fixture-based validation tests for bad media: no video, wrong mime type, over-duration, and unsupported aspect ratio.

## Recommended implementation order

- [ ] 1. Normalize take media on final-telling reports and expose it through `/api/stories/:storyId`.
- [ ] 2. Extend and harden the existing connected-account foundation: server-owned social accounts, token encryption, OAuth state handling, and disconnect/status coverage.
- [ ] 3. Add durable publish jobs and publish validators.
- [ ] 4. Ship TikTok draft upload first.
- [ ] 5. Add queue rehydration and worker durability as part of the first live publish worker.
- [ ] 6. Ship Instagram Reels publishing with resumable upload.
- [ ] 7. Replace result-page social buttons with real publish cards and take-scoped history.
- [ ] 8. Add retry flows and operational hardening.

## Source links for platform requirements

- TikTok Content Posting API overview and upload flow: https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content/
- TikTok Direct Post flow: https://developers.tiktok.com/doc/content-posting-api-get-started//
- TikTok Query Creator Info: https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
- TikTok scopes overview: https://developers.tiktok.com/doc/scopes-overview/
- Meta Instagram Platform content publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing/
