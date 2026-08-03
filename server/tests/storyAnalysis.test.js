const makeDb = () => {
  const update = jest.fn().mockResolvedValue();
  const doc = jest.fn(() => ({ update }));
  const collection = jest.fn(() => ({ doc }));

  return {
    db: { collection },
    update,
  };
};

const admin = {
  firestore: {
    FieldValue: {
      serverTimestamp: jest.fn(() => 'timestamp')
    }
  }
};

const sessionInfo = {
  assistantQuestions: [
    'What happened that day?',
    'What did you notice in the room?',
    'What changed by the end?'
  ],
  interviewResponses: [
    'I walked in expecting a routine meeting, but everyone had gone quiet and I could tell something had shifted before anyone said a word.',
    'The room felt smaller than usual. My manager was gripping a paper cup, and I remember the sound of the air conditioner more clearly than what anyone said first.',
    'By the end I realized I was the one who had to break the news to the team, and that was the moment the story stopped being abstract for me.'
  ]
};

describe('generateStoryAnalysis', () => {
  const originalFetch = global.fetch;
  const originalClaudeKey = process.env.CLAUDE_API_KEY;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    delete process.env.CLAUDE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.CLAUDE_API_KEY = originalClaudeKey;
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    jest.clearAllMocks();
  });

  test('writes analyzed notes when Anthropic returns the expected JSON payload', async () => {
    process.env.CLAUDE_API_KEY = 'claude-test-key';

    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            craft_notes: [
              { type: 'strength', text: 'The opening scene is concrete and immediate.', reference_time: null },
              { type: 'gap', text: 'The transition into the team reveal is still a little abstract.', reference_time: null }
            ],
            narrative_map: [
              { label: 'scene_entry', start_exchange: 0, end_exchange: 1, summary: 'The narrator enters the room.', emotional_intensity: 6 }
            ],
            proposed_cut: [
              { order: 1, start_exchange: 0, end_exchange: 2 }
            ]
          })
        }]
      })
    });

    const { db, update } = makeDb();
    const { generateStoryAnalysis } = require('../utils/storyAnalysis');

    const result = await generateStoryAnalysis('session-1', 'story-1', sessionInfo, db, admin);

    expect(result).toEqual({
      notes: [
        { type: 'strength', text: 'The opening scene is concrete and immediate.', reference_time: null },
        { type: 'gap', text: 'The transition into the team reveal is still a little abstract.', reference_time: null }
      ],
      analysisSource: 'anthropic'
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'analyzed',
      analysisSource: 'anthropic',
      notes: result.notes,
      narrative_map: [
        { label: 'scene_entry', start_exchange: 0, end_exchange: 1, summary: 'The narrator enters the room.', emotional_intensity: 6 }
      ],
      proposed_cut: [
        { order: 1, start_exchange: 0, end_exchange: 2 }
      ],
      analyzedAt: 'timestamp'
    }));
  });

  test('accepts ANTHROPIC_API_KEY and parses legacy tagged output', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key';

    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{
          type: 'text',
          text: `<craft_notes>[{"type":"strength","text":"The middle exchange finally lands in a specific moment.","reference_time":null}]</craft_notes>
<narrative_map>[{"label":"development","start_exchange":1,"end_exchange":2,"summary":"The pressure in the room becomes clear.","emotional_intensity":7}]</narrative_map>
<proposed_cut>[{"order":1,"start_exchange":1,"end_exchange":2}]</proposed_cut>`
        }]
      })
    });

    const { db, update } = makeDb();
    const { generateStoryAnalysis } = require('../utils/storyAnalysis');

    const result = await generateStoryAnalysis('session-2', 'story-2', sessionInfo, db, admin);

    expect(result.analysisSource).toBe('anthropic');
    expect(result.notes).toEqual([
      { type: 'strength', text: 'The middle exchange finally lands in a specific moment.', reference_time: null }
    ]);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'analyzed',
      analysisSource: 'anthropic'
    }));
  });

  test('falls back to heuristic notes when Anthropic fails', async () => {
    process.env.CLAUDE_API_KEY = 'claude-test-key';

    global.fetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid model'
    });

    const { db, update } = makeDb();
    const { generateStoryAnalysis } = require('../utils/storyAnalysis');

    const result = await generateStoryAnalysis('session-3', 'story-3', sessionInfo, db, admin);

    expect(result.analysisSource).toBe('fallback');
    expect(result.notes).toHaveLength(2);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'analyzed',
      analysisSource: 'fallback',
      analysisError: expect.stringContaining('Anthropic API error 400'),
      notes: result.notes
    }));
  });
});
