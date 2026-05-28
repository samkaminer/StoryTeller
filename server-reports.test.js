// Simple tests for server-reports.js
// Testing report generation and email functionality

const {
    getResponsesWithSignedUrls,
    createReportEmailTemplate,
    sendReportEmail,
    initialize
} = require('./server-reports');

// Mock dependencies
jest.mock('fs', () => ({
    existsSync: jest.fn(),
    readFileSync: jest.fn()
}));

jest.mock('path', () => ({
    join: jest.fn((...args) => args.join('/'))
}));

describe('server-reports', () => {
    let mockDb, mockStorage, mockSgMail;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Mock database
        mockDb = {
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            get: jest.fn()
        };

        // Mock storage
        mockStorage = {
            bucket: jest.fn().mockReturnValue({
                file: jest.fn().mockReturnValue({
                    getSignedUrl: jest.fn().mockResolvedValue(['https://signed-url.com'])
                })
            })
        };

        // Mock SendGrid
        mockSgMail = {
            send: jest.fn().mockResolvedValue([{
                headers: { 'x-message-id': 'test-message-id' }
            }])
        };
    });

    describe('getResponsesWithSignedUrls', () => {
        test('throws error when db is not available', async () => {
            await expect(getResponsesWithSignedUrls('report123', null, mockStorage, 'bucket'))
                .rejects.toThrow('Firebase service unavailable');
        });

        test('throws error when storage is not available', async () => {
            await expect(getResponsesWithSignedUrls('report123', mockDb, null, 'bucket'))
                .rejects.toThrow('Storage service unavailable');
        });

        test('throws error when reportId is missing', async () => {
            await expect(getResponsesWithSignedUrls(null, mockDb, mockStorage, 'bucket'))
                .rejects.toThrow('Missing report ID');
        });

        test('fetches responses with signed URLs', async () => {
            const mockDocs = [
                {
                    id: 'resp1',
                    data: () => ({
                        question: 'Q1',
                        answer: 'A1',
                        audio_gcs_url: 'gs://bucket/path/file.mp3',
                        timestamp: { toDate: () => new Date('2024-01-01') }
                    })
                }
            ];

            mockDb.get.mockResolvedValue({
                docs: mockDocs
            });

            const responses = await getResponsesWithSignedUrls('report123', mockDb, mockStorage, 'bucket');

            expect(responses).toHaveLength(1);
            expect(responses[0]).toEqual({
                id: 'resp1',
                question: 'Q1',
                answer: 'A1',
                timestamp: '2024-01-01T00:00:00.000Z',
                audio_signed_url: 'https://signed-url.com',
                video_signed_url: null,
                word_timestamps: null
            });
        });

        test('handles invalid GCS URI format', async () => {
            const mockDocs = [
                {
                    id: 'resp1',
                    data: () => ({
                        question: 'Q1',
                        answer: 'A1',
                        audio_gcs_url: 'invalid-uri'
                    })
                }
            ];

            mockDb.get.mockResolvedValue({
                docs: mockDocs
            });

            const responses = await getResponsesWithSignedUrls('report123', mockDb, mockStorage, 'bucket');

            expect(responses[0].audio_signed_url).toBeNull();
        });
    });

    describe('createReportEmailTemplate', () => {
        test('creates HTML email template', () => {
            const reportContent = '# Test Report\n\nThis is **bold** and *italic* text.';
            const template = createReportEmailTemplate(reportContent, 'Test Report', 'https://example.com/report', 'John');

            expect(template).toContain('<h1 style="color: #2c5aa0;');
            expect(template).toContain('Test Report');
            expect(template).toContain('Hello John');
            expect(template).toContain('<strong>bold</strong>');
            expect(template).toContain('<em>italic</em>');
            expect(template).toContain('https://example.com/report');
        });

        test('handles audio clip tags', () => {
            const reportContent = '<audio_clip id="123">This is a quote</audio_clip>';
            const template = createReportEmailTemplate(reportContent, 'Report', 'https://example.com', 'User');

            expect(template).toContain('<div class="quote-block">"This is a quote"</div>');
        });

        test('escapes HTML entities', () => {
            const reportContent = 'Test & <special> "characters"';
            const template = createReportEmailTemplate(reportContent, 'Report', 'https://example.com', 'User');

            // Check that HTML entities are escaped (quotes aren't escaped in the current implementation)
            expect(template).toContain('Test &amp; &lt;special&gt; "characters"');
        });
    });

    describe('sendReportEmail', () => {
        beforeEach(() => {
            // Initialize with mock SendGrid
            initialize({ sgMail: mockSgMail });
        });

        test('returns false when SendGrid not initialized', async () => {
            // Re-initialize without sgMail to clear the previous initialization
            require('./server-reports').initialize({}); // No sgMail
            const result = await sendReportEmail('test@example.com', 'Test User', 'Content', 'Title', 'report123', 'interview123');
            expect(result).toBe(false);
        });

        test('returns false when missing required parameters', async () => {
            const result = await sendReportEmail(null, 'Test User', 'Content', 'Title', 'report123', 'interview123');
            expect(result).toBe(false);
        });

        test('sends email successfully', async () => {
            const fs = require('fs');
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(Buffer.from('fake-logo'));

            const result = await sendReportEmail(
                'test@example.com',
                'Test User',
                'Report content',
                'Test Report',
                'report123',
                'interview123'
            );

            expect(result).toBe(true);
            expect(mockSgMail.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    to: 'test@example.com',
                    subject: 'Test Report is Ready! 🎯',
                    html: expect.stringContaining('Test Report'),
                    text: expect.stringContaining('Report content'),
                    attachments: expect.arrayContaining([
                        expect.objectContaining({
                            filename: 'logo',
                            type: 'image/png'
                        })
                    ])
                })
            );
        });

        test('handles email send failure', async () => {
            mockSgMail.send.mockRejectedValue(new Error('SendGrid error'));

            const result = await sendReportEmail(
                'test@example.com',
                'Test User',
                'Content',
                'Title',
                'report123',
                'interview123'
            );

            expect(result).toBe(false);
        });
    });
});