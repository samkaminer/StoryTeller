const fetch = require('node-fetch');
const {
  getEffectiveSocialAccountStatus,
  isDateExpired,
  updateSocialAccount,
} = require('../utils/social-store');
const { decryptSecret, encryptSecret } = require('../utils/social-crypto');
const { executePlatformRequest } = require('../utils/social-http');
const { logSocialAudit } = require('../utils/social-audit');
const {
  addSecondsToNow,
  getMetaConfig,
  getTikTokConfig,
  splitScopes,
} = require('../utils/social-provider-config');

const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';

function getFetchImpl(options) {
  return options.fetchImpl || fetch;
}

function createReconnectRequiredError(platform, message) {
  const err = new Error(message);
  err.uiSafeError = {
    code: `${platform}_reconnect_required`,
    message,
    retryable: false,
  };
  return err;
}

function isRefreshRejectedError(error) {
  const status = error?.httpStatus || error?.status || null;
  const platformCode = String(error?.platformCode || '').toLowerCase();
  return (
    status === 400 ||
    status === 401 ||
    platformCode === 'access_token_invalid' ||
    platformCode === 'scope_not_authorized' ||
    platformCode === 'invalid_grant'
  );
}

async function readJsonResponse(response) {
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_error) {
    body = { raw: text };
  }

  if (!response.ok) {
    const err = new Error(
      body?.error?.message ||
      body?.error_description ||
      body?.message ||
      `Provider request failed with status ${response.status}`
    );
    err.status = response.status;
    err.httpStatus = response.status;
    err.providerBody = body;
    err.platformCode = body?.error?.code || body?.code || body?.error || null;
    err.retryAfter = response.headers?.get?.('retry-after') || null;
    throw err;
  }

  return body;
}

async function markSocialAccountReauthRequired(db, socialAccount, reason) {
  if (!socialAccount?.doc?.id) return;

  await updateSocialAccount(db, socialAccount.doc.id, {
    status: 'reauth_required',
    lastValidatedAt: new Date(),
  });

  logSocialAudit('account_marked_reauth_required', {
    level: 'warn',
    platform: socialAccount.data.platform,
    socialAccountId: socialAccount.doc.id,
    userId: socialAccount.data.userId,
    message: reason,
  });
}

async function refreshTikTokAccessToken(options) {
  const { db, socialAccount } = options;
  const fetchImpl = getFetchImpl(options);
  const config = getTikTokConfig();
  const refreshToken = decryptSecret(socialAccount?.data?.refreshToken);

  if (!refreshToken || isDateExpired(socialAccount?.data?.refreshTokenExpiresAt, 5 * 60 * 1000)) {
    await markSocialAccountReauthRequired(db, socialAccount, 'TikTok refresh token expired or missing');
    throw createReconnectRequiredError(
      'tiktok',
      'Your TikTok connection has expired. Reconnect TikTok and try again.'
    );
  }

  const body = await executePlatformRequest(async () => {
    const params = new URLSearchParams();
    params.set('client_key', config.clientKey);
    params.set('client_secret', config.clientSecret);
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refreshToken);

    const response = await fetchImpl(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    return readJsonResponse(response);
  }, {
    audit: {
      action: 'tiktok_token_refresh',
      platform: 'tiktok',
      userId: socialAccount?.data?.userId,
      socialAccountId: socialAccount?.doc?.id,
    },
  });

  const grantedScopes = splitScopes(body.scope, socialAccount?.data?.scopes || []);
  await updateSocialAccount(db, socialAccount.doc.id, {
    status: 'active',
    scopes: grantedScopes,
    accessToken: encryptSecret(body.access_token),
    refreshToken: body.refresh_token ? encryptSecret(body.refresh_token) : socialAccount.data.refreshToken,
    tokenType: body.token_type || socialAccount.data.tokenType || 'Bearer',
    tokenExpiresAt: addSecondsToNow(Number(body.expires_in)),
    refreshTokenExpiresAt: addSecondsToNow(Number(body.refresh_expires_in)),
    lastValidatedAt: new Date(),
    lastRefreshAt: new Date(),
  });

  logSocialAudit('token_refreshed', {
    platform: 'tiktok',
    socialAccountId: socialAccount.doc.id,
    userId: socialAccount.data.userId,
    message: 'Refreshed TikTok access token',
  });

  return body.access_token;
}

async function ensureUsableSocialAccessToken(options) {
  const { db, socialAccount, platform } = options;
  if (!socialAccount) {
    throw createReconnectRequiredError(
      platform,
      `Your ${platform === 'instagram' ? 'Instagram' : 'TikTok'} connection is no longer active. Reconnect and try again.`
    );
  }

  const effectiveStatus = getEffectiveSocialAccountStatus(socialAccount.data);
  if (effectiveStatus !== 'active') {
    await markSocialAccountReauthRequired(db, socialAccount, `${platform} effective status is ${effectiveStatus}`);
    throw createReconnectRequiredError(
      platform,
      `Your ${platform === 'instagram' ? 'Instagram' : 'TikTok'} connection has expired. Reconnect and try again.`
    );
  }

  const accessToken = decryptSecret(socialAccount.data.accessToken);
  if (!accessToken) {
    await markSocialAccountReauthRequired(db, socialAccount, `${platform} access token missing`);
    throw createReconnectRequiredError(
      platform,
      `Your ${platform === 'instagram' ? 'Instagram' : 'TikTok'} connection is missing a usable access token. Reconnect and try again.`
    );
  }

  if (platform === 'tiktok' && isDateExpired(socialAccount.data.tokenExpiresAt, 10 * 60 * 1000)) {
    try {
      return await refreshTikTokAccessToken(options);
    } catch (error) {
      if (isRefreshRejectedError(error)) {
        await markSocialAccountReauthRequired(db, socialAccount, 'TikTok token refresh rejected');
        throw createReconnectRequiredError(
          'tiktok',
          'Your TikTok connection has expired. Reconnect TikTok and try again.'
        );
      }
      throw error;
    }
  }

  if (platform === 'instagram' && isDateExpired(socialAccount.data.tokenExpiresAt, 10 * 60 * 1000)) {
    await markSocialAccountReauthRequired(db, socialAccount, 'Instagram long-lived token expired');
    throw createReconnectRequiredError(
      'instagram',
      'Your Instagram connection has expired. Reconnect Instagram and try again.'
    );
  }

  await updateSocialAccount(db, socialAccount.doc.id, {
    lastValidatedAt: new Date(),
  });

  return accessToken;
}

async function handlePlatformReconnectSignal(options) {
  const { db, socialAccount, platform, message } = options;
  await markSocialAccountReauthRequired(db, socialAccount, message || `${platform} API requested reconnect`);
  throw createReconnectRequiredError(
    platform,
    message || `Your ${platform === 'instagram' ? 'Instagram' : 'TikTok'} connection has expired. Reconnect and try again.`
  );
}

module.exports = {
  ensureUsableSocialAccessToken,
  getMetaConfig,
  getTikTokConfig,
  handlePlatformReconnectSignal,
  markSocialAccountReauthRequired,
  refreshTikTokAccessToken,
};
