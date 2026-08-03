// Integration test for the modular server
// Verifies all modules work together

const request = require('supertest');
const app = require('./server');

describe('Server Integration Tests', () => {
    afterAll((done) => {
        done();
    });

    describe('Basic endpoints', () => {
        test('GET /api/test returns success', async () => {
            const res = await request(app).get('/api/test');
            expect(res.status).toBe(200);
            expect(res.body.message).toBe('API endpoint is working');
        });

        test('GET /status returns server status', async () => {
            const res = await request(app).get('/status');
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('Server is running');
        });
    });

    describe('Static files', () => {
        test('serves static files from public directory', async () => {
            // The main.js file should be served
            const res = await request(app).get('/js/main.js');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('javascript');
        });
    });

    describe('HTML routes', () => {
        test('GET /i redirects to /i/', async () => {
            const res = await request(app).get('/i');
            expect(res.status).toBe(301);
            expect(res.headers.location).toBe('/i/');
        });

        test('GET /i/ serves interview page', async () => {
            const res = await request(app).get('/i/');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/html');
        });

        test('GET /report.html serves report page', async () => {
            const res = await request(app).get('/report.html');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/html');
        });
    });

    describe('API routes are registered', () => {
        const apiRoutes = [
            { method: 'get', path: '/api/interviews' },
            { method: 'get', path: '/api/reports' },
            { method: 'get', path: '/api/responses' },
            { method: 'get', path: '/api/gallery/templates' },
            { method: 'get', path: '/api/memories' }
        ];

        apiRoutes.forEach(({ method, path }) => {
            test(`${method.toUpperCase()} ${path} is accessible`, async () => {
                const res = await request(app)[method](path);
                // Should not return 404
                expect(res.status).not.toBe(404);
                expect([200, 400, 401, 500, 501, 503]).toContain(res.status);
            });
        });
    });

    describe('Middleware', () => {
        test('CORS is enabled', async () => {
            const res = await request(app)
                .get('/api/test')
                .set('Origin', 'http://example.com');
            expect(res.headers['access-control-allow-origin']).toBeDefined();
        });

        test('JSON body parser works', async () => {
            const testData = { test: 'data' };
            const res = await request(app)
                .post('/api/claude')
                .send(testData)
                .set('Content-Type', 'application/json');
            // Route requires auth; body parser is working if we reach auth check
            expect([401, 400, 500, 501]).toContain(res.status);
        });

        test('handles large payloads', async () => {
            // Create a large payload (just under 50MB limit)
            const largeData = { data: 'x'.repeat(40 * 1024 * 1024) };
            const res = await request(app)
                .post('/api/claude')
                .send(largeData)
                .set('Content-Type', 'application/json');
            // Should not return 413 (payload too large)
            expect(res.status).not.toBe(413);
        });
    });

    describe('Dependencies are initialized', () => {
        test('utility functions are available', () => {
            const { countWords } = require('./server-utils');
            expect(countWords('hello world')).toBe(2);
        });

        test('audio functions are available', () => {
            const { parseReportAndPrepareAudioSegments } = require('./server-audio');
            expect(typeof parseReportAndPrepareAudioSegments).toBe('function');
        });

        test('report functions are available', () => {
            const { createReportEmailTemplate } = require('./server-reports');
            expect(typeof createReportEmailTemplate).toBe('function');
        });

        test('example data is available', () => {
            const { EXAMPLE_RESUME, EXAMPLE_QA, EXAMPLE_FIRST_NAME } = require('./server-example-data');
            expect(EXAMPLE_RESUME).toBeDefined();
            expect(EXAMPLE_QA).toBeInstanceOf(Array);
            expect(EXAMPLE_FIRST_NAME).toBe('Sarah');
        });
    });
});