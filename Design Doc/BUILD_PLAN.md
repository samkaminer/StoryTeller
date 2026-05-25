# StoryTeller AI — Build Plan

## What We're Building

StoryTeller AI is a consumer storytelling product built on top of the Prompter OSS codebase (Node/Express/Socket.IO). It's a digital expansion of an in-person somatic storytelling workshop: storytellers re-enter a specific past moment through embodied memory and narrate from inside the experience.

**Firebase project:** `storyteller-ce8c2`
**Local path:** `/Users/samuelkaminer/Desktop/Storyteller AI`

### The Product Flow

```
Auth → Pick a story prompt → ~2-min physical warm-up → AI-guided interview
  → AI craft notes → Final telling recording (3 min) → Playback + social share → Archive
```

### The Clever MVP Shortcut

The final telling is a user-performed edit — no video editing pipeline to build on day one. But every transcript is captured with word-level timestamps and analyzed into a structured **narrative map** + **proposed cut**, laying the foundation for a future automated video-editing pipeline (and eventually a training dataset: raw interview → AI-proposed edit → user's self-edit).

**Cost-efficiency and durable data structure are explicit priorities from day one.**

---

## Key Design Decisions

| Decision | Choice |
|---|---|
| Auth | Google + email login, required. Gate at entry page only — do NOT add `requireAuth` to `/i/` (PAIRR is anonymous by design) |
| Prompt timing | Chosen **first**, before warm-up begins |
| Coaching | Every session (no skip for returning users in MVP). Warm-up has per-step skip |
| Warm-up | System auto-runs 2–3 emotional scenario progressions from Firestore pool (20–30 scenarios). User doesn't pick — they're presented. Each escalates intensity through randomized ascending levels, always ending at 10. Auto-advance ~4–5s/level |
| Interview start | First "question" = chosen story prompt verbatim. Always-visible "I'm done" button |
| AI notes | 2–4 craft observations only (what landed / where clarity broke). No emotional reactions, no interpretation, no directing. One-way for MVP |
| Final telling | Single continuous recording. Count-up timer; warnings at 2:00 and 2:30; stronger at 3:00; hard auto-stop at 3:30. One re-record allowed with deliberate friction |
| Video orientation | **Portrait 9:16 natively** (mobile-first). Optimized for TikTok/Reels/Shorts. No landscape output, no blurred-background compositing. Desktop webcams center-cropped to vertical as fallback |
| Social share | Deep links (open the app/site with video ready) — NOT API posting |
| Storage | GCS for MVP. Cloudflare R2 documented as scale migration (free egress) |
| Prompt/scenario storage | Firestore, not hardcoded |
| AI cost | Follow-ups on `claude-sonnet`. Single analysis pass on `claude-opus`. Prompt caching everywhere. Per-session token/time ceiling |

---

## Architectural Constraints

Things verified against the existing codebase that must not be broken:

1. **Recording is per-answer, not continuous.** `video-recorder.js` resets chunks each answer and uploads one media file per response. Only the final telling is one continuous take.

2. **One `reports/{persistentSessionId}` doc per socket session.** Two recordings (interview + final telling) = two report docs. A new parent `stories` collection links them.

3. **Interview ends only via `stopInterview`** (`server.js:2827`), which force-fires PAIRR report generation. Story mode needs its own teardown branch (`endStory`).

4. **The first-question handoff already exists and works:** `/i/?firstQuestion=<text>` → `state.customFirstQuestion` (flow.js:98) → `sessionInfo.customPrompt` → static-question path bypassing Claude (server.js:3828). Keep story prompts free of `{{` or flow.js:103 blanks them.

5. **`server.js` is an ~12,000-line monolith.** Prefer new files in `server/utils/` invoked from the `io.on('connection')` closure (the `reportGeneration.js` pattern) — not more inline code.

---

## Milestones

### Milestone 0 — Foundations & Config ✅ Partially Done
**Goal:** Deepgram working, Firebase wired, seed data, cost fix.

**Done:**
- Firebase credentials wired to `storyteller-ce8c2` in `public/js/firebase-config.js`
- Deepgram made optional (warns + continues instead of exiting when key absent)
- Follow-up model now reads `sessionInfo.followupModel` instead of hardcoding `claude-sonnet-4-6`

**Still needed:**
- Add `DEEPGRAM_API_KEY` to `.env`
- Seed Firestore (`scripts/seed-story-data.js`):
  - `story_prompts` — curated, placeholder-free prompts (e.g. "Tell me about a moment your life seemed to shift on its axis")
  - `warmup_scenarios` — 20–30 `{ text, tone: 'joyful'|'sad'|'wildcard' }`
  - `interviews/{storyTemplateId}` — one template with somatic `followupPrompt`, `enableVideoRecording: true`, `enableThinking: true`, `followupModel` = sonnet
- Firestore rules — add `match /stories/{storyId}` (owner read, authed create/update); add read rules for `story_prompts` and `warmup_scenarios`

**Files:** `scripts/seed-story-data.js` (new), `firestore.rules`, `.env`

---

### Milestone 1 — Entry, Auth Gate & Coaching Flow
**Goal:** New `public/story.html` consumer entry that ends by handing off to `/i/`.

- **`public/story.html`** + `public/js/story/coaching.js` + `public/js/story/prompt-select.js`
- **Auth gate:** `onAuthStateChanged` on load → show Google+email UI if not logged in (reuse `public/js/auth.js`). Reveal prompt selection only post-auth.
- **Prompt selection:** read `story_prompts` from Firestore; show cards + "Surprise me" shuffle. User locks in prompt before anything else.
- **Create `stories/{storyId}` doc** post-selection: `{ userId, userEmail, promptId, promptText, status:'interview', createdAt }`
- **Coaching sequence** (client-side state machine in `coaching.js`): one-line runway → warm-up (2–3 auto-run scenario progressions) → audience frame + brief pause
- **Handoff:** redirect to `/i/index.html?interview=<storyTemplateId>&firstQuestion=<encodeURIComponent(promptText)>&storyId=<storyId>&mode=story`

**Reuse:** `auth.js` flows, `firstQuestion` URL contract. **No changes to `/i/` flow.**

---

### Milestone 2 — Story-Mode Interview Behavior
**Goal:** The existing interview engine behaves correctly for storytelling.

- **Thread `storyId` + `mode=story`** through: `main.js` URL parse (~766) → `state.interview.customData` → `prepareInterviewData` (flow.js:248) → `startInterview` payload → `sessionInfo` → stamp `story_id` on the `reports` doc. On creation, update `stories/{storyId}.interviewReportId`.
- **Portrait capture override:** story mode forces 9:16 on the interview camera too (consistency for future editing pipeline)
- **Relax "I'm done" time gate:** `main.js:399` blocks until `initialTargetDurationSeconds`. Branch on story mode so button is always active. PAIRR gate stays intact.
- **Somatic `followupPrompt`** (on the template, layered atop `CORE_INTERVIEWING_TECHNIQUES`): seize embodied/sensory language when it appears, keep them in the specific moment, allow brief backstory only, no compound questions, don't sound like a therapist
- **"Thank you" close:** when AI senses narrative completeness, soft "any final thoughts?" + visually center the "I'm done" button

**Reuse:** entire `generateNextQuestion` / Deepgram / per-answer media pipeline.

---

### Milestone 3 — Story Teardown & AI Analysis Pass
**Goal:** Ending the interview produces notes (shown) + narrative map + proposed cut (stored).

- **New socket event `endStory`** (beside `stopInterview`): runs Deepgram cleanup, then calls `generateStoryAnalysis(sessionId, storyId)` instead of PAIRR report generation. Emits redirect to `/story-notes.html?storyId=<id>`.
- **New `server/utils/storyAnalysis.js`** (modeled on `reportGeneration.js`):
  - Pull Q&A + `word_timestamps` via `getResponsesWithSignedUrls`
  - Extend XML builder to embed word-level timecodes so Claude can emit accurate times
  - **One Opus call, three XML-tagged outputs:**
    - `<craft_notes>` — 2–4 observations
    - `<narrative_map>` — segments with label ∈ `backstory|scene_entry|development|peak|turn|resolution` + start/end + summary + emotional_intensity
    - `<proposed_cut>` — ordered `{start, end}` for an ideal 3-min edit
  - Store all three on `stories/{storyId}`; emit only `notes` to the client
- **`public/story-notes.html`:** loading state ("Please be patient while we make notes on your story") → render 2–4 notes → "Begin final telling →" button

**Reuse:** `getResponsesWithSignedUrls`, stream/extract/cache report pattern. `findBestSubsegment` (video.js:936) is the future consumer of `proposed_cut`.

---

### Milestone 4 — Final Telling (Single Continuous Take)
**Goal:** One clean recording — the primary artifact.

- **Create a second `reports` doc** for the final telling; link `stories/{storyId}.finalReportId`
- **New `public/story-final.html`** + `public/js/story/final-recorder.js`:
  - Reuse `setupVideoStream` + `setupMicrophone` + `getVideoMimeType`
  - Override capture constraints to portrait 9:16 (target 1080×1920 via `getUserMedia`)
  - One start / one stop / one upload (no per-segment chunk reset)
  - Count-up timer: warnings at 2:00, 2:30, 3:00 — hard auto-stop at 3:30
- **Transcription:** live Deepgram stream during take; store transcript + `word_timestamps`
- **Upload** via existing `POST /api/interviews/:interviewId/upload-recording` (server.js:7463) → `mediaQueue` stores native vertical as-is
- **Do NOT route through `generateNextQuestion`** — record/stop only

**Reuse:** stream setup, upload route, mediaQueue.

---

### Milestone 5 — Vertical Media Finalization
**Goal:** Store the native vertical cleanly + thumbnail. No reorientation, no compositing.

- `mediaQueue.js` (~170–307) stores the final telling vertical **as-is**. Confirm nothing force-normalizes to 1920×1080 (the `stitchVideoFiles` normalization in video.js is report-video only — verify it's not reused here)
- **Thumbnail** at ~2s for archive cards + email
- **Desktop fallback (secondary only):** if landscape webcam detected, center-crop to 9:16 via FFmpeg: `crop=ih*9/16:ih:(iw-ih*9/16)/2:0`

**Reuse:** mediaQueue mux/upload machinery, existing thumbnail logic.

---

### Milestone 6 — Playback, Sharing, Email, Archive
**Goal:** Deliver the artifact and close the loop.

- **`public/story-result.html`:** plays final telling (vertical, full-screen). Share icons (TikTok, Instagram Reels, YouTube Shorts, X, Facebook) as deep links. One re-take with friction message: *"One more take. Make it count."* After re-take, only Share remains.
- **Email:** reuse `server/services/email-service.js` — send thumbnail + watch link + archive link
- **`public/story-archive.html`:** behind auth; query `stories` where `userId == currentUser.uid`; cards (prompt, date, thumbnail) → playback. Protect fetch routes with `requireAuth` (server/middleware/auth.js:77)
- **Consent:** opt-in checkbox at first entry (store recordings + use anonymized data to improve the system). **Pre-launch: real GDPR/CCPA language needs a lawyer — flagged, not built.**

**Reuse:** email service, auth middleware, Firestore queries.

---

## Cost Controls

- **AI models:** follow-ups on Sonnet; single analysis pass on Opus; no Opus in interview loop
- **Prompt caching:** follow-up system block (server.js:4241) + last user turn (questionGeneration.js:251) + analysis context block. The stable somatic `followupPrompt` is the big cache win.
- **Per-session ceiling (net-new):** accumulate tokens on `sessionInfo` from streaming usage deltas; short-circuit `generateNextQuestion` past a cap. Add a 30-min session time cap.
- **Deepgram Nova-2** (~$0.004/min). Gate portrait render to final telling only.

---

## Data Model

Get this right on day one — the whole future editing pipeline depends on it.

```
stories/{storyId}
  userId, userEmail, createdAt
  promptId, promptText, warmupScenariosShown[]
  status: 'interview' | 'analyzed' | 'final_recorded' | 'shared'
  interviewReportId     → reports/{...}    (per-answer segments + word_timestamps)
  finalReportId         → reports/{...}    (one continuous take + word_timestamps)
  notes: [{
    type: 'strength' | 'gap',
    text,
    reference_time
  }]                                        // shown to user
  narrative_map: {
    segments: [{
      label: 'backstory' | 'scene_entry' | 'development' | 'peak' | 'turn' | 'resolution',
      start, end, summary, emotional_intensity
    }]
  }                                         // stored, not shown
  proposed_cut: [{ order, start, end }]     // stored — future automated editor seed
  final_video_gcs (vertical 9:16)
  final_signed_url
  thumbnail_gcs
```

**GCS layout:** `stories/{userId}/{storyId}/{interview|final_telling|metadata}/...`

---

## Critical Files

### Create (new files)
| File | Purpose |
|---|---|
| `public/story.html` | Consumer entry — auth gate + prompt selection + coaching |
| `public/story-notes.html` | AI craft notes loading + display |
| `public/story-final.html` | Final telling recorder |
| `public/story-result.html` | Playback + social share |
| `public/story-archive.html` | Personal archive |
| `public/js/story/coaching.js` | Warm-up state machine |
| `public/js/story/prompt-select.js` | Prompt card UI |
| `public/js/story/final-recorder.js` | Continuous recording + timer |
| `server/utils/storyAnalysis.js` | Opus analysis call + Firestore write |
| `scripts/seed-story-data.js` | Seed prompts, scenarios, interview template |

### Modify (existing files)
| File | What changes |
|---|---|
| `server.js` | `endStory` event; `story_id` on report doc (~2752); model fix (~4233); Deepgram guard (~786) |
| `server/utils/mediaQueue.js` | Confirm portrait pass-through (~170–307); optional center-crop fallback |
| `public/js/audio/video-recorder.js` | Portrait 9:16 capture constraints for story mode |
| `server/prompts/core-interviewing-techniques.js` | Somatic `followupPrompt` layer |
| `server/utils/reportGeneration.js` | Word-timestamp XML embedding |
| `public/js/main.js` | Story-mode time-gate branch (~399); URL parse (~766) |
| `public/js/interview/flow.js` | Thread `storyId`/`mode` (~248/269) |
| `firestore.rules` | `stories`, `story_prompts`, `warmup_scenarios` rules |
| `.env` | `DEEPGRAM_API_KEY` |

### Do Not Duplicate (reuse as-is)
- `public/js/auth.js` — Google + email auth flows
- `firstQuestion` URL handoff — flow.js:98 / server.js:3828
- `generateNextQuestion` + Deepgram + per-answer media pipeline
- `getResponsesWithSignedUrls` — server-reports.js
- Report stream/extract/cache pattern — server.js:4589+
- `setupVideoStream` / `getVideoMimeType` — video-recorder.js
- Upload route — server.js:7463
- `mediaQueue` + thumbnail logic
- `requireAuth` — server/middleware/auth.js:77
- Email service — server/services/email-service.js

---

## End-to-End Verification Checklist (MVP)

- [ ] `node scripts/seed-story-data.js` → confirm `story_prompts`, `warmup_scenarios`, and story interview template in Firestore
- [ ] `npm run dev` with `DEEPGRAM_API_KEY` set → Deepgram initializes, `/health` shows it connected
- [ ] Visit `/story` logged out → auth gate appears; sign in with Google → prompt cards load
- [ ] Pick a prompt → coaching runs (2–3 warm-up progressions, each escalating to 10, per-step skip works) → lands on `/i/` with prompt as first question (no `{{` blanking)
- [ ] Record 3–4 answers; Deepgram `word_timestamps` land in `reports/{id}/responses/*`; "I'm done" active immediately
- [ ] End → `endStory` fires; notes loading state → 2–4 craft notes render (no PAIRR report, no admin report)
- [ ] "Begin final telling" → continuous recording; timer warnings at 2:00/2:30/3:00; hard stop at 3:30; one re-record path works
- [ ] Final telling stored as native portrait 9:16 (full-screen, no bars, no blur); single `final_video_gcs` URL + thumbnail on `stories/{storyId}`
- [ ] Result page plays video; share icons deep-link the correct orientation; email arrives with thumbnail + links
- [ ] `/story-archive` lists the story for the logged-in user; playback works
- [ ] `stories/{storyId}` doc contains: `notes`, `narrative_map`, `proposed_cut`, both report links, both video URLs — all present and well-formed
- [ ] Cost check: interview follow-ups used Sonnet, analysis used Opus, cache hits in logs, session token/time ceiling enforced

---

## Deferred (Post-MVP)

- **Automated video editing:** cut the 15-min interview to 3 min using `narrative_map` + `proposed_cut` + `findBestSubsegment` (video.js:936) + FFmpeg. The whole data model exists to enable this.
- **Training flywheel:** compare raw interview ↔ AI proposed_cut ↔ final telling across users to derive an editing formula. Consider BigQuery export for analysis-scale queries.
- **Direct social API posting** (OAuth per platform)
- **Notes-phase clarification dialogue** ("practice mode")
- **Cloudflare R2 storage migration** (free egress at scale)
- **Returning-user / varied coaching** (skip warm-up option, varied scenarios)
- **Optional landscape auto-reframe** via subject-tracking (e.g. MediaPipe AutoFlip) — only if landscape demand re-emerges; vertical-native is the MVP commitment
