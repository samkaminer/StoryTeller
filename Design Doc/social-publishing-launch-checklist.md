# Social Publishing Launch Checklist

Use this checklist before broader internal testing or external rollout.

## Product coherence

- Confirm the results page clearly separates manual share actions from platform publishing actions.
- Confirm any manual share-link buttons point to a genuinely shareable destination. Do not launch X/Facebook/WhatsApp link sharing if they still point at an authenticated StoryTeller results URL.
- Confirm the connected accounts panel shows `Connect`, `Reconnect`, and `Disconnect` states for TikTok and Instagram.
- Confirm the publish drawer is take-scoped and always reflects the currently selected take.
- Confirm publish history is visible for each take and archive cards show lightweight publish summary pills.
- Confirm manual download/share remains available as a fallback when publishing is unavailable.

## Local configuration

- Set one local StoryTeller origin and keep `PORT`, `BASE_URL`, `TIKTOK_REDIRECT_URI`, and `META_REDIRECT_URI` aligned.
- Add `localhost` and `127.0.0.1` to Firebase Authentication Authorized Domains.
- Set `SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64` to a valid 32-byte key.
- Keep `SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64` stable across deploys. Rotating it without a token migration will invalidate existing stored social tokens and force reconnects.
- Configure working Firebase and Google Cloud Storage credentials for local media access.
- Register the exact local callback URLs in TikTok for Developers and Meta for Developers.

## Provider readiness

- TikTok app has approved access for `user.info.basic` and `video.upload`.
- Meta app has the required permissions for `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`, and `pages_show_list`.
- TikTok and Meta apps are in the correct review/live state for the users who will test or publish. Do not assume development-mode apps are sufficient for broader rollout.
- Privacy policy URLs, app domains, redirect URIs, and any platform-review metadata are complete and match the deployed StoryTeller host.
- Test Instagram accounts are Professional accounts linked to eligible Facebook Pages.
- Test users have any required Page Publishing Authorization and two-factor authentication completed.

## Backend behavior

- Confirm TikTok draft publish creates a persistent job and transitions through `queued`, `processing`, and `awaiting_user_action` or `failed`.
- Confirm Instagram Reel publish creates a persistent job and transitions through `queued`, `processing`, and `completed` or `failed`.
- Confirm retry only appears for the latest failed job for a take/platform and creates an unambiguous successor record.
- Confirm expired or invalid tokens move accounts to `reauth_required` and block new publishes cleanly.
- Confirm publish polling returns UI-safe errors and does not leak provider secrets.
- Confirm server restart behavior is acceptable for in-flight jobs. Since completion currently depends on polling rather than webhooks or a durable worker queue, verify that status refresh still resumes cleanly when the results page or status endpoint is hit again.

## Test pass

- Run:
  - `npm test -- --runTestsByPath server/tests/stories.routes.test.js server/tests/social.routes.test.js server/tests/tiktok-publish.service.test.js server/tests/instagram-publish.service.test.js server/tests/social-token.service.test.js server/tests/social-http.test.js`
- Confirm all suites pass before broader testing.
- Run at least one real end-to-end smoke test per platform with live credentials:
  - connect account
  - publish selected take
  - observe final status
  - retry a forced failure path where safe

## Monitoring and recovery

- Confirm structured social audit logs are visible in the target environment and can be searched by platform, publish job, and account.
- Set an alert or at least a daily review for spikes in:
  - `reauth_required` accounts
  - repeated publish failures
  - OAuth callback failures
  - outbound provider rate limits
- Prepare a support runbook for common recovery paths:
  - reconnect required
  - Instagram Page authorization / two-factor failures
  - TikTok pending-share cap reached
  - expired signed-media or provider-fetch failures

## Known launch caveats

- TikTok launch scope is draft upload only, not direct post.
- TikTok creator-info-driven privacy, duet, stitch, and comment controls are not implemented yet.
- Instagram launch scope is Reels only, not Stories or carousel publishing.
- Instagram token handling currently relies on reconnect rather than silent refresh.
- Publish completion currently depends on polling rather than provider webhooks.
