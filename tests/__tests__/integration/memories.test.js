const request = require('supertest');
const { createTestApp, closeTestServer, clearAllMocks } = require('../../test-factory');
const memoryService = require('../../../memoryService');

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

describe('Memory Management API Endpoints', () => {
  let app, server;

  beforeAll(() => {
    const testApp = createTestApp();
    app = testApp.app;
    server = testApp.server;
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  afterEach(() => {
    clearAllMocks();
  });

  describe('GET /api/memories', () => {
    it('should require userEmail parameter', async () => {
      const response = await request(app)
        .get('/api/memories').set(AUTH_HEADER)
        .expect(400);

      expect(response.body).toHaveProperty('error', 'userEmail is required');
    });

    it('should return memories for user', async () => {
      memoryService.getAll.mockResolvedValue([
        {
          id: 'memory1',
          content: 'Test memory 1',
          timestamp: new Date()
        },
        {
          id: 'memory2',
          content: 'Test memory 2',
          timestamp: new Date()
        }
      ]);

      const response = await request(app)
        .get('/api/memories').set(AUTH_HEADER)
        .query({ userEmail: 'test@example.com' })
        .expect(200);

      expect(response.body).toHaveProperty('userEmail', 'test@example.com');
      expect(response.body).toHaveProperty('memories');
      expect(response.body.memories).toHaveLength(2);
    });

    it('should filter memories by interviewId', async () => {
      memoryService.getAll.mockResolvedValue([
        {
          id: 'memory1',
          content: 'Interview-specific memory',
          interviewId: 'interview123'
        }
      ]);

      const response = await request(app)
        .get('/api/memories').set(AUTH_HEADER)
        .query({ 
          userEmail: 'test@example.com',
          interviewId: 'interview123'
        })
        .expect(200);

      expect(response.body.memories).toHaveLength(1);
      expect(memoryService.getAll).toHaveBeenCalledWith(
        'test@example.com',
        'interview123'
      );
    });

    it('should handle memory service errors', async () => {
      memoryService.getAll.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/memories').set(AUTH_HEADER)
        .query({ userEmail: 'test@example.com' })
        .expect(500);

      expect(response.body).toHaveProperty('error', 'Failed to retrieve memories');
      expect(response.body).toHaveProperty('details', 'Database error');
    });
  });

  describe('DELETE /api/memories', () => {
    it('should require userEmail parameter', async () => {
      const response = await request(app)
        .delete('/api/memories').set(AUTH_HEADER)
        .expect(400);

      expect(response.body).toHaveProperty('error', 'userEmail is required');
    });

    it('should return not implemented status', async () => {
      // According to the code, delete is not yet implemented
      const response = await request(app)
        .delete('/api/memories').set(AUTH_HEADER)
        .query({ userEmail: 'test@example.com' })
        .expect(501);

      expect(response.body).toHaveProperty('message', 'Memory deletion not yet implemented');
      expect(response.body).toHaveProperty('note');
    });
  });

  describe('POST /api/memories/contextual', () => {
    it('should require all parameters', async () => {
      const response = await request(app)
        .post('/api/memories/contextual').set(AUTH_HEADER)
        .send({ userEmail: 'test@example.com' })
        .expect(400);

      expect(response.body).toHaveProperty('error', 'userEmail, interviewId, and context are required');
    });

    it('should return contextual memories', async () => {
      const mockContextualMemories = [
        {
          id: 'memory1',
          content: 'Relevant memory',
          relevanceScore: 0.9
        }
      ];

      memoryService.getContextualMemories.mockResolvedValue(mockContextualMemories);

      const response = await request(app)
        .post('/api/memories/contextual').set(AUTH_HEADER)
        .send({
          userEmail: 'test@example.com',
          interviewId: 'interview123',
          context: 'Tell me about your experience'
        })
        .expect(200);

      expect(response.body).toHaveProperty('userEmail', 'test@example.com');
      expect(response.body).toHaveProperty('interviewId', 'interview123');
      expect(response.body).toHaveProperty('contextualMemories');
      expect(response.body.contextualMemories).toEqual(mockContextualMemories);
    });

    it('should handle service unavailable', async () => {
      // Mock memory service as not initialized
      memoryService.isInitialized.mockReturnValue(false);

      const response = await request(app)
        .post('/api/memories/contextual').set(AUTH_HEADER)
        .send({
          userEmail: 'test@example.com',
          interviewId: 'interview123',
          context: 'Test context'
        })
        .expect(503);

      expect(response.body).toHaveProperty('error', 'Memory service not available');
    });
  });
});