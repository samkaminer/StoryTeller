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

function createPublishTestDb({ storyId, storyData, reportDocs, socialAccountData }) {
  const publishJobWrites = [];
  const normalizedSocialAccountData = socialAccountData
      ? {
        ...socialAccountData,
        scopes: socialAccountData.scopes || (
          socialAccountData.platform === 'instagram'
            ? ['instagram_basic', 'instagram_content_publish']
            : ['video.upload']
        ),
        accessToken: socialAccountData.accessToken || (
          socialAccountData.status === 'active'
            ? { ciphertext: 'test-access-token' }
            : socialAccountData.accessToken
        ),
      }
    : socialAccountData;

  const db = admin.firestore();
  db.collection.mockImplementation((collectionName) => {
    if (collectionName === 'stories') {
      return {
        doc: jest.fn((docId) => {
          if (docId !== storyId) throw new Error(`Unexpected story doc lookup: ${docId}`);
          return {
            get: jest.fn().mockResolvedValue({
              id: storyId,
              exists: true,
              data: () => storyData,
              ref: { update: jest.fn().mockResolvedValue() },
            }),
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
              get: jest.fn().mockResolvedValue(makeSnapshot([])),
            };
          }),
        })),
      };
    }

    if (collectionName === 'socialAccounts') {
      return {
        doc: jest.fn((docId) => ({
          get: jest.fn().mockResolvedValue({
            id: docId,
            exists: true,
            data: () => normalizedSocialAccountData,
          }),
        })),
      };
    }

    if (collectionName === 'socialPublishJobs') {
      return {
        doc: jest.fn((docId) => ({
          set: jest.fn(async (data) => {
            publishJobWrites.push({ docId, data });
          }),
          collection: jest.fn(() => ({
            doc: jest.fn(() => ({
              set: jest.fn(async () => {}),
            })),
          })),
        })),
      };
    }

    throw new Error(`Unexpected collection: ${collectionName}`);
  });

  return { db, publishJobWrites };
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
          take_response_doc_id: 'response-take-2',
          take_video_gcs_url: 'gs://test-bucket/story_videos/take-2.mp4',
          take_audio_gcs_url: 'gs://test-bucket/story_audio/take-2.webm',
          take_thumbnail_gcs_url: 'gs://test-bucket/story_thumbnails/take-2.jpg',
          take_media_status: 'ready',
          take_media_processed_at: makeTimestamp('2026-06-03T14:05:00.000Z'),
        }),
      },
      {
        id: earlierReportId,
        data: () => ({
          story_id: storyId,
          report_type: 'final_telling',
          status: 'awaiting_upload',
          start_timestamp: makeTimestamp('2026-06-02T14:00:00.000Z'),
          take_response_doc_id: 'response-take-1',
          take_video_gcs_url: 'gs://test-bucket/story_videos/take-1.mp4',
          take_audio_gcs_url: 'gs://test-bucket/story_audio/take-1.webm',
          take_media_status: 'ready',
          take_media_processed_at: makeTimestamp('2026-06-02T14:05:00.000Z'),
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

    const publishJobDocs = [
      {
        id: 'publish-instagram-1',
        data: () => ({
          userId: 'user-123',
          storyId,
          takeReportId: latestReportId,
          platform: 'instagram',
          publishMode: 'instagram_reel',
          status: 'completed',
          statusMessage: 'Instagram Reel published.',
          lastError: null,
          createdAt: makeTimestamp('2026-06-03T14:10:00.000Z'),
          updatedAt: makeTimestamp('2026-06-03T14:12:00.000Z'),
          completedAt: makeTimestamp('2026-06-03T14:12:00.000Z'),
        }),
      },
      {
        id: 'publish-tiktok-1',
        data: () => ({
          userId: 'user-123',
          storyId,
          takeReportId: earlierReportId,
          platform: 'tiktok',
          publishMode: 'tiktok_draft',
          status: 'failed',
          statusMessage: 'TikTok rejected the video duration.',
          lastError: {
            code: 'tiktok_invalid_duration',
            message: 'TikTok rejected the video duration.',
            retryable: false,
          },
          createdAt: makeTimestamp('2026-06-02T14:10:00.000Z'),
          updatedAt: makeTimestamp('2026-06-02T14:11:00.000Z'),
          completedAt: makeTimestamp('2026-06-02T14:11:00.000Z'),
        }),
      },
    ];

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

      if (collectionName === 'socialPublishJobs') {
        return {
          where: jest.fn((field, operator, value) => {
            if (field !== 'userId' || operator !== '==' || value !== 'user-123') {
              throw new Error(`Unexpected socialPublishJobs query: ${field} ${operator} ${value}`);
            }
            return {
              where: jest.fn((innerField, innerOperator, innerValue) => {
                if (innerField !== 'storyId' || innerOperator !== '==' || innerValue !== storyId) {
                  throw new Error(`Unexpected nested socialPublishJobs query: ${innerField} ${innerOperator} ${innerValue}`);
                }
                return {
                  get: jest.fn().mockResolvedValue(makeSnapshot(publishJobDocs)),
                };
              }),
              get: jest.fn().mockResolvedValue(makeSnapshot(publishJobDocs)),
            };
          }),
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
    app.use('/api/stories', createRouter(storage, 'test-bucket', {
      publishJobScheduler: jest.fn(),
    }));

    const response = await request(app)
      .get(`/api/stories/${storyId}`);

    expect(response.status).toBe(200);

    expect(response.body.latestTakeId).toBe(latestReportId);
    expect(response.body.videoSignedUrl).toContain(encodeURIComponent('story_videos/take-2.mp4'));
    expect(response.body.finalVideoSignedUrl).toContain(encodeURIComponent('story_videos/take-2.mp4'));
    expect(response.body.responseDocId).toBe('response-take-2');
    expect(response.body.takes).toHaveLength(2);
    expect(response.body.takes[0]).toMatchObject({
      storyId,
      takeId: latestReportId,
      reportId: latestReportId,
      responseDocId: 'response-take-2',
      takeResponseDocId: 'response-take-2',
      takeMediaStatus: 'ready',
      isLatest: true,
    });
    expect(response.body.takes[0].publishHistory).toEqual([
      expect.objectContaining({
        publishJobId: 'publish-instagram-1',
        platform: 'instagram',
        status: 'completed',
        activityAt: '2026-06-03T14:12:00.000Z',
        failureReason: null,
      }),
    ]);
    expect(response.body.takes[1].publishHistory).toEqual([
      expect.objectContaining({
        publishJobId: 'publish-tiktok-1',
        platform: 'tiktok',
        status: 'failed',
        failureReason: 'TikTok rejected the video duration.',
        canRetry: false,
      }),
    ]);
    expect(response.body.publishJobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        publishJobId: 'publish-instagram-1',
        platform: 'instagram',
      }),
      expect.objectContaining({
        publishJobId: 'publish-tiktok-1',
        platform: 'tiktok',
      }),
    ]));
    expect(response.body.takes[0].videoSignedUrl).toContain(encodeURIComponent('story_videos/take-2.mp4'));
    expect(response.body.takes[0].media).toMatchObject({
      ready: true,
      status: 'ready',
      videoGcsUrl: 'gs://test-bucket/story_videos/take-2.mp4',
      audioGcsUrl: 'gs://test-bucket/story_audio/take-2.webm',
    });
    expect(response.body.takes[1]).toMatchObject({
      storyId,
      takeId: earlierReportId,
      reportId: earlierReportId,
      responseDocId: 'response-take-1',
      takeResponseDocId: 'response-take-1',
      takeMediaStatus: 'ready',
      isLatest: false,
    });
    expect(response.body.takes[1].videoSignedUrl).toContain(encodeURIComponent('story_videos/take-1.mp4'));
    expect(storyUpdate).not.toHaveBeenCalled();
  });

  it('returns archive publish summaries from the latest publish state per platform', async () => {
    const db = admin.firestore();
    const storyId = 'story-archive-1';

    db.collection.mockImplementation((collectionName) => {
      if (collectionName === 'stories') {
        return {
          where: jest.fn((field, operator, value) => {
            if (field !== 'userId' || operator !== '==' || value !== 'user-123') {
              throw new Error(`Unexpected stories query: ${field} ${operator} ${value}`);
            }
            return {
              limit: jest.fn(() => ({
                get: jest.fn().mockResolvedValue(makeSnapshot([
                  {
                    id: storyId,
                    data: () => ({
                      userId: 'user-123',
                      promptText: 'Archive summary story',
                      status: 'final_recorded',
                      createdAt: makeTimestamp('2026-06-05T10:00:00.000Z'),
                      thumbnail_gcs: 'gs://test-bucket/story_thumbnails/archive-1.jpg',
                    }),
                  },
                ])),
              })),
            };
          }),
        };
      }

      if (collectionName === 'socialPublishJobs') {
        return {
          where: jest.fn((field, operator, value) => {
            if (field !== 'userId' || operator !== '==' || value !== 'user-123') {
              throw new Error(`Unexpected socialPublishJobs archive query: ${field} ${operator} ${value}`);
            }
            return {
              get: jest.fn().mockResolvedValue(makeSnapshot([
                {
                  id: 'publish-instagram-latest',
                  data: () => ({
                    userId: 'user-123',
                    storyId,
                    takeReportId: 'report-2',
                    platform: 'instagram',
                    publishMode: 'instagram_reel',
                    status: 'completed',
                    updatedAt: makeTimestamp('2026-06-05T10:15:00.000Z'),
                    completedAt: makeTimestamp('2026-06-05T10:15:00.000Z'),
                    lastError: null,
                  }),
                },
                {
                  id: 'publish-tiktok-failed',
                  data: () => ({
                    userId: 'user-123',
                    storyId,
                    takeReportId: 'report-1',
                    platform: 'tiktok',
                    publishMode: 'tiktok_draft',
                    status: 'failed',
                    updatedAt: makeTimestamp('2026-06-05T09:00:00.000Z'),
                    completedAt: makeTimestamp('2026-06-05T09:00:00.000Z'),
                    lastError: {
                      message: 'TikTok timed out.',
                      retryable: true,
                    },
                  }),
                },
              ])),
            };
          }),
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
    app.use((req, _res, next) => {
      req.session = { userId: 'user-123', email: 'user@example.com' };
      next();
    });
    app.use('/api/stories', createRouter(storage, 'test-bucket', {
      publishJobScheduler: jest.fn(),
    }));

    const response = await request(app).get('/api/stories');

    expect(response.status).toBe(200);
    expect(response.body.stories).toHaveLength(1);
    expect(response.body.stories[0].publishSummary).toEqual([
      expect.objectContaining({
        platform: 'instagram',
        status: 'completed',
        activityAt: '2026-06-05T10:15:00.000Z',
        failureReason: null,
      }),
      expect.objectContaining({
        platform: 'tiktok',
        status: 'failed',
        activityAt: '2026-06-05T09:00:00.000Z',
        failureReason: 'TikTok timed out.',
      }),
    ]);
  });

  it('creates a publish job for the requested take instead of defaulting to the story latest take', async () => {
    const storyId = 'story-123';
    const latestReportId = 'report-take-2';
    const requestedTakeId = 'report-take-1';
    const storyData = {
      userId: 'user-123',
      status: 'final_recorded',
      finalReportId: latestReportId,
      final_video_gcs: 'gs://test-bucket/story_videos/take-2.mp4',
    };
    const reportDocs = [
      {
        id: latestReportId,
        data: () => ({
          story_id: storyId,
          report_type: 'final_telling',
          start_timestamp: makeTimestamp('2026-06-03T14:00:00.000Z'),
          take_response_doc_id: 'response-take-2',
          take_video_gcs_url: 'gs://test-bucket/story_videos/take-2.mp4',
          take_audio_gcs_url: 'gs://test-bucket/story_audio/take-2.webm',
          take_media_status: 'ready',
        }),
      },
      {
        id: requestedTakeId,
        data: () => ({
          story_id: storyId,
          report_type: 'final_telling',
          start_timestamp: makeTimestamp('2026-06-02T14:00:00.000Z'),
          take_response_doc_id: 'response-take-1',
          take_video_gcs_url: 'gs://test-bucket/story_videos/take-1.mp4',
          take_audio_gcs_url: 'gs://test-bucket/story_audio/take-1.webm',
          take_thumbnail_gcs_url: 'gs://test-bucket/story_thumbnails/take-1.jpg',
          take_media_status: 'ready',
        }),
      },
    ];
    const { publishJobWrites } = createPublishTestDb({
      storyId,
      storyData,
      reportDocs,
      socialAccountData: {
        userId: 'user-123',
        platform: 'tiktok',
        status: 'active',
      },
    });

    const storage = {
      bucket: jest.fn(() => ({
        file: jest.fn((path) => ({
          getSignedUrl: jest.fn().mockResolvedValue([`https://signed.example/${encodeURIComponent(path)}`]),
        })),
      })),
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { userId: 'user-123', email: 'user@example.com' };
      next();
    });
    app.use('/api/stories', createRouter(storage, 'test-bucket', {
      publishJobScheduler: jest.fn(),
    }));

    const response = await request(app)
      .post(`/api/stories/${storyId}/takes/${requestedTakeId}/publish/tiktok`)
      .send({
        socialAccountId: 'social-1',
        caption: 'Share this take',
      });

    expect(response.status).toBe(202);
    expect(response.body.takeId).toBe(requestedTakeId);
    expect(publishJobWrites).toHaveLength(1);
    expect(publishJobWrites[0].data).toMatchObject({
      userId: 'user-123',
      storyId,
      takeReportId: requestedTakeId,
      takeResponseDocId: 'response-take-1',
      socialAccountId: 'social-1',
      platform: 'tiktok',
      publishMode: 'tiktok_draft',
      status: 'queued',
      caption: 'Share this take',
      mediaSnapshot: {
        videoGcsUrl: 'gs://test-bucket/story_videos/take-1.mp4',
        audioGcsUrl: 'gs://test-bucket/story_audio/take-1.webm',
        thumbnailGcsUrl: 'gs://test-bucket/story_thumbnails/take-1.jpg',
      },
    });
  });

  it('rejects publish job creation when caption is not a string', async () => {
    const storyId = 'story-123';
    const takeId = 'report-take-1';
    const { publishJobWrites } = createPublishTestDb({
      storyId,
      storyData: {
        userId: 'user-123',
        status: 'final_recorded',
        finalReportId: takeId,
      },
      reportDocs: [
        {
          id: takeId,
          data: () => ({
            story_id: storyId,
            report_type: 'final_telling',
            start_timestamp: makeTimestamp('2026-06-03T14:00:00.000Z'),
            take_response_doc_id: 'response-take-1',
            take_video_gcs_url: 'gs://test-bucket/story_videos/take-1.mp4',
            take_media_status: 'ready',
          }),
        },
      ],
      socialAccountData: {
        userId: 'user-123',
        platform: 'tiktok',
        status: 'active',
      },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { userId: 'user-123', email: 'user@example.com' };
      next();
    });
    app.use('/api/stories', createRouter(null, 'test-bucket', {
      publishJobScheduler: jest.fn(),
    }));

    const response = await request(app)
      .post(`/api/stories/${storyId}/takes/${takeId}/publish/tiktok`)
      .send({
        socialAccountId: 'social-1',
        caption: { invalid: true },
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('caption must be a string');
    expect(publishJobWrites).toHaveLength(0);
  });

  it('rejects publish job creation when platformOptions is not an object', async () => {
    const storyId = 'story-123';
    const takeId = 'report-take-1';
    const { publishJobWrites } = createPublishTestDb({
      storyId,
      storyData: {
        userId: 'user-123',
        status: 'final_recorded',
        finalReportId: takeId,
      },
      reportDocs: [
        {
          id: takeId,
          data: () => ({
            story_id: storyId,
            report_type: 'final_telling',
            start_timestamp: makeTimestamp('2026-06-03T14:00:00.000Z'),
            take_response_doc_id: 'response-take-1',
            take_video_gcs_url: 'gs://test-bucket/story_videos/take-1.mp4',
            take_media_status: 'ready',
          }),
        },
      ],
      socialAccountData: {
        userId: 'user-123',
        platform: 'tiktok',
        status: 'active',
      },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { userId: 'user-123', email: 'user@example.com' };
      next();
    });
    app.use('/api/stories', createRouter(null, 'test-bucket', {
      publishJobScheduler: jest.fn(),
    }));

    const response = await request(app)
      .post(`/api/stories/${storyId}/takes/${takeId}/publish/tiktok`)
      .send({
        socialAccountId: 'social-1',
        platformOptions: ['not-valid'],
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('platformOptions must be an object');
    expect(publishJobWrites).toHaveLength(0);
  });

  it('rejects TikTok publish when unsupported platform options are provided', async () => {
    const storyId = 'story-123';
    const takeId = 'report-take-1';
    const { publishJobWrites } = createPublishTestDb({
      storyId,
      storyData: {
        userId: 'user-123',
        status: 'final_recorded',
        finalReportId: takeId,
      },
      reportDocs: [
        {
          id: takeId,
          data: () => ({
            story_id: storyId,
            report_type: 'final_telling',
            start_timestamp: makeTimestamp('2026-06-03T14:00:00.000Z'),
            take_response_doc_id: 'response-take-1',
            take_video_gcs_url: 'gs://test-bucket/story_videos/take-1.mp4',
            take_media_status: 'ready',
          }),
        },
      ],
      socialAccountData: {
        userId: 'user-123',
        platform: 'tiktok',
        status: 'active',
        scopes: ['video.upload'],
      },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { userId: 'user-123', email: 'user@example.com' };
      next();
    });
    app.use('/api/stories', createRouter(null, 'test-bucket', {
      publishJobScheduler: jest.fn(),
    }));

    const response = await request(app)
      .post(`/api/stories/${storyId}/takes/${takeId}/publish/tiktok`)
      .send({
        socialAccountId: 'social-1',
        platformOptions: {
          shareToFeed: true,
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('TikTok draft publishing does not support platformOptions yet');
    expect(publishJobWrites).toHaveLength(0);
  });

  it('creates a queued Instagram Reel publish job with basic Reel options', async () => {
    const storyId = 'story-123';
    const takeId = 'report-take-1';
    const { publishJobWrites } = createPublishTestDb({
      storyId,
      storyData: {
        userId: 'user-123',
        status: 'final_recorded',
        finalReportId: takeId,
      },
      reportDocs: [
        {
          id: takeId,
          data: () => ({
            story_id: storyId,
            report_type: 'final_telling',
            start_timestamp: makeTimestamp('2026-06-03T14:00:00.000Z'),
            take_response_doc_id: 'response-take-1',
            take_video_gcs_url: 'gs://test-bucket/story_videos/take-1.mp4',
            take_thumbnail_gcs_url: 'gs://test-bucket/story_thumbnails/take-1.jpg',
            take_media_status: 'ready',
          }),
        },
      ],
      socialAccountData: {
        userId: 'user-123',
        platform: 'instagram',
        status: 'active',
      },
    });

    const publishJobScheduler = jest.fn();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { userId: 'user-123', email: 'user@example.com' };
      next();
    });
    app.use('/api/stories', createRouter(null, 'test-bucket', {
      publishJobScheduler,
    }));

    const response = await request(app)
      .post(`/api/stories/${storyId}/takes/${takeId}/publish/instagram`)
      .send({
        socialAccountId: 'social-1',
        caption: 'Publish this Reel',
        platformOptions: {
          shareToFeed: true,
          useTakeThumbnailAsCover: true,
        },
      });

    expect(response.status).toBe(202);
    expect(publishJobWrites).toHaveLength(1);
    expect(publishJobWrites[0].data).toMatchObject({
      storyId,
      takeReportId: takeId,
      socialAccountId: 'social-1',
      platform: 'instagram',
      publishMode: 'instagram_reel',
      status: 'queued',
      caption: 'Publish this Reel',
      platformOptions: {
        shareToFeed: true,
        useTakeThumbnailAsCover: true,
      },
      mediaSnapshot: {
        videoGcsUrl: 'gs://test-bucket/story_videos/take-1.mp4',
        thumbnailGcsUrl: 'gs://test-bucket/story_thumbnails/take-1.jpg',
      },
    });
    expect(publishJobScheduler).toHaveBeenCalledWith(expect.objectContaining({
      db: expect.any(Object),
      storage: null,
      defaultBucketName: 'test-bucket',
      publishJobId: expect.any(String),
    }));
  });

  it('rejects Instagram publish when shareToFeed is not a boolean', async () => {
    const storyId = 'story-123';
    const takeId = 'report-take-1';
    const { publishJobWrites } = createPublishTestDb({
      storyId,
      storyData: {
        userId: 'user-123',
        status: 'final_recorded',
        finalReportId: takeId,
      },
      reportDocs: [
        {
          id: takeId,
          data: () => ({
            story_id: storyId,
            report_type: 'final_telling',
            start_timestamp: makeTimestamp('2026-06-03T14:00:00.000Z'),
            take_response_doc_id: 'response-take-1',
            take_video_gcs_url: 'gs://test-bucket/story_videos/take-1.mp4',
            take_media_status: 'ready',
          }),
        },
      ],
      socialAccountData: {
        userId: 'user-123',
        platform: 'instagram',
        status: 'active',
      },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { userId: 'user-123', email: 'user@example.com' };
      next();
    });
    app.use('/api/stories', createRouter(null, 'test-bucket', {
      publishJobScheduler: jest.fn(),
    }));

    const response = await request(app)
      .post(`/api/stories/${storyId}/takes/${takeId}/publish/instagram`)
      .send({
        socialAccountId: 'social-1',
        platformOptions: {
          shareToFeed: 'yes',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('platformOptions.shareToFeed must be a boolean');
    expect(publishJobWrites).toHaveLength(0);
  });

  it('rejects Instagram publish when both cover options are provided', async () => {
    const storyId = 'story-123';
    const takeId = 'report-take-1';
    const { publishJobWrites } = createPublishTestDb({
      storyId,
      storyData: {
        userId: 'user-123',
        status: 'final_recorded',
        finalReportId: takeId,
      },
      reportDocs: [
        {
          id: takeId,
          data: () => ({
            story_id: storyId,
            report_type: 'final_telling',
            start_timestamp: makeTimestamp('2026-06-03T14:00:00.000Z'),
            take_response_doc_id: 'response-take-1',
            take_video_gcs_url: 'gs://test-bucket/story_videos/take-1.mp4',
            take_thumbnail_gcs_url: 'gs://test-bucket/story_thumbnails/take-1.jpg',
            take_media_status: 'ready',
          }),
        },
      ],
      socialAccountData: {
        userId: 'user-123',
        platform: 'instagram',
        status: 'active',
      },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { userId: 'user-123', email: 'user@example.com' };
      next();
    });
    app.use('/api/stories', createRouter(null, 'test-bucket', {
      publishJobScheduler: jest.fn(),
    }));

    const response = await request(app)
      .post(`/api/stories/${storyId}/takes/${takeId}/publish/instagram`)
      .send({
        socialAccountId: 'social-1',
        platformOptions: {
          useTakeThumbnailAsCover: true,
          thumbOffsetMs: 500,
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Choose either platformOptions.useTakeThumbnailAsCover or platformOptions.thumbOffsetMs');
    expect(publishJobWrites).toHaveLength(0);
  });

  it('rejects publish job creation when the selected social account is not active', async () => {
    const storyId = 'story-123';
    const takeId = 'report-take-1';
    const { publishJobWrites } = createPublishTestDb({
      storyId,
      storyData: {
        userId: 'user-123',
        status: 'final_recorded',
        finalReportId: takeId,
      },
      reportDocs: [
        {
          id: takeId,
          data: () => ({
            story_id: storyId,
            report_type: 'final_telling',
            start_timestamp: makeTimestamp('2026-06-03T14:00:00.000Z'),
            take_response_doc_id: 'response-take-1',
            take_video_gcs_url: 'gs://test-bucket/story_videos/take-1.mp4',
            take_media_status: 'ready',
          }),
        },
      ],
      socialAccountData: {
        userId: 'user-123',
        platform: 'tiktok',
        status: 'reauth_required',
      },
    });

    const storage = {
      bucket: jest.fn(() => ({
        file: jest.fn((path) => ({
          getSignedUrl: jest.fn().mockResolvedValue([`https://signed.example/${encodeURIComponent(path)}`]),
        })),
      })),
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { userId: 'user-123', email: 'user@example.com' };
      next();
    });
    app.use('/api/stories', createRouter(storage, 'test-bucket', {
      publishJobScheduler: jest.fn(),
    }));

    const response = await request(app)
      .post(`/api/stories/${storyId}/takes/${takeId}/publish/tiktok`)
      .send({
        socialAccountId: 'social-1',
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Reconnect this account before publishing');
    expect(publishJobWrites).toHaveLength(0);
  });

  it('rejects publish job creation when the connected account is missing required publish scopes', async () => {
    const storyId = 'story-123';
    const takeId = 'report-take-1';
    const { publishJobWrites } = createPublishTestDb({
      storyId,
      storyData: {
        userId: 'user-123',
        status: 'final_recorded',
        finalReportId: takeId,
      },
      reportDocs: [
        {
          id: takeId,
          data: () => ({
            story_id: storyId,
            report_type: 'final_telling',
            start_timestamp: makeTimestamp('2026-06-03T14:00:00.000Z'),
            take_response_doc_id: 'response-take-1',
            take_video_gcs_url: 'gs://test-bucket/story_videos/take-1.mp4',
            take_media_status: 'ready',
          }),
        },
      ],
      socialAccountData: {
        userId: 'user-123',
        platform: 'instagram',
        status: 'active',
        scopes: ['instagram_basic'],
      },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { userId: 'user-123', email: 'user@example.com' };
      next();
    });
    app.use('/api/stories', createRouter(null, 'test-bucket', {
      publishJobScheduler: jest.fn(),
    }));

    const response = await request(app)
      .post(`/api/stories/${storyId}/takes/${takeId}/publish/instagram`)
      .send({
        socialAccountId: 'social-1',
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Reconnect this account to restore required publishing permissions');
    expect(response.body.missingScopes).toEqual(['instagram_content_publish']);
    expect(publishJobWrites).toHaveLength(0);
  });
});
