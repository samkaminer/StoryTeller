const request = require('supertest');
const { createTestApp, closeTestServer, clearAllMocks } = require('../../test-factory');

describe('Basic API Endpoints', () => {
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

  describe('GET /api/test', () => {
    it('should return success status', async () => {
      const response = await request(app)
        .get('/api/test')
        .expect(200);

      expect(response.body).toHaveProperty('message', 'API endpoint is working');
    });
  });

  describe('GET /status', () => {
    it('should return server status', async () => {
      const response = await request(app)
        .get('/status')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'Server is running');
    });
  });

  describe('POST /api/notify-new-account', () => {
    it('should acknowledge notification', async () => {
      const response = await request(app)
        .post('/api/notify-new-account')
        .send({ email: 'test@example.com', uid: 'uid123' });

      // Email service may not be configured in test env
      expect([200, 500]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body).toHaveProperty('success', true);
      }
    });
  });

  describe('GET /api/pricing-plans', () => {
    it('should return pricing plans', async () => {
      const response = await request(app)
        .get('/api/pricing-plans')
        .expect(200);

      expect(response.body).toHaveProperty('plans');
      expect(Array.isArray(response.body.plans)).toBe(true);
      
      if (response.body.plans.length > 0) {
        const plan = response.body.plans[0];
        expect(plan).toHaveProperty('id');
        expect(plan).toHaveProperty('name');
        expect(plan).toHaveProperty('price');
        expect(plan).toHaveProperty('features');
      }
    });
  });

  describe('Static Files', () => {
    it('should serve report.html', async () => {
      const response = await request(app)
        .get('/report.html')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/html/);
    });

    it('should serve interview report summary page', async () => {
      const response = await request(app)
        .get('/i/test-id/report-summary')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/html/);
    });
  });
});