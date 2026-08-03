const request = require('supertest');
const { createTestApp, closeTestServer, clearAllMocks } = require('../../test-factory');

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

describe('Pricing/Subscription API Endpoints', () => {
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

  describe('GET /api/subscription', () => {
    it('should require auth token', async () => {
      const response = await request(app)
        .get('/api/subscription')
        .expect(401);

      expect(response.body).toHaveProperty('error', 'Authorization token required');
    });

    it('should return subscription data for authenticated user', async () => {
      const response = await request(app)
        .get('/api/subscription').set(AUTH_HEADER)
        .expect(200);

      expect(response.body).toHaveProperty('subscription');
      expect(response.body).toHaveProperty('canCompleteInterview');
      expect(response.body).toHaveProperty('pricingPlans');
      expect(response.body).toHaveProperty('freeTrialLimit');
    });
  });

  describe('POST /api/subscription/checkout', () => {
    it('should require planId', async () => {
      const response = await request(app)
        .post('/api/subscription/checkout').set(AUTH_HEADER)
        .send({})
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Plan ID is required');
    });

    it('should create checkout session', async () => {
      const response = await request(app)
        .post('/api/subscription/checkout').set(AUTH_HEADER)
        .send({ planId: 'starter' })
        .expect(200);

      expect(response.body).toHaveProperty('checkoutUrl');
      expect(response.body.checkoutUrl).toContain('stripe.com');
    });
  });

  describe('POST /api/webhooks/stripe', () => {
    it('should return 400 when webhook secret not configured', async () => {
      const response = await request(app)
        .post('/api/webhooks/stripe')
        .send({})
        .expect(400);
    });
  });

  describe('POST /api/test/increment-usage', () => {
    it('should increment usage for authenticated user', async () => {
      const response = await request(app)
        .post('/api/test/increment-usage').set(AUTH_HEADER)
        .send({})
        .expect(200);

      expect(response.body).toHaveProperty('message', 'Usage incremented successfully');
      expect(response.body).toHaveProperty('subscription');
      expect(response.body).toHaveProperty('canCompleteInterview');
    });
  });

  describe('POST /api/test/reset-usage', () => {
    it('should reset usage for authenticated user', async () => {
      const response = await request(app)
        .post('/api/test/reset-usage').set(AUTH_HEADER)
        .send({})
        .expect(200);

      expect(response.body).toHaveProperty('message', 'Usage reset successfully');
      expect(response.body).toHaveProperty('subscription');
      expect(response.body).toHaveProperty('canCompleteInterview');
    });
  });
});
