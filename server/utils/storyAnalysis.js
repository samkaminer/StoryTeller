'use strict';

const STORY_ANALYSIS_MODEL = process.env.STORY_ANALYSIS_MODEL || 'claude-sonnet-4-6';

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

function getAnthropicApiKey() {
    return process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '';
}

function readAnthropicTextBlocks(contentBlocks) {
    if (!Array.isArray(contentBlocks)) return '';

    return contentBlocks
        .filter(block => block && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
        .trim();
}

function trimErrorMessage(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return 'Unknown story analysis error';
    }

    return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function sanitizeNotes(notes) {
    if (!Array.isArray(notes)) return [];

    return notes
        .map(note => {
            if (!note || typeof note !== 'object') return null;

            const text = typeof note.text === 'string' ? note.text.trim() : '';
            if (!text) return null;

            return {
                type: note.type === 'gap' ? 'gap' : 'strength',
                text,
                reference_time: note.reference_time ?? null,
            };
        })
        .filter(Boolean)
        .slice(0, 4);
}

function sanitizeObjectArray(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(item => item && typeof item === 'object');
}

function extractJsonCandidate(text) {
    if (!text) return null;

    const fencedJson = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedJson) return fencedJson[1].trim();

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

    return text.slice(firstBrace, lastBrace + 1).trim();
}

function parseStructuredAnalysis(text) {
    const tagged = {
        craftNotes: sanitizeNotes(parseTag(text, 'craft_notes')),
        narrativeMap: sanitizeObjectArray(parseTag(text, 'narrative_map')),
        proposedCut: sanitizeObjectArray(parseTag(text, 'proposed_cut')),
    };

    if (tagged.craftNotes.length || tagged.narrativeMap.length || tagged.proposedCut.length) {
        return tagged;
    }

    const jsonCandidate = extractJsonCandidate(text);
    if (!jsonCandidate) return tagged;

    try {
        const parsed = JSON.parse(jsonCandidate);
        return {
            craftNotes: sanitizeNotes(parsed.craft_notes || parsed.notes || []),
            narrativeMap: sanitizeObjectArray(parsed.narrative_map || parsed.narrativeMap || []),
            proposedCut: sanitizeObjectArray(parsed.proposed_cut || parsed.proposedCut || []),
        };
    } catch {
        return tagged;
    }
}

function buildHeuristicNotes(sessionInfo) {
    const responses = (sessionInfo?.interviewResponses || [])
        .map(response => typeof response === 'string' ? response.trim() : '')
        .filter(Boolean);

    if (!responses.length) return [];

    const wordCounts = responses.map(response => response.split(/\s+/).filter(Boolean).length);
    const longestCount = Math.max(...wordCounts);
    const longestIndex = wordCounts.indexOf(longestCount);
    const shortResponses = wordCounts.filter(count => count < 25).length;
    const averageWords = Math.round(wordCounts.reduce((sum, count) => sum + count, 0) / wordCounts.length);

    return [
        {
            type: 'strength',
            text: longestCount >= 35
                ? `Exchange ${longestIndex + 1} carries the most developed material in the interview. That part has more texture and momentum than the surrounding beats.`
                : 'One part of the interview clearly opens up beyond summary and into a fuller beat. That section feels like the strongest anchor in the material.',
            reference_time: null,
        },
        {
            type: 'gap',
            text: shortResponses >= Math.ceil(responses.length / 2)
                ? 'Several exchanges stay compressed, so the causal turn of the story never fully comes into focus on the page.'
                : averageWords > 45
                    ? 'The interview covers a lot of ground, but the exact hinge moment between setup and change stays diffuse.'
                    : 'The material has momentum, but it moves quickly across beats, which makes the most consequential turn harder to hold onto.',
            reference_time: null,
        }
    ];
}

async function writeStoryAnalysis(db, admin, storyId, payload) {
    if (!storyId || !db) return;

    await db.collection('stories').doc(storyId).update(payload);
}

async function generateStoryAnalysis(sessionId, storyId, sessionInfo, db, admin) {
    let craftNotes = [];
    let narrativeMap = [];
    let proposedCut = [];
    let analysisSource = 'anthropic';
    let analysisError = null;

    try {
        const anthropicApiKey = getAnthropicApiKey();
        if (!anthropicApiKey) {
            throw new Error('Anthropic API key not set');
        }

        const transcript = buildTranscript(sessionInfo);
        const systemPrompt = 'You are a craft editor helping a storyteller understand what worked in their interview and where to go deeper. Return valid JSON only.';

        const userMessage = `Interview transcript:\n\n${transcript}\n\nReturn a single JSON object with exactly these keys:
- "craft_notes": array of 2 to 4 observations. Each object must be { "type": "strength" | "gap", "text": "...", "reference_time": null }.
- "narrative_map": array of segments covering the full interview. Each object must be { "label": "backstory" | "scene_entry" | "development" | "peak" | "turn" | "resolution", "start_exchange": <number>, "end_exchange": <number>, "summary": "...", "emotional_intensity": <1-10> }.
- "proposed_cut": array of exchanges that form an ideal 3-minute telling structure. Each object must be { "order": <number>, "start_exchange": <number>, "end_exchange": <number> }.

Rules for craft_notes:
- "strength" means a moment that genuinely landed: specific, embodied, alive.
- "gap" means a moment where clarity broke or the storyteller retreated from something specific.
- Write about the story itself. No emotional reactions, no therapeutic framing, no directing.`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': anthropicApiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: STORY_ANALYSIS_MODEL,
                max_tokens: 4096,
                system: systemPrompt,
                messages: [{
                    role: 'user',
                    content: userMessage,
                }],
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Anthropic API error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const content = readAnthropicTextBlocks(data.content);
        const parsed = parseStructuredAnalysis(content);

        craftNotes = parsed.craftNotes;
        narrativeMap = parsed.narrativeMap;
        proposedCut = parsed.proposedCut;

        if (!craftNotes.length) {
            throw new Error('Anthropic response did not include any usable craft notes');
        }
    } catch (err) {
        analysisSource = 'fallback';
        analysisError = trimErrorMessage(err.message);
        craftNotes = buildHeuristicNotes(sessionInfo);

        if (craftNotes.length) {
            console.warn(`[${sessionId}] Story analysis fell back to heuristic notes:`, analysisError);
        } else {
            console.error(`[${sessionId}] Story analysis failed:`, analysisError);
        }
    }

    try {
        if (craftNotes.length) {
            await writeStoryAnalysis(db, admin, storyId, {
                notes: craftNotes,
                narrative_map: narrativeMap,
                proposed_cut: proposedCut,
                status: 'analyzed',
                analysisSource,
                analysisError,
                analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(`[${sessionId}] Story analysis written to Firestore for storyId: ${storyId} via ${analysisSource}`);
        } else {
            await writeStoryAnalysis(db, admin, storyId, {
                status: 'error',
                analysisSource,
                analysisError: analysisError || 'No story notes could be generated',
            });
        }
    } catch (writeErr) {
        console.error(`[${sessionId}] Failed to write story analysis to Firestore:`, writeErr.message);
    }

    return { notes: craftNotes, analysisSource };
}

module.exports = { generateStoryAnalysis };
