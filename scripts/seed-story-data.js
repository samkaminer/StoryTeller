#!/usr/bin/env node
/**
 * Seed script for StoryTeller AI — Milestone 0.
 *
 * Writes to Firestore:
 *   story_prompts       — 8 curated story prompts
 *   warmup_scenarios    — 24 profession/character scenarios (8 joyful, 8 sad, 8 wildcard)
 *   interviews/story-template-v1 — the StoryTeller interview template
 *
 * Usage: node scripts/seed-story-data.js
 *
 * Credentials (in priority order):
 *   1. FIREBASE_SERVICE_ACCOUNT env var (JSON string)
 *   2. FIREBASE_SERVICE_ACCOUNT_BASE64 env var (base64-encoded JSON)
 *   3. firebase-service-account.local.json at repo root
 */

require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function initFirebase() {
  if (admin.apps.length) return admin.firestore();

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(decoded)) });
  } else {
    const localPath = path.resolve(__dirname, '..', 'firebase-service-account.local.json');
    if (!fs.existsSync(localPath)) {
      console.error(
        'No Firebase credentials found.\n' +
        'Provide FIREBASE_SERVICE_ACCOUNT, FIREBASE_SERVICE_ACCOUNT_BASE64,\n' +
        'or place firebase-service-account.local.json at the repo root.'
      );
      process.exit(1);
    }
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(fs.readFileSync(localPath, 'utf8'))),
    });
  }

  return admin.firestore();
}

// ─── Story Prompts ────────────────────────────────────────────────────────────
// Broad enough to invite many stories; specific enough to invite emotional depth.
// Never use {{ }} — flow.js:103 blanks customFirstQuestion when it finds template vars.

const STORY_PROMPTS = [
  { text: "Tell me about a moment when your life seemed to shift on its axis.", category: "turning_point" },
  { text: "Tell me about a time you received something you didn't expect — and didn't know you needed.", category: "grace" },
  { text: "Tell me about a time the floor fell out from under you.", category: "disruption" },
  { text: "Tell me about a moment when you felt completely seen by another person.", category: "connection" },
  { text: "Tell me about a time you surprised yourself.", category: "self_discovery" },
  { text: "Tell me about a moment when you knew, without a doubt, you were in the right place.", category: "belonging" },
  { text: "Tell me about a time you had to let something go.", category: "release" },
  { text: "Tell me about a moment when you chose to stay when you could have left.", category: "commitment" },
];

// ─── Warmup Scenarios ─────────────────────────────────────────────────────────
// Used in the clowning warm-up: the client auto-runs 2–3 progressions, each
// escalating through randomized ascending intensity levels that always end at 10.
// 8 joyful, 8 sad, 8 wildcard — balanced pool so 2–3 picks hit one of each tone.

const WARMUP_SCENARIOS = [
  // joyful
  { text: "You're a kindergarten teacher on the last day of school before summer break.", tone: "joyful" },
  { text: "You're a baker who just pulled a perfect wedding cake from the oven after three failed attempts.", tone: "joyful" },
  { text: "You're a park ranger who spots the first wildflowers of the season after a long winter.", tone: "joyful" },
  { text: "You're a musician playing the final note of a sold-out hometown show.", tone: "joyful" },
  { text: "You're a chef whose grandmother's recipe just earned a standing ovation from a full restaurant.", tone: "joyful" },
  { text: "You're a pediatric nurse watching a child walk out of the hospital on their own two feet for the first time.", tone: "joyful" },
  { text: "You're a librarian watching a reluctant reader get completely lost in a book.", tone: "joyful" },
  { text: "You're a mail carrier delivering an unexpected package that makes someone burst into happy tears.", tone: "joyful" },

  // sad
  { text: "You're a moving company worker packing up the childhood home of an elderly couple.", tone: "sad" },
  { text: "You're a veterinarian saying a final goodbye to a beloved family pet at the end of a long day.", tone: "sad" },
  { text: "You're a retiring teacher clearing out your classroom of 30 years on your very last day.", tone: "sad" },
  { text: "You're a lighthouse keeper on your final night before the light is automated forever.", tone: "sad" },
  { text: "You're a train conductor making the last run on a route that's being discontinued.", tone: "sad" },
  { text: "You're a bookstore owner locking the door for the last time after 20 years.", tone: "sad" },
  { text: "You're a translator helping a refugee describe what they lost when they left their home.", tone: "sad" },
  { text: "You're a coach watching your team lose a championship in the final seconds.", tone: "sad" },

  // wildcard
  { text: "You're an astronaut on your first solo spacewalk, fixing something critical with a paper clip.", tone: "wildcard" },
  { text: "You're a food critic who just discovered the best meal of your life at a roadside gas station.", tone: "wildcard" },
  { text: "You're a competitive dog groomer three hours into styling a very uncooperative poodle.", tone: "wildcard" },
  { text: "You're a highway sign painter 40 feet up when a storm rolls in out of nowhere.", tone: "wildcard" },
  { text: "You're a mime who just witnessed something unbelievable and can't speak to tell anyone.", tone: "wildcard" },
  { text: "You're a professional napkin folder at a five-star restaurant during a sudden power outage.", tone: "wildcard" },
  { text: "You're a taxidermist who just realized you've accidentally mixed up two clients' pets.", tone: "wildcard" },
  { text: "You're a competitive bubble-wrap popper on the day of the world championships.", tone: "wildcard" },
];

// ─── Interview Template ───────────────────────────────────────────────────────
// followupPrompt layers on top of CORE_INTERVIEWING_TECHNIQUES (assembleInterviewPrompt adds it
// under "ADDITIONAL GUIDANCE" for follow-up turns). Keep it focused on somatic specifics.

const STORY_TEMPLATE_ID = 'story-template-v1';

const SOMATIC_FOLLOWUP_PROMPT = `This is a memory-narrative session. The person is re-entering a specific past moment — speaking from inside the experience, not reporting on it from a distance. Your role is that of a curious, present witness: genuinely interested, never in contention with the storyteller.

THE FOUR MOVES — available responses, not a sequence. Every question is in total reaction to what the person just gave.

DRILL IN (the default): Seize a specific word, name, detail, or phrase from what they just said. Echo their exact language — not a paraphrase, the exact word. Emotional and relational salience beats logistical specificity — a charged relational detail ("a friend I may be starting to date," "I stayed longer than I wanted to") outranks a physical or logistical one (how fast they rode, what route they took) even when the physical detail feels more concrete. Priority order: (1) emotionally or relationally charged phrases — feelings toward a person, what was at stake, what was hoped for or feared; (2) proper nouns and named people; (3) charged or incongruous words ("fine," "just kind of"); (4) compressed moments; (5) verbs of action; (6) throwaway physical details. Keep the question short. Direction: relational/emotional detail → feelings, stakes, what it means between them; named person → their action or how it landed; verb → consequence; charged word → its specific meaning here.

CHARACTERS: Other people in the scene are relational nodes. Before asking about any character, ask yourself: who is this story actually about? Hold that person as the primary thread across the whole conversation. Background characters — a musician at a venue, a stranger at a party, someone passing through the scene — provide texture but should never displace the central figure.

When a central character appears and the nature of the relationship hasn't been established yet, ask a brief grounding question before following any action — "Who is she to you?" / "How long have you known her?" / "What's your relationship like?" Don't pursue what they did together until you understand why they matter. Action has no weight without relationship context. This is the most important question you can ask early — it opens the entire emotional dimension of the story and doesn't need to be earned by waiting for the storyteller to volunteer it.

When the relationship itself is the central tension — a potential romantic partner, a complicated friendship, an estranged family member — that relationship is the story regardless of who else appears in the scene. Don't let a more concrete or recently-mentioned detail pull you away from what the story is fundamentally about. Follow not just what they did, but how it landed — and when the stakes haven't been named yet, ask for them.

SOMATIC (a corrective, not a default): When the person has drifted into their head, a short sensory or physical question brings them back. Deploy when you detect: analytical language ("I realized," "in retrospect," "looking back," "what that meant was"), emotional labeling without scene texture ("I was devastated" with nothing else), generalization ("I'm the kind of person who..."), summary or compression mode, or an energy lull. Do NOT deploy when they're already using physical language — they're already there. Note: interpretation delivered from inside the moment, still anchored to the scene, is not a trigger — follow it with DRILL IN. The trigger is when the scene has disappeared entirely and analysis is being used as an escape.

FORWARD PUSH (a co-default with DRILL IN): Move the story clock forward. Before asking each question, scan the last 2–3 exchanges: if they have all been about the same moment or beat, push the story forward — ask what happened next, where that led, what they did after. Do not wait for circular depth to arrive; move before it does. After 2 solid exchanges on any single beat, actively lean toward advancing the timeline. The story must move. If the person is already using forward language ("and then," "after that"), follow them — don't push on top of their momentum. If they're moving too fast past something genuinely meaningful, reach back and hold it. But the default bias is always forward — the interview should feel alive, moving, and never stuck.

ZOOM OUT (a scope shift): Pattern ("how rare was this for you?"), cost or gift ("what did that leave you with?"), counterfactual ("what would have happened if..."), witness ("what would someone watching have seen?"), moral ("what do you think that was trying to teach you?"). Opening forms can appear mid-story at a natural pause if they open new territory rather than close the story. The moral form belongs at the very end. Never zoom out while the scene is still being inhabited.

SILENCE MARKERS: The transcript may contain [pause] (1–2.5 seconds) or [long pause] (2.5+ seconds). A [pause] immediately before a word signals that word carries weight — worth seizing. Clustered [pause] markers signal a lull or lost access — give a specific handhold back into something named earlier. A [long pause] after something emotionally charged signals emotional labor.

EMOTIONAL DIFFICULTY: When emotional labor is present — signaled by [long pause], a sudden drop in energy, or content that is clearly hard — respond with exactly two sentences: one brief phrase that sees them without analysis or drama ("That's a lot to hold." / "That sounds like a hard moment."), then the question. Never more than that.

STORY COMPLETION: Genuine completion has a settled, arrived quality — receive it, offer one soft zoom-out, then the door. Premature closure has energy still present but suppressed — reach back gently through a specific detail already given. Exhaustion is lost access — give a specific handhold back into something named earlier but not fully opened.

TONE: Short questions. Specific. Gentle. Never commanding — no "stop," "listen," "wait." No double questions. Questions should sound like something a genuinely curious, warm person would say out loud.

GOVERNING PRINCIPLE: The schema is a vocabulary, not a grammar. It informs your listening; it does not direct your questions. When the storyteller goes somewhere unexpected and alive, follow them. Leave maximum room for their expression.`;

// ─── Seed ─────────────────────────────────────────────────────────────────────

async function seed() {
  const db = initFirebase();

  // Use multiple batches in case we exceed the 500-write Firestore limit
  let batch = db.batch();
  let writeCount = 0;

  async function flushIfNeeded() {
    if (writeCount >= 490) {
      await batch.commit();
      batch = db.batch();
      writeCount = 0;
    }
  }

  console.log(`Seeding ${STORY_PROMPTS.length} story_prompts...`);
  for (const prompt of STORY_PROMPTS) {
    batch.set(db.collection('story_prompts').doc(), {
      ...prompt,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    writeCount++;
    await flushIfNeeded();
  }

  console.log(`Seeding ${WARMUP_SCENARIOS.length} warmup_scenarios...`);
  for (const scenario of WARMUP_SCENARIOS) {
    batch.set(db.collection('warmup_scenarios').doc(), {
      ...scenario,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    writeCount++;
    await flushIfNeeded();
  }

  console.log(`Writing interview template (id: ${STORY_TEMPLATE_ID})...`);
  batch.set(db.collection('interviews').doc(STORY_TEMPLATE_ID), {
    title: 'StoryTeller AI',
    description: 'A somatic storytelling session. The storyteller re-enters a specific past moment and narrates from inside the experience.',
    purpose: 'Help the user tell a vivid, embodied story from their own life.',
    followupPrompt: SOMATIC_FOLLOWUP_PROMPT,
    followupModel: 'claude-sonnet-4-6',
    enableThinking: true,
    enableVideoRecording: true,
    enableMemoryService: false,
    enableWebSearch: false,
    requiredInformation: [],
    mode: 'story',
    hasExternalDocuments: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: false });
  writeCount++;

  await batch.commit();

  console.log('\n✓ Seed complete.');
  console.log(`  story_prompts:    ${STORY_PROMPTS.length} documents`);
  console.log(`  warmup_scenarios: ${WARMUP_SCENARIOS.length} documents`);
  console.log(`  interviews/${STORY_TEMPLATE_ID}: template written`);
  console.log(`\nStory template ID for M1 handoff URL: ${STORY_TEMPLATE_ID}`);
}

seed()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
