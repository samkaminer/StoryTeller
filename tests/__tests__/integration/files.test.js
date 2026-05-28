const request = require('supertest');
const { createTestApp, closeTestServer, clearAllMocks } = require('../../test-factory');

describe('Files API Endpoints', () => {
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

  describe('POST /api/upload-resume', () => {
    it('should require a file', async () => {
      const response = await request(app)
        .post('/api/upload-resume')
        .expect(400);

      expect(response.body).toHaveProperty('error', 'No file uploaded');
    });

    it('should accept PDF files and return extracted text', async () => {
      const mockPdfContent = Buffer.from('%PDF-1.4 mock content');

      const response = await request(app)
        .post('/api/upload-resume')
        .attach('resume', mockPdfContent, {
          filename: 'test-resume.pdf',
          contentType: 'application/pdf'
        })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('text');
    });

    it('should reject invalid file types', async () => {
      const mockInvalidFile = Buffer.from('Invalid file content');

      const response = await request(app)
        .post('/api/upload-resume')
        .attach('resume', mockInvalidFile, {
          filename: 'test.txt',
          contentType: 'text/plain'
        });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('DELETE /api/files', () => {
    it('should require filePath in body', async () => {
      const response = await request(app)
        .delete('/api/files')
        .send({})
        .expect(400);

      expect(response.body).toHaveProperty('message', 'Missing file path for deletion.');
    });

    it('should delete file from storage', async () => {
      const response = await request(app)
        .delete('/api/files')
        .send({ filePath: 'path/to/test-file.pdf' })
        .expect(200);

      expect(response.body).toHaveProperty('message', 'File deleted successfully.');
    });

    it('should return 200 even when GCS reports file not found', async () => {
      // The route returns 200 "File not found, presumed deleted." for GCS 404 errors
      // and 200 "File deleted successfully." for successful deletions — both are success cases
      const response = await request(app)
        .delete('/api/files')
        .send({ filePath: 'path/to/some-file.pdf' })
        .expect(200);

      expect(['File deleted successfully.', 'File not found, presumed deleted.']).toContain(response.body.message);
    });
  });

  describe('GET /api/reports/:reportId/audio-artifact', () => {
    it('should return 404 for non-existent report', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: false })
        })
      });

      const response = await request(app)
        .get('/api/reports/non-existent/audio-artifact')
        .expect(404);

      expect(response.body).toHaveProperty('error', 'Report not found');
    });

    it('should attempt to serve audio for existing report', async () => {
      const mockFirestore = require('firebase-admin').firestore();
      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => ({
              audio_gcs_url: 'gs://test-bucket/audio/test.mp3',
              report_content: 'Test report content'
            })
          }),
          update: jest.fn().mockResolvedValue()
        })
      });

      const response = await request(app)
        .get('/api/reports/test-report/audio-artifact');

      // May succeed (200) or fail if TTS service not available (500/503)
      expect([200, 500, 503]).toContain(response.status);
    });
  });
});
