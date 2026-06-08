const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  processTikTokDraftPublishJob,
  refreshTikTokPublishJobStatus,
} = require('../services/tiktok-publish-service');
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

function uploadResponse(status) {
  return {
    status,
    text: jest.fn(async () => ''),
  };
}

function createStorageMock(videoBuffer, contentType = 'video/mp4') {
  return {
    bucket: jest.fn(() => ({
      file: jest.fn((filePath) => ({
        getMetadata: jest.fn(async () => ([{ contentType, name: filePath }])),
        download: jest.fn(async ({ destination }) => {
          await fs.writeFile(destination, videoBuffer);
        }),
      })),
    })),
  };
}

describe('TikTok publish service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 9).toString('base64');
  });

  it('processes a queued TikTok draft job and transitions it to awaiting user action', async () => {
    const db = createMemoryDb();
    const videoBuffer = Buffer.alloc(1024 * 1024, 7);
    const storage = createStorageMock(videoBuffer);
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: {
          publish_id: 'v_inbox_file~123',
          upload_url: 'https://upload.tiktok.example/video',
        },
        error: {
          code: 'ok',
          message: '',
          log_id: 'log-1',
        },
      }))
      .mockResolvedValueOnce(uploadResponse(201))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          status: 'SEND_TO_USER_INBOX',
          uploaded_bytes: videoBuffer.length,
        },
        error: {
          code: 'ok',
          message: '',
          log_id: 'log-2',
        },
      }));

    db._collections.socialAccounts.set('social-1', {
      userId: 'user-123',
      platform: 'tiktok',
      status: 'active',
      accessToken: encryptSecret('tt-access-token'),
    });
    db._collections.socialPublishJobs.set('publish-1', {
      userId: 'user-123',
      socialAccountId: 'social-1',
      platform: 'tiktok',
      publishMode: 'tiktok_draft',
      status: 'queued',
      mediaSnapshot: {
        videoGcsUrl: 'gs://test-bucket/story_videos/take-1.mp4',
      },
      attemptCount: 0,
      createdAt: new Date('2026-06-04T12:00:00.000Z'),
      updatedAt: new Date('2026-06-04T12:00:00.000Z'),
    });

    const result = await processTikTokDraftPublishJob({
      db,
      storage,
      defaultBucketName: 'test-bucket',
      publishJobId: 'publish-1',
      fetchImpl,
    });

    expect(result.status).toBe('awaiting_user_action');
    expect(result.platformStatus).toBe('SEND_TO_USER_INBOX');
    expect(result.platformPublishId).toBe('v_inbox_file~123');
    expect(result.statusMessage).toContain('Draft delivered to TikTok');

    const storedJob = db._collections.socialPublishJobs.get('publish-1');
    expect(storedJob.status).toBe('awaiting_user_action');
    expect(storedJob.platformPublishId).toBe('v_inbox_file~123');
    expect(storedJob.attemptCount).toBe(1);
    expect(storedJob.mediaSnapshot.fileSizeBytes).toBe(videoBuffer.length);
    expect(db._collections.socialPublishJobEvents.get('publish-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'publish_started', status: 'processing' }),
        expect.objectContaining({ type: 'publish_initialized', status: 'uploading' }),
        expect.objectContaining({ type: 'upload_completed', status: 'processing' }),
        expect.objectContaining({ type: 'publish_status_updated', status: 'awaiting_user_action' }),
      ])
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/');
    expect(fetchImpl.mock.calls[1][0]).toBe('https://upload.tiktok.example/video');
    expect(fetchImpl.mock.calls[2][0]).toBe('https://open.tiktokapis.com/v2/post/publish/status/fetch/');
  });

  it('marks a TikTok draft job as failed when TikTok reports a final failure reason', async () => {
    const db = createMemoryDb();
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: {
          status: 'FAILED',
          fail_reason: 'duration_check_failed',
        },
        error: {
          code: 'ok',
          message: '',
          log_id: 'log-3',
        },
      }));

    db._collections.socialAccounts.set('social-1', {
      userId: 'user-123',
      platform: 'tiktok',
      status: 'active',
      accessToken: encryptSecret('tt-access-token'),
    });
    db._collections.socialPublishJobs.set('publish-1', {
      userId: 'user-123',
      socialAccountId: 'social-1',
      platform: 'tiktok',
      publishMode: 'tiktok_draft',
      status: 'processing',
      platformPublishId: 'v_inbox_file~123',
      lastError: null,
      createdAt: new Date('2026-06-04T12:00:00.000Z'),
      updatedAt: new Date('2026-06-04T12:00:00.000Z'),
    });

    const result = await refreshTikTokPublishJobStatus({
      db,
      publishJobId: 'publish-1',
      fetchImpl,
      force: true,
    });

    expect(result.status).toBe('failed');
    expect(result.platformStatus).toBe('FAILED');
    expect(result.lastError).toEqual(expect.objectContaining({
      code: 'tiktok_invalid_duration',
      retryable: false,
    }));

    const storedJob = db._collections.socialPublishJobs.get('publish-1');
    expect(storedJob.status).toBe('failed');
    expect(storedJob.lastError.code).toBe('tiktok_invalid_duration');
    expect(db._collections.socialPublishJobEvents.get('publish-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'publish_status_failed', status: 'failed' }),
      ])
    );
  });

  it('does not start a duplicate TikTok upload while another worker lease is active', async () => {
    const db = createMemoryDb();
    const fetchImpl = jest.fn();

    db._collections.socialAccounts.set('social-1', {
      userId: 'user-123',
      platform: 'tiktok',
      status: 'active',
      accessToken: encryptSecret('tt-access-token'),
    });
    db._collections.socialPublishJobs.set('publish-1', {
      userId: 'user-123',
      socialAccountId: 'social-1',
      platform: 'tiktok',
      publishMode: 'tiktok_draft',
      status: 'queued',
      processingLeaseOwner: 'worker-1',
      processingLeaseExpiresAt: new Date(Date.now() + 60_000),
      mediaSnapshot: {
        videoGcsUrl: 'gs://test-bucket/story_videos/take-1.mp4',
      },
      attemptCount: 0,
      createdAt: new Date('2026-06-04T12:00:00.000Z'),
      updatedAt: new Date('2026-06-04T12:00:00.000Z'),
    });

    const result = await processTikTokDraftPublishJob({
      db,
      storage: createStorageMock(Buffer.alloc(1024, 7)),
      defaultBucketName: 'test-bucket',
      publishJobId: 'publish-1',
      fetchImpl,
    });

    expect(result.status).toBe('queued');
    expect(result.platformPublishId).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a UI-safe media error when the selected take cannot be read from storage', async () => {
    const db = createMemoryDb();

    db._collections.socialAccounts.set('social-1', {
      userId: 'user-123',
      platform: 'tiktok',
      status: 'active',
      accessToken: encryptSecret('tt-access-token'),
    });
    db._collections.socialPublishJobs.set('publish-1', {
      userId: 'user-123',
      socialAccountId: 'social-1',
      platform: 'tiktok',
      publishMode: 'tiktok_draft',
      status: 'queued',
      mediaSnapshot: {
        videoGcsUrl: 'not-a-gs-url',
      },
      attemptCount: 0,
      createdAt: new Date('2026-06-04T12:00:00.000Z'),
      updatedAt: new Date('2026-06-04T12:00:00.000Z'),
    });

    const result = await processTikTokDraftPublishJob({
      db,
      storage: createStorageMock(Buffer.alloc(1024, 7)),
      defaultBucketName: 'test-bucket',
      publishJobId: 'publish-1',
      fetchImpl: jest.fn(),
    });

    expect(result.status).toBe('failed');
    expect(result.lastError).toEqual(expect.objectContaining({
      code: 'tiktok_media_unavailable',
      retryable: false,
    }));
    expect(result.lastError.message).toContain('not currently available');
  });
});
