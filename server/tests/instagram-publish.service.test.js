const {
  processInstagramReelPublishJob,
} = require('../services/instagram-publish-service');
const { encryptSecret } = require('../utils/social-crypto');

function createMemoryDb() {
  const collections = {
    socialAccounts: new Map(),
    socialPublishJobs: new Map(),
    socialPublishJobEvents: new Map(),
  };

  function makeDocSnapshot(id, data) {
    return {
      id,
      exists: Boolean(data),
      data: () => data || {},
    };
  }

  function ensureEventList(jobId) {
    if (!collections.socialPublishJobEvents.has(jobId)) {
      collections.socialPublishJobEvents.set(jobId, []);
    }
    return collections.socialPublishJobEvents.get(jobId);
  }

  return {
    _collections: collections,
    collection: jest.fn((collectionName) => ({
      doc: jest.fn((docId) => ({
        get: jest.fn(async () => makeDocSnapshot(docId, collections[collectionName].get(docId))),
        set: jest.fn(async (data) => {
          collections[collectionName].set(docId, data);
        }),
        update: jest.fn(async (patch) => {
          const current = collections[collectionName].get(docId) || {};
          collections[collectionName].set(docId, { ...current, ...patch });
        }),
        collection: jest.fn((subcollectionName) => ({
          doc: jest.fn((eventId) => ({
            set: jest.fn(async (eventData) => {
              if (subcollectionName !== 'events') {
                throw new Error(`Unexpected subcollection: ${subcollectionName}`);
              }
              ensureEventList(docId).push({ eventId, ...eventData });
            }),
          })),
        })),
      })),
    })),
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn(async () => JSON.stringify(body)),
  };
}

function createStorageMock({ videoContentType = 'video/mp4', videoSize = 10 * 1024 * 1024, thumbnailContentType = 'image/jpeg' } = {}) {
  return {
    bucket: jest.fn(() => ({
      file: jest.fn((filePath) => ({
        getMetadata: jest.fn(async () => ([{
          contentType: filePath.endsWith('.jpg') ? thumbnailContentType : videoContentType,
          size: filePath.endsWith('.jpg') ? String(1024) : String(videoSize),
        }])),
        getSignedUrl: jest.fn(async () => [`https://signed.example/${encodeURIComponent(filePath)}`]),
      })),
    })),
  };
}

describe('Instagram publish service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 9).toString('base64');
    process.env.META_GRAPH_API_VERSION = 'v23.0';
  });

  it('processes a queued Instagram Reel job and publishes it after the container finishes processing', async () => {
    const db = createMemoryDb();
    const storage = createStorageMock();
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        id: 'ig-container-1',
      }))
      .mockResolvedValueOnce(jsonResponse({
        status_code: 'FINISHED',
        status: '0',
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'ig-media-1',
      }));

    db._collections.socialAccounts.set('social-1', {
      userId: 'user-123',
      platform: 'instagram',
      status: 'active',
      platformAccountId: 'ig-456',
      accessToken: encryptSecret('ig-access-token'),
      meta: {
        igUserId: 'ig-456',
      },
    });
    db._collections.socialPublishJobs.set('publish-1', {
      userId: 'user-123',
      socialAccountId: 'social-1',
      platform: 'instagram',
      publishMode: 'instagram_reel',
      status: 'queued',
      caption: 'Publish this take',
      platformOptions: {
        shareToFeed: true,
        thumbOffsetMs: 1500,
      },
      mediaSnapshot: {
        videoGcsUrl: 'gs://test-bucket/story_videos/take-1.mp4',
        thumbnailGcsUrl: 'gs://test-bucket/story_thumbnails/take-1.jpg',
      },
      attemptCount: 0,
      createdAt: new Date('2026-06-08T12:00:00.000Z'),
      updatedAt: new Date('2026-06-08T12:00:00.000Z'),
    });

    const result = await processInstagramReelPublishJob({
      db,
      storage,
      defaultBucketName: 'test-bucket',
      publishJobId: 'publish-1',
      fetchImpl,
    });

    expect(result.status).toBe('completed');
    expect(result.platformStatus).toBe('PUBLISHED');
    expect(result.platformContainerId).toBe('ig-container-1');
    expect(result.platformPostId).toBe('ig-media-1');
    expect(result.statusMessage).toContain('published');

    const storedJob = db._collections.socialPublishJobs.get('publish-1');
    expect(storedJob.status).toBe('completed');
    expect(storedJob.platformContainerId).toBe('ig-container-1');
    expect(storedJob.platformPostId).toBe('ig-media-1');
    expect(storedJob.attemptCount).toBe(1);
    expect(storedJob.mediaSnapshot.fileSizeBytes).toBe(10 * 1024 * 1024);
    expect(db._collections.socialPublishJobEvents.get('publish-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'publish_started', status: 'processing' }),
        expect.objectContaining({ type: 'publish_initialized', status: 'processing' }),
        expect.objectContaining({ type: 'publish_completed', status: 'completed' }),
      ])
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://graph.facebook.com/v23.0/ig-456/media');
    expect(fetchImpl.mock.calls[1][0]).toContain('https://graph.facebook.com/v23.0/ig-container-1');
    expect(fetchImpl.mock.calls[1][0]).toContain('fields=status_code%2Cstatus');
    expect(fetchImpl.mock.calls[2][0]).toBe('https://graph.facebook.com/v23.0/ig-456/media_publish');
  });

  it('returns a UI-safe format error when the selected take is not an Instagram-supported video type', async () => {
    const db = createMemoryDb();

    db._collections.socialAccounts.set('social-1', {
      userId: 'user-123',
      platform: 'instagram',
      status: 'active',
      platformAccountId: 'ig-456',
      accessToken: encryptSecret('ig-access-token'),
      meta: {
        igUserId: 'ig-456',
      },
    });
    db._collections.socialPublishJobs.set('publish-1', {
      userId: 'user-123',
      socialAccountId: 'social-1',
      platform: 'instagram',
      publishMode: 'instagram_reel',
      status: 'queued',
      mediaSnapshot: {
        videoGcsUrl: 'gs://test-bucket/story_videos/take-1.webm',
      },
      attemptCount: 0,
      createdAt: new Date('2026-06-08T12:00:00.000Z'),
      updatedAt: new Date('2026-06-08T12:00:00.000Z'),
    });

    const result = await processInstagramReelPublishJob({
      db,
      storage: createStorageMock({ videoContentType: 'video/webm' }),
      defaultBucketName: 'test-bucket',
      publishJobId: 'publish-1',
      fetchImpl: jest.fn(),
    });

    expect(result.status).toBe('failed');
    expect(result.lastError).toEqual(expect.objectContaining({
      code: 'instagram_invalid_format',
      retryable: false,
    }));
  });

  it('marks the job as failed when Meta blocks publish because Page Publishing Authorization is incomplete', async () => {
    const db = createMemoryDb();
    const storage = createStorageMock();
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        id: 'ig-container-1',
      }))
      .mockResolvedValueOnce(jsonResponse({
        status_code: 'FINISHED',
        status: '0',
      }))
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: 10,
          message: 'Page Publishing Authorization is required before this Page can publish.',
        },
      }, 400));

    db._collections.socialAccounts.set('social-1', {
      userId: 'user-123',
      platform: 'instagram',
      status: 'active',
      platformAccountId: 'ig-456',
      accessToken: encryptSecret('ig-access-token'),
      meta: {
        igUserId: 'ig-456',
      },
    });
    db._collections.socialPublishJobs.set('publish-1', {
      userId: 'user-123',
      socialAccountId: 'social-1',
      platform: 'instagram',
      publishMode: 'instagram_reel',
      status: 'queued',
      mediaSnapshot: {
        videoGcsUrl: 'gs://test-bucket/story_videos/take-1.mp4',
      },
      attemptCount: 0,
      createdAt: new Date('2026-06-08T12:00:00.000Z'),
      updatedAt: new Date('2026-06-08T12:00:00.000Z'),
    });

    const result = await processInstagramReelPublishJob({
      db,
      storage,
      defaultBucketName: 'test-bucket',
      publishJobId: 'publish-1',
      fetchImpl,
    });

    expect(result.status).toBe('failed');
    expect(result.lastError).toEqual(expect.objectContaining({
      code: 'instagram_page_authorization_required',
      retryable: false,
    }));
  });
});
