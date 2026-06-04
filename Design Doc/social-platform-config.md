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
- Use HTTPS for all non-local redirect URIs. `http://localhost:3001/...` is acceptable for local development, but deployed callback URLs should be HTTPS and on the same Storyteller host the popup opener uses.
- `META_WEBHOOK_VERIFY_TOKEN` is not used by the connected-account flow yet, but keep it reserved now because Meta webhook setup is part of the same app configuration you will need for publish status later.

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
- OAuth mode: server-side web authorization code flow
- Authorization URL: `https://www.tiktok.com/v2/auth/authorize/`
- Token URL: `https://open.tiktokapis.com/v2/oauth/token/`
- Profile lookup: `https://open.tiktokapis.com/v2/user/info/`

Important TikTok constraints from the current official docs:

- Tokens should be stored and managed on the server side.
- For TikTok web/server flows, the current user-token docs use the standard authorization-code exchange. TikTok documents `code_verifier` as required for mobile and desktop only; the separate desktop guide uses a hex-encoded SHA-256 challenge and does not apply to this web backend.
- `video.upload` must be approved on the app and authorized by the TikTok user before draft-upload publishing can be built.
- `video.publish` is not needed for the connected-account backend in this change set.
- If you later use TikTok pull-from-URL uploads or direct post, TikTok requires verified domains or URL prefixes for those media URLs.
- Direct post from unaudited clients can be restricted to private viewing mode, so this repo stays on account-connect only for now.

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
- OAuth dialog: `https://www.facebook.com/{META_GRAPH_API_VERSION}/dialog/oauth`
- Token exchange: `https://graph.facebook.com/{META_GRAPH_API_VERSION}/oauth/access_token`
- Account discovery: `GET /me/accounts?fields=id,name,instagram_business_account{...},connected_instagram_account{...}`

Important Meta constraints from the current official docs:

- Instagram publishing is for Professional accounts, not consumer Instagram accounts.
- Meta’s content-publishing flow expects Facebook Login and server-side token handling.
- Media publishing later will use `graph.facebook.com` and `rupload.facebook.com`.
- Page Publishing Authorization can block publishing even when the user otherwise appears connected, so support should tell test users to complete PPA before publish work starts.
- Meta webhook delivery requires the app to be in Live mode. This backend does not consume webhooks yet, but the app should be created with that future requirement in mind.

## Operational checklist

Before testing the new routes on a real environment:

1. Generate and set `SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64`.
2. Configure both exact redirect URIs in the provider dashboards.
3. Confirm the Storyteller callback host matches `BASE_URL` and the deployed HTTPS domain.
4. Add internal test users to both provider apps before the apps are live.
5. Keep provider secrets only in environment variables or deployment secrets, never in Firestore or the browser.
