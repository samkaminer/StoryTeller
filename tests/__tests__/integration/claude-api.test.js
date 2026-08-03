const request = require('supertest');
const { createTestApp, closeTestServer, clearAllMocks } = require('../../test-factory');

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

describe('Claude API Endpoint', () => {
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

  describe('POST /api/claude', () => {
    it('should require messages in request body', async () => {
      const response = await request(app)
        .post('/api/claude')
        .set(AUTH_HEADER)
        .send({})
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Messages are required');
    });

    it('should handle text completion request', async () => {
      const mockMessages = [
        { role: 'user', content: 'Hello, Claude!' }
      ];

      const response = await request(app)
        .post('/api/claude')
        .set(AUTH_HEADER)
        .send({
          messages: mockMessages,
          stream: false
        })
        .expect(200);

      expect(response.body).toHaveProperty('content');
      expect(response.body).toHaveProperty('usage');
    });

    it('should handle streaming request', async () => {
      const mockMessages = [
        { role: 'user', content: 'Tell me a story' }
      ];

      const response = await request(app)
        .post('/api/claude')
        .set(AUTH_HEADER)
        .send({
          messages: mockMessages,
          stream: true
        })
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    });

    it('should check usage limits when pricingService is available', async () => {
      // Mock pricing service
      const mockPricingService = {
        checkUsageLimit: jest.fn().mockResolvedValue({ 
          allowed: false, 
          reason: 'Usage limit exceeded' 
        })
      };
      
      global.pricingService = mockPricingService;

      const response = await request(app)
        .post('/api/claude')
        .set(AUTH_HEADER)
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          userId: 'test-user',
          sessionId: 'test-session'
        })
        .expect(403);

      expect(response.body).toHaveProperty('error', 'Usage limit exceeded');
      expect(mockPricingService.checkUsageLimit).toHaveBeenCalled();
    });

    it('should increment usage after successful request', async () => {
      // Mock pricing service
      const mockPricingService = {
        checkUsageLimit: jest.fn().mockResolvedValue({ allowed: true }),
        incrementUsage: jest.fn().mockResolvedValue()
      };
      
      global.pricingService = mockPricingService;

      const response = await request(app)
        .post('/api/claude')
        .set(AUTH_HEADER)
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          userId: 'test-user',
          sessionId: 'test-session',
          stream: false
        })
        .expect(200);

      expect(mockPricingService.incrementUsage).toHaveBeenCalled();
    });

    it('should handle API errors gracefully', async () => {
      // This test would need to mock the fetch call to Claude API
      // For now, we'll test the error handling structure
      const response = await request(app)
        .post('/api/claude')
        .set(AUTH_HEADER)
        .send({
          messages: [{ role: 'user', content: 'Test error handling' }],
          model: 'invalid-model'
        });

      // The actual error depends on the API response
      // We're mainly testing that errors are handled
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });
});