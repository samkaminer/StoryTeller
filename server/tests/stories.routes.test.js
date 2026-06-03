const express = require('express');
const request = require('supertest');
const admin = require('firebase-admin');
const { createRouter } = require('../routes/stories');

function makeTimestamp(isoString) {
  const date = new Date(isoString);
  return {
    toDate: () => date,
    toMillis: () => date.getTime(),
  };
}

function makeSnapshot(docs) {
  return {
    docs,
    empty: docs.length === 0,
  };
}

describe('stories routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns all final-telling takes and prefers the latest take for the result payload', async () => {
    const db = admin.firestore();
    const storyId = 'story-123';
    const latestReportId = 'report-take-2';
    const earlierReportId = 'report-take-1';
    const storyUpdate = jest.fn().mockResolvedValue();

    const storyDoc = {
      id: storyId,
      exists: true,
      data: () => ({
        userId: 'user-123',
        promptText: 'Tell me about a turning point.',
        status: 'final_recorded',
        createdAt: makeTimestamp('2026-06-01T10:00:00.000Z'),
        finalRecordedAt: makeTimestamp('2026-06-03T14:00:00.000Z'),
        finalReportId: latestReportId,
        final_video_gcs: 'gs://test-bucket/story_videos/take-2.mp4',
        final_audio_gcs: 'gs://test-bucket/story_audio/take-2.webm',
        thumbnail_gcs: 'gs://test-bucket/story_thumbnails/take-2.jpg',
        notes: ['note'],
      }),
      ref: {
        update: storyUpdate,
      },
    };

    const reportDocs = [
      {
        id: latestReportId,
        data: () => ({
          story_id: storyId,
          report_type: 'final_telling',
          status: 'awaiting_upload',
          start_timestamp: makeTimestamp('2026-06-03T14:00:00.000Z'),
        }),
      },
      {
        id: earlierReportId,
        data: () => ({
          story_id: storyId,
          report_type: 'final_telling',
          status: 'awaiting_upload',
          start_timestamp: makeTimestamp('2026-06-02T14:00:00.000Z'),
        }),
      },
    ];

    const responsesByReportId = {
      [latestReportId]: makeSnapshot([
        {
          id: 'response-take-2',
          data: () => ({
            video_gcs_url: 'gs://test-bucket/story_videos/take-2.mp4',
            audio_gcs_url: 'gs://test-bucket/story_audio/take-2.webm',
            timestamp: makeTimestamp('2026-06-03T14:04:00.000Z'),
          }),
        },
      ]),
      [earlierReportId]: makeSnapshot([
        {
          id: 'response-take-1',
          data: () => ({
            video_gcs_url: 'gs://test-bucket/story_videos/take-1.mp4',
            audio_gcs_url: 'gs://test-bucket/story_audio/take-1.webm',
            timestamp: makeTimestamp('2026-06-02T14:04:00.000Z'),
          }),
        },
      ]),
    };

    db.collection.mockImplementation((collectionName) => {
      if (collectionName === 'stories') {
        return {
          doc: jest.fn((docId) => {
            if (docId !== storyId) throw new Error(`Unexpected story doc lookup: ${docId}`);
            return {
              get: jest.fn().mockResolvedValue(storyDoc),
            };
          }),
        };
      }

      if (collectionName === 'reports') {
        return {
          where: jest.fn((field, operator, value) => {
            if (field !== 'story_id' || operator !== '==' || value !== storyId) {
              throw new Error(`Unexpected reports query: ${field} ${operator} ${value}`);
            }
            return {
              get: jest.fn().mockResolvedValue(makeSnapshot(reportDocs)),
            };
          }),
          doc: jest.fn((reportId) => ({
            collection: jest.fn((subcollectionName) => {
              if (subcollectionName !== 'responses') {
                throw new Error(`Unexpected reports subcollection: ${subcollectionName}`);
              }
              return {
                get: jest.fn().mockResolvedValue(responsesByReportId[reportId] || makeSnapshot([])),
              };
            }),
          })),
        };
      }

      throw new Error(`Unexpected collection: ${collectionName}`);
    });

    const storage = {
      bucket: jest.fn(() => ({
        file: jest.fn((path) => ({
          getSignedUrl: jest.fn().mockResolvedValue([`https://signed.example/${encodeURIComponent(path)}`]),
        })),
      })),
    };

    const app = express();
    app.use((req, res, next) => {
      req.session = { userId: 'user-123', email: 'user@example.com' };
      next();
    });
    app.use('/api/stories', createRouter(storage, 'test-bucket'));

    const response = await request(app)
      .get(`/api/stories/${storyId}`);

    expect(response.status).toBe(200);

    expect(response.body.latestTakeId).toBe(latestReportId);
    expect(response.body.videoSignedUrl).toContain(encodeURIComponent('story_videos/take-2.mp4'));
    expect(response.body.finalVideoSignedUrl).toContain(encodeURIComponent('story_videos/take-2.mp4'));
    expect(response.body.responseDocId).toBe('response-take-2');
    expect(response.body.takes).toHaveLength(2);
    expect(response.body.takes[0]).toMatchObject({
      reportId: latestReportId,
      responseDocId: 'response-take-2',
      isLatest: true,
    });
    expect(response.body.takes[0].videoSignedUrl).toContain(encodeURIComponent('story_videos/take-2.mp4'));
    expect(response.body.takes[1]).toMatchObject({
      reportId: earlierReportId,
      responseDocId: 'response-take-1',
      isLatest: false,
    });
    expect(response.body.takes[1].videoSignedUrl).toContain(encodeURIComponent('story_videos/take-1.mp4'));
    expect(storyUpdate).not.toHaveBeenCalled();
  });
});
