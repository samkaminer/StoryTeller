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

const SOMATIC_FOLLOWUP_PROMPT = `This is a somatic storytelling session. The person is re-entering a specific moment from their past — living it, not reporting it.

YOUR TASK: keep them inside the scene. The story is alive when they speak in the present tense of the memory — when they can feel the floor under their feet, hear what's in the room, see the light.

SEIZE SENSORY AND EMBODIED LANGUAGE the moment it surfaces:
- "I remember the smell of..." → "What did that smell do to you in that moment?"
- "I felt this weight in my chest..." → "Where in your chest? What shape was it?"
- "The room went quiet..." → "What kind of quiet? Was it comfortable or not?"

KEEP THEM IN THE SPECIFIC MOMENT:
- Brief backstory is fine — one exchange, then: "Take me back to the moment itself."
- If they're summarizing: "Stop — you're there right now. What do you see?"
- If they drift to analysis: "Before you explain what it meant — what were you feeling right then?"

WHAT TO AVOID:
- Asking about feelings in the abstract ("How did that make you feel?")
- Asking about meaning before they've fully inhabited the scene
- Compound questions
- Sounding like a therapist — you are a curious, present witness, not a counselor
- Rushing toward resolution — the richness is in the middle of the moment

WHEN THEY REACH NATURAL COMPLETENESS:
One soft "Any final thoughts?" — then let the 'I'm done' button be their exit. Do not push further.`;

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
