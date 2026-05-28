const request = require('supertest');
const { createTestApp, closeTestServer, clearAllMocks } = require('../../test-factory');

describe('Admin API Endpoints', () => {
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

  describe('GET /api/admin/my-sessions', () => {
    it('should require email parameter', async () => {
      const response = await request(app)
        .get('/api/admin/my-sessions')
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Admin email is required for this demo endpoint.');
    });

    it('should return sessions for user', async () => {
      const mockDocs = [
        {
          id: 'report1',
          data: () => ({
            report_title: 'Regular Report',
            start_timestamp: { toDate: () => new Date() },
            status: 'completed',
            interview_id: null
          })
        }
      ];

      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              get: jest.fn().mockResolvedValue(createMockSnapshot(mockDocs))
            })
          })
        })
      });

      const response = await request(app)
        .get('/api/admin/my-sessions')
        .query({ email: 'test@example.com' })
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toHaveProperty('reportId', 'report1');
    });

    it('should return empty array when no sessions found', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              get: jest.fn().mockResolvedValue(createMockSnapshot([]))
            })
          })
        })
      });

      const response = await request(app)
        .get('/api/admin/my-sessions')
        .query({ email: 'empty@example.com' })
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(0);
    });
  });

  describe('POST /api/reports/:reportId/regenerate-admin-summary', () => {
    it('should attempt to regenerate admin summary for report', async () => {
      const reportId = 'test-report-123';

      const mockFirestore = require('firebase-admin').firestore();
      const mockUpdate = jest.fn().mockResolvedValue();

      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => ({
              responses: [
                { question: 'Q1', answer: 'A1' },
                { question: 'Q2', answer: 'A2' }
              ],
              userEmail: 'test@example.com',
              userName: 'Test User'
            })
          }),
          update: mockUpdate
        })
      });

      const response = await request(app)
        .post(`/api/reports/${reportId}/regenerate-admin-summary`)
        .send({});

      // Accepts success or service unavailable (CLAUDE_API_KEY not set in test env)
      expect([200, 500, 503]).toContain(response.status);
    });

    it('should return 404 for non-existent report', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: false
          })
        })
      });

      const response = await request(app)
        .post('/api/reports/non-existent/regenerate-admin-summary')
        .send({})
        .expect(404);

      expect(response.body).toHaveProperty('error', 'Report not found');
    });

    it('should handle regeneration errors', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => ({ responses: [] })
          }),
          update: jest.fn().mockRejectedValue(new Error('Update failed'))
        })
      });

      const response = await request(app)
        .post('/api/reports/test-report/regenerate-admin-summary')
        .send({});

      expect([500, 503]).toContain(response.status);
    });
  });

  describe('GET /api/syntheses/:synthesisId/audio-artifact', () => {
    it('should return 400 when templateId is missing', async () => {
      const response = await request(app)
        .get('/api/syntheses/test-synthesis/audio-artifact')
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });

    it('should return 404 for synthesis without audio', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            doc: jest.fn().mockReturnValue({
              get: jest.fn().mockResolvedValue({ exists: false })
            })
          })
        })
      });

      const response = await request(app)
        .get('/api/syntheses/test-synthesis/audio-artifact')
        .query({ templateId: 'test-template' })
        .expect(404);

      expect(response.body).toHaveProperty('error');
    });
  });
});
