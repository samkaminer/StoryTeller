# Social Platform Config

Backend setup for connected TikTok and Instagram accounts in this repo.

Code references:

- [server/routes/social.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/routes/social.js:1)
- [server/utils/social-auth-state.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/utils/social-auth-state.js:1)
- [server/utils/social-crypto.js](/Users/samuelkaminer/Desktop/Storyteller%20AI/server/utils/social-crypto.js:1)
- [.env.example](/Users/samuelkaminer/Desktop/Storyteller%20AI/.env.example:1)

## Required env vars

Set these before testing connected accounts outside Jest:

```bash
SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64=
SOCIAL_TOKEN_ENCRYPTION_KEY_VERSION=v1
SOCIAL_OAUTH_STATE_TTL_MINUTES=10

TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=https://YOUR_APP_DOMAIN/api/social/tiktok/connect/callback
TIKTOK_CONNECT_SCOPES=user.info.basic,video.upload

META_APP_ID=
META_APP_SECRET=
META_REDIRECT_URI=https://YOUR_APP_DOMAIN/api/social/instagram/connect/callback
META_GRAPH_API_VERSION=v23.0
META_CONNECT_SCOPES=instagram_basic,instagram_content_publish,pages_read_engagement,pages_show_list

# Optional until webhook routes are added
META_WEBHOOK_VERIFY_TOKEN=
```

Notes:

- `SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64` must decode to exactly 32 bytes. Example generation:

```bash
openssl rand -base64 32
```

- `TIKTOK_REDIRECT_URI` and `META_REDIRECT_URI` must exactly match the callback URLs configured in each developer portal.
- Pick one local port and use it everywhere. `PORT`, `BASE_URL`, `TIKTOK_REDIRECT_URI`, and `META_REDIRECT_URI` must all point at the same local StoryTeller origin.
- Use HTTPS for all non-local redirect URIs. Localhost may use HTTP, but deployed callback URLs should be HTTPS and on the same Storyteller host the popup opener uses.
- `META_WEBHOOK_VERIFY_TOKEN` is not used by the connected-account flow yet, but keep it reserved now because Meta webhook setup is part of the same app configuration you will need for publish status later.
- TikTok draft publishing in the current backend uses the existing Google Cloud Storage credentials already required elsewhere in StoryTeller. There are no TikTok-specific storage env vars beyond the connected-account settings above.

## Local development checklist

For a working local social-publishing setup:

1. Copy `.env.example` to `.env`.
2. Choose a local port, for example `3001`, and keep all of these aligned:
   - `PORT`
   - `BASE_URL`
   - `TIKTOK_REDIRECT_URI`
   - `META_REDIRECT_URI`
3. Start the app with `npm run dev` or `npm start`.
4. Confirm the app is reachable on that same origin before testing OAuth:
   - `/story.html`
   - `/story-result.html`
   - `/health`
5. In Firebase Authentication, add these Authorized Domains for local sign-in:
   - `localhost`
   - `127.0.0.1`
6. In TikTok for Developers and Meta for Developers, register callback URLs that match the exact local StoryTeller origin you picked in step 2.

Current local behavior and dependencies:

- StoryTeller serves the social UI and callback handlers from the same Express app. If the app is running on `http://localhost:3001`, the social callback routes must also use `http://localhost:3001/...`.
- TikTok draft publishing needs working Google Cloud Storage credentials because the server reads the selected take from GCS during upload.
- Missing optional integrations such as Mem0 do not block the social routes from loading locally.
- The campaign sender can emit an unrelated Firestore index warning during startup; that warning does not block connected-account or publish testing.

## Current TikTok publish behavior

The current server implementation is intentionally limited to TikTok draft upload for a selected story take:

- Entry route: `POST /api/stories/:storyId/takes/:takeId/publish/tiktok`
- Status route: `GET /api/social/publishes/:publishJobId`
- Publish mode: `tiktok_draft`
- Transfer method: TikTok `FILE_UPLOAD`
- Storage model: StoryTeller reads the chosen take from GCS server-side, uploads it to TikTok, stores a persistent publish job, and refreshes publish status through the poll endpoint.

Important current limitations and assumptions:

- This implementation does not do direct post yet.
- The job stores the user-entered caption, but TikTok draft upload does not accept caption metadata on the upload endpoint, so the creator still edits and posts inside TikTok.
- The frontend should poll `GET /api/social/publishes/:publishJobId` for progress instead of assuming the initial `202` means the draft is already available in TikTok.
- StoryTeller must be able to decrypt the stored TikTok access token using `SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64`.
- The connected TikTok account must still be in `active` status at publish time and must retain the `video.upload` grant.
- StoryTeller now attempts a server-side TikTok access-token refresh shortly before expiry. If refresh is rejected or the refresh token has also expired, the account is marked `reauth_required` and the publish job fails with a reconnect-safe message.

## TikTok for Developers

Create one TikTok app for Storyteller and enable the products that match this backend:

1. Create an app in TikTok for Developers.
2. Add a Web platform redirect URI exactly matching `TIKTOK_REDIRECT_URI`.
3. Enable Login Kit for user authorization.
4. Enable Content Posting API access for the same app.
5. Request approval for the scopes this backend uses:
   - `user.info.basic`
   - `video.upload`
6. If you want to store TikTok usernames from the API response, also request `user.info.profile` and append it to `TIKTOK_CONNECT_SCOPES`.
7. Save the app’s Client Key and Client Secret into `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`.

Current backend behavior:

- Start route: `POST /api/social/tiktok/connect/start`
- Callback route: `GET /api/social/tiktok/connect/callback`
- Draft publish route: `POST /api/stories/:storyId/takes/:takeId/publish/tiktok`
- Draft publish status route: `GET /api/social/publishes/:publishJobId`
- OAuth mode: server-side web authorization code flow
- Authorization URL: `https://www.tiktok.com/v2/auth/authorize/`
- Token URL: `https://open.tiktokapis.com/v2/oauth/token/`
- Profile lookup: `https://open.tiktokapis.com/v2/user/info/`
- Draft upload init: `https://open.tiktokapis.com/v2/post/publish/inbox/video/init/`
- Publish status polling: `https://open.tiktokapis.com/v2/post/publish/status/fetch/`

Important TikTok constraints from the current official docs:

- Tokens should be stored and managed on the server side.
- For TikTok web/server flows, the current user-token docs use the standard authorization-code exchange. TikTok documents `code_verifier` as required for mobile and desktop only; the separate desktop guide uses a hex-encoded SHA-256 challenge and does not apply to this web backend.
- `video.upload` must be approved on the app and authorized by the TikTok user before draft-upload publishing can be used.
- Draft upload uses `/v2/post/publish/inbox/video/init/`, which is distinct from the direct-post endpoint and does not require `video.publish`.
- TikTok draft-upload polling uses `/v2/post/publish/status/fetch/` and can return states such as `PROCESSING_UPLOAD`, `SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE`, and `FAILED`.
- `video.publish` is not needed for the connected-account backend in this change set.
- If you later use TikTok pull-from-URL uploads or direct post, TikTok requires verified domains or URL prefixes for those media URLs.
- Direct post from unaudited clients can be restricted to private viewing mode, so this repo stays on account-connect only for now.
- For the current implementation, StoryTeller intentionally uses `FILE_UPLOAD` instead of `PULL_FROM_URL` so local and production publishing do not depend on TikTok URL-property verification.
- TikTok’s current upload docs allow MP4, MOV, and WebM video files, up to 4 GB, with chunked upload requirements for files larger than 64 MB.

## Meta for Developers

Create one Meta app that owns both the Instagram API configuration and the Facebook Login path used to identify the connected professional account.

1. Create a Meta app in the Business app type family used for Instagram Platform integrations.
2. Add the Instagram API product.
3. Add Facebook Login for Business to the same app.
4. Set the Valid OAuth Redirect URI to exactly `META_REDIRECT_URI`.
5. Set App Domains, Privacy Policy URL, and any other required basic app settings before review.
6. Put the app in Development mode first and add the internal testers who will connect accounts during QA.
7. Request Advanced Access for the permissions this backend uses:
   - `instagram_basic`
   - `instagram_content_publish`
   - `pages_read_engagement`
8. This backend also requests `pages_show_list` in `META_CONNECT_SCOPES` so it can enumerate the Facebook Pages needed to resolve the linked Instagram professional account.
9. If the Instagram professional account is managed through Business Manager instead of a directly administered Page, Meta’s current publishing docs also call out `ads_management` and `ads_read`.
10. Make sure each test Instagram account is a Professional account and is linked to a Facebook Page that the tester can access.

Current backend behavior:

- Start route: `POST /api/social/instagram/connect/start`
- Callback route: `GET /api/social/instagram/connect/callback`
- Reel publish route: `POST /api/stories/:storyId/takes/:takeId/publish/instagram`
- Shared publish status route: `GET /api/social/publishes/:publishJobId`
- OAuth dialog: `https://www.facebook.com/{META_GRAPH_API_VERSION}/dialog/oauth`
- Token exchange: `https://graph.facebook.com/{META_GRAPH_API_VERSION}/oauth/access_token`
- Account discovery: `GET /me/accounts?fields=id,name,instagram_business_account{...},connected_instagram_account{...}`
- Reel container creation: `POST /{ig-user-id}/media`
- Reel publish finalize: `POST /{ig-user-id}/media_publish`
- Reel container polling: `GET /{ig-container-id}?fields=status_code,status`

Current Instagram publish behavior:

- Publish mode: `instagram_reel`
- Media type: `REELS` only
- Source model: StoryTeller uses the selected take’s immutable `videoGcsUrl` as the publish source, generates a signed public read URL, and sends that URL to Meta as `video_url`
- Supported basic Reel options in the current backend:
  - `caption`
  - `share_to_feed`
  - `thumb_offset`
  - `cover_url` derived from the take thumbnail when explicitly requested
- This implementation does not support Stories, carousel posts, collaborators, user tags, location tagging, shopping tags, or product tagging.
- StoryTeller stores the long-lived Meta user token returned by Facebook Login for Business. When that token is near expiry or Meta signals it is invalid, the account is marked `reauth_required` and the user must reconnect before another publish attempt.

Important Meta constraints from the current official docs:

- Instagram publishing is for Professional accounts, not consumer Instagram accounts.
- Meta’s current Instagram publishing docs require Facebook Login for Business and server-side token handling.
- The connected Instagram professional account must be linked to a Facebook Page the app user can access.
- The app user must be able to perform the `MANAGE` or `CREATE_CONTENT` task on the linked Facebook Page.
- If the app user only has access to the Page through Business Manager role assignment, Meta also calls out `ads_management` or `ads_read`.
- Page Publishing Authorization can block publishing even when the user otherwise appears connected, so support should tell test users to complete PPA before publish work starts.
- If the linked Page requires two-factor authentication, the Facebook user must also have completed two-factor authentication or publish requests can fail.
- Meta’s current Reel specs require MP4 or MOV, maximum 300 MB, minimum 3 seconds, maximum 15 minutes.
- Media used for publish must be reachable on a public URL when Meta fetches it. The current backend satisfies this by issuing signed Google Cloud Storage read URLs for the selected take and optional thumbnail.
- The container status lifecycle used by the current backend is `IN_PROGRESS`, `FINISHED`, `PUBLISHED`, `ERROR`, and `EXPIRED`.
- The current StoryTeller backend uses the long-lived Meta user access token returned by Facebook Login for Business because that is what the connected-account flow stores today. If Meta later requires a Page access token for some production cases, add a dedicated page-token exchange/storage step before broad rollout.
- Meta webhook delivery requires the app to be in Live mode. This backend does not consume webhooks yet, but the app should be created with that future requirement in mind.

## Operational checklist

Before testing the new routes on a real environment:

1. Generate and set `SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64`.
2. Configure both exact redirect URIs in the provider dashboards.
3. Confirm the Storyteller callback host matches `BASE_URL` and the deployed HTTPS domain.
4. Add internal test users to both provider apps before the apps are live.
5. Keep provider secrets only in environment variables or deployment secrets, never in Firestore or the browser.
6. Expect local testing to depend on real Firebase, TikTok, Meta, and Google Cloud credentials. Jest coverage exercises the publish-job logic, retries, and token-lifecycle handling, but it does not replace live OAuth/provider validation.
