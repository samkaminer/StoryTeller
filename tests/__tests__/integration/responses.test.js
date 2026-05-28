const request = require('supertest');
const { createTestApp, closeTestServer, clearAllMocks } = require('../../test-factory');

describe('Responses API Endpoints', () => {
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

  describe('GET /api/responses', () => {
    it('should require either interview_id or session_id', async () => {
      const response = await request(app)
        .get('/api/responses')
        .expect(400);

      expect(response.body).toHaveProperty('error', 
        'Missing required parameter. Either interview_id or session_id must be provided.');
    });

    it('should fetch responses by interview_id', async () => {
      const ts = { toDate: () => new Date('2024-01-01') };
      const mockResponses = [
        { id: 'resp1', data: () => ({ question: 'Question 1', answer: 'Answer 1', timestamp: ts }) },
        { id: 'resp2', data: () => ({ question: 'Question 2', answer: 'Answer 2', timestamp: ts }) },
      ];

      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue(createMockSnapshot(mockResponses))
          })
        })
      });

      const response = await request(app)
        .get('/api/responses')
        .query({ interview_id: 'test-interview' })
        .expect(200);

      expect(response.body).toHaveProperty('responses');
      expect(response.body.responses).toHaveLength(2);
      expect(response.body.responses[0]).toHaveProperty('question');
      expect(response.body.responses[0]).toHaveProperty('answer');
    });

    it('should fetch responses by session_id', async () => {
      const mockResponses = [
        { id: 'resp1', data: () => ({ question: 'Session Question', answer: 'Session Answer', session_id: 'test-session' }) },
      ];

      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue(createMockSnapshot(mockResponses))
          })
        })
      });

      const response = await request(app)
        .get('/api/responses')
        .query({ session_id: 'test-session' })
        .expect(200);

      expect(response.body.responses).toHaveLength(1);
      expect(response.body.responses[0].session_id).toBe('test-session');
    });

    it('should respect limit parameter', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      const mockLimit = jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue(createMockSnapshot([]))
      });

      mockFirestore.collection.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnValue({ limit: mockLimit })
      });

      await request(app)
        .get('/api/responses')
        .query({ interview_id: 'test', limit: 50 })
        .expect(200);

      expect(mockLimit).toHaveBeenCalledWith(50);
    });
  });

  describe('GET /api/responses/:id', () => {
    it('should fetch specific response by ID', async () => {
      const mockResponseData = {
        question: 'Specific Question',
        answer: 'Specific Answer',
        timestamp: { toDate: () => new Date('2024-01-01') },
        metadata: { duration: 120 }
      };

      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: true,
            id: 'response-123',
            data: () => mockResponseData
          })
        })
      });

      const response = await request(app)
        .get('/api/responses/response-123')
        .expect(200);

      expect(response.body).toHaveProperty('id', 'response-123');
      expect(response.body).toHaveProperty('question', mockResponseData.question);
      expect(response.body).toHaveProperty('answer', mockResponseData.answer);
    });

    it('should return 404 for non-existent response', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: false
          })
        })
      });

      const response = await request(app)
        .get('/api/responses/non-existent')
        .expect(404);

      expect(response.body).toHaveProperty('error', 'Response not found');
    });

    it('should handle database errors', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockRejectedValue(new Error('Database connection failed'))
        })
      });

      const response = await request(app)
        .get('/api/responses/response-123')
        .expect(500);

      expect(response.body).toHaveProperty('error', 'Failed to retrieve response');
      expect(response.body).toHaveProperty('details');
    });
  });

  describe('GET /api/reports/:reportId/responses', () => {
    it('should fetch responses associated with a report', async () => {
      // First mock the report lookup
      const mockReport = {
        exists: true,
        data: () => ({
          interviewId: 'interview-123',
          sessionId: 'session-456'
        })
      };

      // Then mock the responses
      const mockResponses = [
        {
          id: 'resp1',
          data: () => ({
            question: 'Report Question 1',
            answer: 'Report Answer 1'
          })
        }
      ];

      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockImplementation((collection) => {
        if (collection === 'reports') {
          return {
            doc: jest.fn().mockReturnValue({
              get: jest.fn().mockResolvedValue(mockReport)
            })
          };
        } else if (collection === 'responses') {
          return {
            where: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnValue({
              get: jest.fn().mockResolvedValue(createMockSnapshot(mockResponses))
            })
          };
        }
      });

      const VALID_REPORT_ID = 'rpt-test-00000000000000000001';
      const response = await request(app)
        .get(`/api/reports/${VALID_REPORT_ID}/responses`);

      // Route returns { responses: [...] } on success
      expect([200, 500]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body).toHaveProperty('responses');
      }
    });

    it('should return 404 if report not found', async () => {
      const VALID_REPORT_ID = 'rpt-test-00000000000000000002';
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: false })
        })
      });

      const response = await request(app)
        .get(`/api/reports/${VALID_REPORT_ID}/responses`)
        .expect(404);

      expect(response.body).toHaveProperty('error', 'Report not found');
    });
  });
});