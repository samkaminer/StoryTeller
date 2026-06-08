const express = require('express');
const request = require('supertest');
const { createRouter: createSocialRouter } = require('../routes/social');

function createMemoryDb() {
  const collections = {
    socialAccounts: new Map(),
    socialAuthStates: new Map(),
    socialPublishJobs: new Map(),
  };

  function makeDocSnapshot(id, data) {
    return {
      id,
      exists: Boolean(data),
      data: () => data || {},
    };
  }

  function getFilteredDocs(collectionName, filters = []) {
    return Array.from(collections[collectionName].entries())
      .map(([id, data]) => ({ id, data }))
      .filter(({ data }) => filters.every(([field, operator, value]) => (
        operator === '==' && data[field] === value
      )))
      .map(({ id, data }) => makeDocSnapshot(id, data));
  }

  function makeQuery(collectionName, filters = []) {
    return {
      where: jest.fn((field, operator, value) => makeQuery(collectionName, [...filters, [field, operator, value]])),
      limit: jest.fn((count) => ({
        get: jest.fn(async () => {
          const docs = getFilteredDocs(collectionName, filters).slice(0, count);
          return { docs, empty: docs.length === 0, size: docs.length };
        }),
      })),
      get: jest.fn(async () => {
        const docs = getFilteredDocs(collectionName, filters);
        return { docs, empty: docs.length === 0, size: docs.length };
      }),
    };
  }

  function makeDocRef(collectionName, docId) {
    return {
      get: jest.fn(async () => makeDocSnapshot(docId, collections[collectionName].get(docId))),
      set: jest.fn(async (data) => {
        collections[collectionName].set(docId, data);
      }),
      update: jest.fn(async (patch) => {
        const current = collections[collectionName].get(docId) || {};
        collections[collectionName].set(docId, { ...current, ...patch });
      }),
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          set: jest.fn(async () => {}),
        })),
      })),
    };
  }

  return {
    _collections: collections,
    collection: jest.fn((collectionName) => ({
      doc: jest.fn((docId) => makeDocRef(collectionName, docId)),
      where: jest.fn((field, operator, value) => makeQuery(collectionName, [[field, operator, value]])),
    })),
  };
}

function createApp(db, fetchImpl, routerOptions = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 'user-123', email: 'user@example.com' };
    next();
  });
  app.use('/api/social', createSocialRouter({ db, fetchImpl, ...routerOptions }));
  return app;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn(async () => JSON.stringify(body)),
  };
}

describe('social connected account routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
    process.env.TIKTOK_CLIENT_KEY = 'tt-client-key';
    process.env.TIKTOK_CLIENT_SECRET = 'tt-client-secret';
    process.env.TIKTOK_REDIRECT_URI = 'http://localhost:3001/api/social/tiktok/connect/callback';
    process.env.TIKTOK_CONNECT_SCOPES = 'user.info.basic,video.upload';
    process.env.META_APP_ID = 'meta-app-id';
    process.env.META_APP_SECRET = 'meta-app-secret';
    process.env.META_REDIRECT_URI = 'http://localhost:3001/api/social/instagram/connect/callback';
    process.env.META_GRAPH_API_VERSION = 'v23.0';
    process.env.META_CONNECT_SCOPES = 'instagram_basic,instagram_content_publish,pages_read_engagement,pages_show_list';
  });

  it('starts TikTok OAuth and persists take-scoped state', async () => {
    const db = createMemoryDb();
    const app = createApp(db, jest.fn());

    const response = await request(app)
      .post('/api/social/tiktok/connect/start')
      .send({
        storyId: 'story-123',
        takeId: 'take-456',
        redirectPath: '/story-result.html?storyId=story-123&takeId=take-456',
      });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);

    const authorizeUrl = new URL(response.body.authorizeUrl);
    expect(authorizeUrl.origin).toBe('https://www.tiktok.com');
    expect(authorizeUrl.searchParams.get('client_key')).toBe('tt-client-key');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(process.env.TIKTOK_REDIRECT_URI);
    expect(authorizeUrl.searchParams.get('scope')).toBe('user.info.basic,video.upload');
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeNull();
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBeNull();

    const state = authorizeUrl.searchParams.get('state');
    const storedState = db._collections.socialAuthStates.get(state);

    expect(storedState.userId).toBe('user-123');
    expect(storedState.platform).toBe('tiktok');
    expect(storedState.storyId).toBe('story-123');
    expect(storedState.takeReportId).toBe('take-456');
    expect(storedState.redirectPath).toBe('/story-result.html?storyId=story-123&takeId=take-456');
    expect(storedState.codeVerifier).toBeNull();
  });

  it('reports provider setup status in the connected accounts payload', async () => {
    const db = createMemoryDb();
    const app = createApp(db, jest.fn());

    const response = await request(app).get('/api/social/accounts');

    expect(response.status).toBe(200);
    expect(response.body.platformConfigs.tiktok.configured).toBe(true);
    expect(response.body.platformConfigs.tiktok.missingEnvVars).toEqual([]);
    expect(response.body.platformConfigs.instagram.configured).toBe(true);
    expect(response.body.platformConfigs.instagram.missingEnvVars).toEqual([]);
  });

  it('returns missing env vars when TikTok OAuth is not configured', async () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    delete process.env.TIKTOK_REDIRECT_URI;
    delete process.env.SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64;

    const db = createMemoryDb();
    const app = createApp(db, jest.fn());

    const response = await request(app)
      .post('/api/social/tiktok/connect/start')
      .send({});

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('TikTok OAuth is not configured');
    expect(response.body.missingEnvVars).toEqual(expect.arrayContaining([
      'TIKTOK_CLIENT_KEY',
      'TIKTOK_CLIENT_SECRET',
      'TIKTOK_REDIRECT_URI',
      'SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64',
    ]));

    const accountsResponse = await request(app).get('/api/social/accounts');
    expect(accountsResponse.status).toBe(200);
    expect(accountsResponse.body.platformConfigs.tiktok.configured).toBe(false);
    expect(accountsResponse.body.platformConfigs.tiktok.missingEnvVars).toEqual(expect.arrayContaining([
      'TIKTOK_CLIENT_KEY',
      'TIKTOK_CLIENT_SECRET',
      'TIKTOK_REDIRECT_URI',
      'SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64',
    ]));
  });

  it('drops non-relative redirect paths from OAuth state', async () => {
    const db = createMemoryDb();
    const app = createApp(db, jest.fn());

    const response = await request(app)
      .post('/api/social/tiktok/connect/start')
      .send({
        storyId: 'story-123',
        takeId: 'take-456',
        redirectPath: 'https://evil.example/steal',
      });

    expect(response.status).toBe(200);

    const state = new URL(response.body.authorizeUrl).searchParams.get('state');
    const storedState = db._collections.socialAuthStates.get(state);
    expect(storedState.redirectPath).toBeNull();
  });

  it('completes the TikTok callback and returns sanitized account status', async () => {
    const db = createMemoryDb();
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'tt-access-token',
        refresh_token: 'tt-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_expires_in: 86400,
        scope: 'user.info.basic,video.upload',
        open_id: 'open-123',
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          user: {
            open_id: 'open-123',
            union_id: 'union-456',
            display_name: 'Creator </script><script>alert(1)</script>',
            avatar_url: 'https://cdn.example.com/avatar.jpg',
          },
        },
      }));
    const app = createApp(db, fetchImpl);

    const startResponse = await request(app)
      .post('/api/social/tiktok/connect/start')
      .send({ storyId: 'story-123', takeId: 'take-456' });

    const state = new URL(startResponse.body.authorizeUrl).searchParams.get('state');

    const callbackResponse = await request(app)
      .get('/api/social/tiktok/connect/callback')
      .query({ code: 'oauth-code', state });

    expect(callbackResponse.status).toBe(200);
    expect(callbackResponse.text).toContain('social-oauth-success');
    expect(callbackResponse.text).not.toContain('ciphertext');
    expect(callbackResponse.text).not.toContain('</script><script>alert(1)</script>');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [[socialAccountId, storedAccount]] = db._collections.socialAccounts.entries();
    expect(socialAccountId).toBeTruthy();
    expect(storedAccount.platform).toBe('tiktok');
    expect(storedAccount.loginProvider).toBe('tiktok_oauth');
    expect(storedAccount.platformAccountId).toBe('open-123');
    expect(storedAccount.accessToken.ciphertext).toBeTruthy();
    expect(storedAccount.accessToken.ciphertext).not.toBe('tt-access-token');
    expect(storedAccount.refreshToken.ciphertext).toBeTruthy();
    expect(storedAccount.meta.openId).toBe('open-123');
    expect(storedAccount.meta.unionId).toBe('union-456');

    const stateDoc = db._collections.socialAuthStates.get(state);
    expect(stateDoc.usedAt).toBeTruthy();

    const accountsResponse = await request(app).get('/api/social/accounts');

    expect(accountsResponse.status).toBe(200);
    expect(accountsResponse.body.platforms.tiktok.connected).toBe(true);
    expect(accountsResponse.body.accounts).toHaveLength(1);
    expect(accountsResponse.body.accounts[0].displayName).toBe('Creator </script><script>alert(1)</script>');
    expect(accountsResponse.body.accounts[0].userId).toBeUndefined();
    expect(accountsResponse.body.accounts[0].platformAccountId).toBeUndefined();
    expect(accountsResponse.body.accounts[0].accessToken).toBeUndefined();
    expect(accountsResponse.body.accounts[0].refreshToken).toBeUndefined();
    expect(accountsResponse.body.accounts[0].hasRefreshToken).toBe(true);
  });

  it('completes the Instagram callback and stores professional account metadata', async () => {
    const db = createMemoryDb();
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'meta-short-token',
        token_type: 'bearer',
        expires_in: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'meta-long-token',
        token_type: 'bearer',
        expires_in: 5183944,
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'fb-user-123',
        name: 'Meta Tester',
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [
          {
            id: 'page-789',
            name: 'Storyteller Studio',
            instagram_business_account: {
              id: 'ig-456',
              username: 'storyteller.creator',
              name: 'Storyteller Creator',
              profile_picture_url: 'https://cdn.example.com/ig-avatar.jpg',
            },
          },
        ],
      }));
    const app = createApp(db, fetchImpl);

    const startResponse = await request(app)
      .post('/api/social/instagram/connect/start')
      .send({ storyId: 'story-789', takeId: 'take-111' });

    expect(startResponse.status).toBe(200);
    const authorizeUrl = new URL(startResponse.body.authorizeUrl);
    expect(authorizeUrl.origin).toBe('https://www.facebook.com');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('meta-app-id');
    expect(authorizeUrl.searchParams.get('scope')).toBe(
      'instagram_basic,instagram_content_publish,pages_read_engagement,pages_show_list'
    );

    const state = authorizeUrl.searchParams.get('state');
    const callbackResponse = await request(app)
      .get('/api/social/instagram/connect/callback')
      .query({ code: 'meta-code', state });

    expect(callbackResponse.status).toBe(200);
    expect(callbackResponse.text).toContain('social-oauth-success');
    expect(callbackResponse.text).not.toContain('ciphertext');
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    const [[, storedAccount]] = db._collections.socialAccounts.entries();
    expect(storedAccount.platform).toBe('instagram');
    expect(storedAccount.loginProvider).toBe('facebook_login_for_business');
    expect(storedAccount.platformAccountId).toBe('ig-456');
    expect(storedAccount.accessToken.ciphertext).toBeTruthy();
    expect(storedAccount.refreshToken).toBeNull();
    expect(storedAccount.meta.igUserId).toBe('ig-456');
    expect(storedAccount.meta.facebookPageId).toBe('page-789');
    expect(storedAccount.meta.facebookPageName).toBe('Storyteller Studio');
    expect(storedAccount.meta.facebookUserId).toBe('fb-user-123');

    const accountsResponse = await request(app).get('/api/social/accounts');
    expect(accountsResponse.status).toBe(200);
    expect(accountsResponse.body.platforms.instagram.connected).toBe(true);
    expect(accountsResponse.body.accounts[0].username).toBe('storyteller.creator');
    expect(accountsResponse.body.accounts[0].meta).toBeUndefined();
    expect(accountsResponse.body.accounts[0].accessToken).toBeUndefined();
  });

  it('disconnects a connected social account and clears connection state', async () => {
    const db = createMemoryDb();
    const app = createApp(db, jest.fn());

    db._collections.socialAccounts.set('social-1', {
      userId: 'user-123',
      platform: 'tiktok',
      displayName: 'Creator One',
      username: 'creator.one',
      status: 'active',
      connectedAt: new Date('2026-06-04T12:00:00.000Z'),
      updatedAt: new Date('2026-06-04T12:00:00.000Z'),
      accessToken: { ciphertext: 'abc' },
      refreshToken: { ciphertext: 'def' },
    });

    const response = await request(app)
      .delete('/api/social/accounts/social-1');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.account.platform).toBe('tiktok');
    expect(response.body.account.status).toBe('disconnected');
    expect(response.body.account.hasRefreshToken).toBe(false);

    const storedAccount = db._collections.socialAccounts.get('social-1');
    expect(storedAccount.status).toBe('disconnected');
    expect(storedAccount.accessToken).toBeNull();
    expect(storedAccount.refreshToken).toBeNull();

    const accountsResponse = await request(app).get('/api/social/accounts');
    expect(accountsResponse.status).toBe(200);
    expect(accountsResponse.body.platforms.tiktok.connected).toBe(false);
    expect(accountsResponse.body.accounts[0].status).toBe('disconnected');
    expect(accountsResponse.body.accounts[0].hasRefreshToken).toBe(false);
  });

  it('refreshes TikTok publish status before returning a publish job payload', async () => {
    const db = createMemoryDb();
    const storage = { bucket: jest.fn() };
    const publishJobStatusSync = jest.fn(async () => ({
      publishJobId: 'publish-1',
      status: 'awaiting_user_action',
      statusMessage: 'Draft delivered to TikTok. Open TikTok to review, edit, and post it.',
      platformStatus: 'SEND_TO_USER_INBOX',
      platformPublishId: 'v_inbox_file~123',
      lastError: null,
    }));
    const app = createApp(db, jest.fn(), {
      publishJobStatusSync,
      storage,
      bucketName: 'test-bucket',
    });

    db._collections.socialPublishJobs.set('publish-1', {
      userId: 'user-123',
      platform: 'tiktok',
      publishMode: 'tiktok_draft',
      status: 'processing',
      platformPublishId: 'v_inbox_file~123',
      createdAt: new Date('2026-06-04T12:00:00.000Z'),
      updatedAt: new Date('2026-06-04T12:00:00.000Z'),
    });

    const response = await request(app)
      .get('/api/social/publishes/publish-1');

    expect(response.status).toBe(200);
    expect(publishJobStatusSync).toHaveBeenCalledWith(expect.objectContaining({
      db,
      storage,
      defaultBucketName: 'test-bucket',
      publishJobId: 'publish-1',
    }));
    expect(response.body.publishJob.status).toBe('awaiting_user_action');
    expect(response.body.publishJob.platformStatus).toBe('SEND_TO_USER_INBOX');
    expect(response.body.publishJob.statusMessage).toContain('Draft delivered to TikTok');
  });

  it('refreshes Instagram publish status before returning a publish job payload', async () => {
    const db = createMemoryDb();
    const publishJobStatusSync = jest.fn(async () => ({
      publishJobId: 'publish-2',
      status: 'completed',
      statusMessage: 'Instagram Reel published.',
      platformStatus: 'PUBLISHED',
      platformContainerId: 'ig-container-1',
      platformPostId: 'ig-media-1',
      lastError: null,
    }));
    const app = createApp(db, jest.fn(), { publishJobStatusSync });

    db._collections.socialPublishJobs.set('publish-2', {
      userId: 'user-123',
      platform: 'instagram',
      publishMode: 'instagram_reel',
      status: 'processing',
      platformContainerId: 'ig-container-1',
      createdAt: new Date('2026-06-08T12:00:00.000Z'),
      updatedAt: new Date('2026-06-08T12:00:00.000Z'),
    });

    const response = await request(app)
      .get('/api/social/publishes/publish-2');

    expect(response.status).toBe(200);
    expect(publishJobStatusSync).toHaveBeenCalledWith(expect.objectContaining({
      db,
      publishJobId: 'publish-2',
    }));
    expect(response.body.publishJob.status).toBe('completed');
    expect(response.body.publishJob.platformStatus).toBe('PUBLISHED');
    expect(response.body.publishJob.platformContainerId).toBe('ig-container-1');
    expect(response.body.publishJob.platformPostId).toBe('ig-media-1');
  });
});
