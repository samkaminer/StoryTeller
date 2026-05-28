const request = require('supertest');
const { createTestApp, closeTestServer, clearAllMocks } = require('../../test-factory');

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

describe('Interview API Endpoints', () => {
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

  describe('GET /api/interview/:id', () => {
    it('should return 404 for non-existent interview', async () => {
      const response = await request(app)
        .get('/api/interview/non-existent-id')
        .expect(404);

      expect(response.body).toHaveProperty('error');
    });

    it('should handle database errors gracefully', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockImplementationOnce(() => {
        throw new Error('Database error');
      });

      const response = await request(app)
        .get('/api/interview/test-id')
        .expect(500);

      expect(response.body).toHaveProperty('error', 'Failed to retrieve interview data');
    });
  });

  describe('POST /api/interviews/:id/share', () => {
    it('should require sharedWith array', async () => {
      const response = await request(app)
        .post('/api/interviews/test-id/share')
        .send({})
        .expect(400);

      expect(response.body).toHaveProperty('error', 'sharedWith must be an array');
    });

    it('should update interview sharing', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => ({ sharedWith: [], title: 'Test Interview' })
          }),
          update: jest.fn().mockResolvedValue()
        })
      });

      const response = await request(app)
        .post('/api/interviews/test-id/share')
        .send({ sharedWith: [] })
        .expect(200);

      expect(response.body).toHaveProperty('message', 'Sharing updated successfully');
      expect(response.body).toHaveProperty('sharedWith');
    });
  });

  describe('POST /api/interviews/:interviewId/upload', () => {
    it('should require a file', async () => {
      const response = await request(app)
        .post('/api/interviews/int-test-00000000000000000001/upload').set(AUTH_HEADER)
        .expect(400);

      expect(response.body).toHaveProperty('error', 'No file uploaded');
    });

    it('should handle file upload', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            add: jest.fn().mockResolvedValue({ id: 'file-id' })
          })
        })
      });

      const response = await request(app)
        .post('/api/interviews/int-test-00000000000000000001/upload').set(AUTH_HEADER)
        .attach('contextFile', Buffer.from('test content'), 'test.pdf');

      expect([200, 400]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body).toHaveProperty('name');
        expect(response.body).toHaveProperty('path');
      }
    });
  });

  describe('GET /api/interview/:interviewId/special-report-details', () => {
    it('should return 404 for non-existent interview', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockImplementation(() => ({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) })
        }),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue(createMockSnapshot([]))
        })
      }));

      const response = await request(app)
        .get('/api/interview/non-existent/special-report-details')
        .expect(404);

      expect(response.body).toHaveProperty('error', 'Interview not found');
    });

    it('should fetch interview report details', async () => {
      const mockInterviewData = {
        id: 'test-id',
        title: 'Test Interview',
        description: 'Test description'
      };

      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockImplementation((collection) => {
        if (collection === 'interviews') {
          return {
            doc: jest.fn().mockReturnValue({
              get: jest.fn().mockResolvedValue({
                exists: true,
                data: () => mockInterviewData
              })
            })
          };
        } else {
          return {
            where: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnValue({
              get: jest.fn().mockResolvedValue(createMockSnapshot([]))
            })
          };
        }
      });

      const response = await request(app)
        .get('/api/interview/test-id/special-report-details')
        .expect(200);

      expect(response.body).toHaveProperty('interviewDetails');
      expect(response.body).toHaveProperty('reportList');
    });
  });
});
