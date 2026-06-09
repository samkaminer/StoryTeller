const {
  ensureUsableSocialAccessToken,
} = require('../services/social-token-service');
const { encryptSecret, decryptSecret } = require('../utils/social-crypto');

function createMemoryDb() {
  const collections = {
    socialAccounts: new Map(),
  };

  return {
    _collections: collections,
    collection: jest.fn((collectionName) => ({
      doc: jest.fn((docId) => ({
        update: jest.fn(async (patch) => {
          const current = collections[collectionName].get(docId) || {};
          collections[collectionName].set(docId, { ...current, ...patch });
        }),
      })),
    })),
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: jest.fn(() => null),
    },
    text: jest.fn(async () => JSON.stringify(body)),
  };
}

describe('social token service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 3).toString('base64');
    process.env.TIKTOK_CLIENT_KEY = 'tt-client-key';
    process.env.TIKTOK_CLIENT_SECRET = 'tt-client-secret';
    process.env.TIKTOK_REDIRECT_URI = 'http://localhost:3001/api/social/tiktok/connect/callback';
    process.env.TIKTOK_CONNECT_SCOPES = 'user.info.basic,video.upload';
    process.env.META_APP_ID = 'meta-app-id';
    process.env.META_APP_SECRET = 'meta-app-secret';
    process.env.META_REDIRECT_URI = 'http://localhost:3001/api/social/instagram/connect/callback';
  });

  it('refreshes a near-expiry TikTok access token before publishing', async () => {
    const db = createMemoryDb();
    const socialAccount = {
      doc: { id: 'social-1' },
      data: {
        userId: 'user-123',
        platform: 'tiktok',
        status: 'active',
        scopes: ['video.upload'],
        accessToken: encryptSecret('stale-access-token'),
        refreshToken: encryptSecret('refresh-token'),
        tokenExpiresAt: new Date(Date.now() + 60_000),
        refreshTokenExpiresAt: new Date(Date.now() + (24 * 60 * 60 * 1000)),
      },
    };
    db._collections.socialAccounts.set('social-1', socialAccount.data);

    const accessToken = await ensureUsableSocialAccessToken({
      db,
      socialAccount,
      platform: 'tiktok',
      fetchImpl: jest.fn().mockResolvedValueOnce(jsonResponse({
        access_token: 'fresh-access-token',
        refresh_token: 'fresh-refresh-token',
        token_type: 'Bearer',
        expires_in: 7200,
        refresh_expires_in: 1209600,
        scope: 'user.info.basic,video.upload',
      })),
    });

    expect(accessToken).toBe('fresh-access-token');
    const stored = db._collections.socialAccounts.get('social-1');
    expect(stored.status).toBe('active');
    expect(stored.scopes).toEqual(['user.info.basic', 'video.upload']);
    expect(decryptSecret(stored.accessToken)).toBe('fresh-access-token');
    expect(decryptSecret(stored.refreshToken)).toBe('fresh-refresh-token');
    expect(stored.lastRefreshAt).toBeInstanceOf(Date);
  });

  it('marks the TikTok account for reconnect when token refresh is rejected', async () => {
    const db = createMemoryDb();
    const socialAccount = {
      doc: { id: 'social-1' },
      data: {
        userId: 'user-123',
        platform: 'tiktok',
        status: 'active',
        scopes: ['video.upload'],
        accessToken: encryptSecret('stale-access-token'),
        refreshToken: encryptSecret('expired-refresh-token'),
        tokenExpiresAt: new Date(Date.now() + 60_000),
        refreshTokenExpiresAt: new Date(Date.now() + (24 * 60 * 60 * 1000)),
      },
    };
    db._collections.socialAccounts.set('social-1', socialAccount.data);

    await expect(ensureUsableSocialAccessToken({
      db,
      socialAccount,
      platform: 'tiktok',
      fetchImpl: jest.fn().mockResolvedValueOnce(jsonResponse({
        error: 'access_token_invalid',
        error_description: 'Refresh token is invalid',
      }, 401)),
    })).rejects.toMatchObject({
      uiSafeError: expect.objectContaining({
        code: 'tiktok_reconnect_required',
      }),
    });

    expect(db._collections.socialAccounts.get('social-1').status).toBe('reauth_required');
  });

  it('marks the Instagram account for reconnect when the long-lived token has expired', async () => {
    const db = createMemoryDb();
    const socialAccount = {
      doc: { id: 'social-1' },
      data: {
        userId: 'user-123',
        platform: 'instagram',
        status: 'active',
        scopes: ['instagram_basic', 'instagram_content_publish'],
        accessToken: encryptSecret('ig-access-token'),
        tokenExpiresAt: new Date(Date.now() - 60_000),
      },
    };
    db._collections.socialAccounts.set('social-1', socialAccount.data);

    await expect(ensureUsableSocialAccessToken({
      db,
      socialAccount,
      platform: 'instagram',
    })).rejects.toMatchObject({
      uiSafeError: expect.objectContaining({
        code: 'instagram_reconnect_required',
      }),
    });

    expect(db._collections.socialAccounts.get('social-1').status).toBe('reauth_required');
  });
});
