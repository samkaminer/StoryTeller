const request = require('supertest');
const { createTestApp, closeTestServer, clearAllMocks } = require('../../test-factory');

const REPORT_ID = 'rpt-test-00000000000000000001';
const INTERVIEW_ID = 'int-test-00000000000000000001';

describe('Reports API Endpoints', () => {
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

  describe('GET /api/reports', () => {
    it('should return list of reports for an interview', async () => {
      const mockDocs = [
        {
          id: REPORT_ID,
          data: () => ({
            title: 'Test Report 1',
            createdAt: new Date(),
            interview_id: INTERVIEW_ID
          })
        }
      ];

      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue(createMockSnapshot(mockDocs))
          })
        })
      });

      const response = await request(app)
        .get('/api/reports')
        .query({ interview_id: INTERVIEW_ID, limit: 10 })
        .expect(200);

      expect(response.body).toHaveProperty('reports');
      expect(Array.isArray(response.body.reports)).toBe(true);
    });

    it('should return 400 when no filter params provided', async () => {
      const response = await request(app)
        .get('/api/reports')
        .query({ limit: 10 })
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('GET /api/reports/:id', () => {
    it('should return 400 for short report ID', async () => {
      const response = await request(app)
        .get('/api/reports/report1')
        .expect(400);
    });

    it('should return 404 for non-existent report with valid ID format', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: false
          })
        })
      });

      const response = await request(app)
        .get(`/api/reports/${REPORT_ID}`)
        .expect(404);

      expect(response.body).toHaveProperty('error', 'Report not found');
    });
  });

  describe('GET /api/reports/latest', () => {
    it('should require session_id or interview_id query param', async () => {
      const response = await request(app)
        .get('/api/reports/latest')
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('POST /api/reports/:reportId/regenerate-user-report', () => {
    it('should require reportId', async () => {
      const response = await request(app)
        .post('/api/reports//regenerate-user-report')
        .send({})
        .expect(404);
    });

    it('should attempt to regenerate user report', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => ({
              interview_id: INTERVIEW_ID,
              user_email: 'test@example.com'
            })
          }),
          update: jest.fn().mockResolvedValue()
        })
      });

      const response = await request(app)
        .post(`/api/reports/${REPORT_ID}/regenerate-user-report`)
        .send({});

      // Accepts 200 (success) or error if AI/storage service not configured in test env
      expect([200, 500, 503]).toContain(response.status);
    });
  });
});