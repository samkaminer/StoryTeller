'use strict';

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

function buildTranscript(sessionInfo) {
    const questions = (sessionInfo.assistantQuestions || []).map(q =>
        typeof q === 'string' ? q : (q.text || q.question || JSON.stringify(q))
    );
    const responses = sessionInfo.interviewResponses || [];
    const maxLen = Math.max(questions.length, responses.length);
    const lines = [];
    for (let i = 0; i < maxLen; i++) {
        lines.push(`[${i + 1}] Interviewer: ${questions[i] || ''}`);
        lines.push(`    Storyteller: ${responses[i] || ''}`);
        lines.push('');
    }
    return lines.join('\n');
}

function extractTag(text, tag) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const start = text.indexOf(open);
    const end = text.indexOf(close);
    if (start === -1 || end === -1) return null;
    return text.slice(start + open.length, end).trim();
}

function parseTag(text, tag) {
    try {
        const raw = extractTag(text, tag);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

async function generateStoryAnalysis(sessionId, storyId, sessionInfo, db, admin) {
    try {
        if (!CLAUDE_API_KEY) throw new Error('CLAUDE_API_KEY not set');

        const transcript = buildTranscript(sessionInfo);

        const systemPrompt = `You are a craft editor helping a storyteller understand what worked in their interview and where to go deeper. You will receive a transcript of an AI-guided memory interview. Produce three outputs, each wrapped in its own XML tag: <craft_notes>, <narrative_map>, and <proposed_cut>.`;

        const userMessage = `Interview transcript:\n\n${transcript}\n\nProduce the three outputs now.

<craft_notes>
A JSON array of 2–4 observations. Each object: { "type": "strength" | "gap", "text": "...", "reference_time": null }
- "strength": a moment that genuinely landed — specific, embodied, alive.
- "gap": a moment where clarity broke or the storyteller retreated from something specific.
- Write about the story itself. No emotional reactions, no therapeutic framing, no directing.
- 2 minimum, 4 maximum.
</craft_notes>

<narrative_map>
A JSON array of segments covering the full interview. Each object: { "label": "backstory" | "scene_entry" | "development" | "peak" | "turn" | "resolution", "start_exchange": <number>, "end_exchange": <number>, "summary": "...", "emotional_intensity": <1-10> }
start_exchange and end_exchange are zero-indexed exchange numbers.
</narrative_map>

<proposed_cut>
A JSON array of exchanges that form an ideal 3-minute telling structure. Each object: { "order": <number>, "start_exchange": <number>, "end_exchange": <number> }
Prioritize the most specific, embodied exchanges. Reorder for narrative shape if it improves the arc.
</proposed_cut>`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'prompt-caching-2024-07-31',
            },
            body: JSON.stringify({
                model: 'claude-opus-4-7',
                max_tokens: 4096,
                system: [
                    {
                        type: 'text',
                        text: systemPrompt,
                        cache_control: { type: 'ephemeral' },
                    }
                ],
                messages: [{ role: 'user', content: userMessage }],
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Anthropic API error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const content = data.content?.[0]?.text || '';

        const craftNotes   = parseTag(content, 'craft_notes');
        const narrativeMap = parseTag(content, 'narrative_map');
        const proposedCut  = parseTag(content, 'proposed_cut');

        if (storyId && db) {
            try {
                await db.collection('stories').doc(storyId).update({
                    notes: craftNotes,
                    narrative_map: narrativeMap,
                    proposed_cut: proposedCut,
                    status: 'analyzed',
                    analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                console.log(`[${sessionId}] Story analysis written to Firestore for storyId: ${storyId}`);
            } catch (writeErr) {
                console.error(`[${sessionId}] Failed to write story analysis to Firestore:`, writeErr.message);
            }
        }

        return { notes: craftNotes };

    } catch (err) {
        console.error(`[${sessionId}] Story analysis failed:`, err.message);
        if (storyId && db) {
            try {
                await db.collection('stories').doc(storyId).update({ status: 'error' });
            } catch { /* best-effort */ }
        }
        return { notes: [] };
    }
}

module.exports = { generateStoryAnalysis };
