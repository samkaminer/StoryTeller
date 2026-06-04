const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { requireAuth } = require('../middleware/auth');
const rateLimiters = require('../middleware/rateLimiter');
const {
  disconnectOwnedSocialAccount,
  getOwnedPublishJob,
  listSocialAccounts,
  normalizeScopes,
  upsertConnectedSocialAccount,
} = require('../utils/social-store');
const { createSocialAuthState, consumeSocialAuthState } = require('../utils/social-auth-state');
const { assertSocialTokenEncryptionConfig } = require('../utils/social-crypto');

const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/';

function splitScopes(value, fallback) {
  if (Array.isArray(value)) return normalizeScopes(value);
  if (typeof value !== 'string' || !value.trim()) return normalizeScopes(fallback);
  return normalizeScopes(value.split(/[,\s]+/));
}

function getDb(options) {
  return options.db || admin.firestore();
}

function getFetchImpl(options) {
  return options.fetchImpl || fetch;
}

function getAbsoluteBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function addSecondsToNow(seconds) {
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + (seconds * 1000))
    : null;
}

function getMissingEnvVars(envVars) {
  return envVars.filter((name) => !process.env[name]);
}

function getTikTokConfig() {
  const missingEnvVars = getMissingEnvVars([
    'TIKTOK_CLIENT_KEY',
    'TIKTOK_CLIENT_SECRET',
    'TIKTOK_REDIRECT_URI',
    'SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64',
  ]);
  if (missingEnvVars.length) {
    const error = new Error('TikTok OAuth is not configured');
    error.missingEnvVars = missingEnvVars;
    throw error;
  }

  assertSocialTokenEncryptionConfig();

  return {
    clientKey: process.env.TIKTOK_CLIENT_KEY,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET,
    redirectUri: process.env.TIKTOK_REDIRECT_URI,
    scopes: splitScopes(process.env.TIKTOK_CONNECT_SCOPES, [
      'user.info.basic',
      'video.upload',
    ]),
  };
}

function getMetaConfig() {
  const missingEnvVars = getMissingEnvVars([
    'META_APP_ID',
    'META_APP_SECRET',
    'META_REDIRECT_URI',
    'SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64',
  ]);
  if (missingEnvVars.length) {
    const error = new Error('Meta OAuth is not configured');
    error.missingEnvVars = missingEnvVars;
    throw error;
  }

  assertSocialTokenEncryptionConfig();

  return {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    redirectUri: process.env.META_REDIRECT_URI,
    graphVersion: process.env.META_GRAPH_API_VERSION || 'v23.0',
    scopes: splitScopes(process.env.META_CONNECT_SCOPES, [
      'instagram_basic',
      'instagram_content_publish',
      'pages_read_engagement',
      'pages_show_list',
    ]),
  };
}

function buildTikTokAuthorizeUrl(config, stateRecord) {
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.searchParams.set('client_key', config.clientKey);
  url.searchParams.set('scope', config.scopes.join(','));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', stateRecord.state);
  return url.toString();
}

function buildMetaAuthorizeUrl(config, stateRecord) {
  const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', stateRecord.state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scopes.join(','));
  return url.toString();
}

async function fetchJsonResponse(response) {
  const bodyText = await response.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch (_err) {
    body = { raw: bodyText };
  }

  if (!response.ok) {
    const error = new Error(
      body?.error?.message ||
      body?.error_description ||
      body?.message ||
      `Provider request failed with status ${response.status}`
    );
    error.status = response.status;
    error.providerBody = body;
    throw error;
  }

  return body;
}

function getTikTokRequestedFields(scopes) {
  const fields = ['open_id', 'union_id', 'avatar_url', 'display_name'];
  if (scopes.includes('user.info.profile')) {
    fields.push('username', 'profile_deep_link');
  }
  return fields;
}

async function exchangeTikTokCode(fetchImpl, config, code) {
  const params = new URLSearchParams();
  params.set('client_key', config.clientKey);
  params.set('client_secret', config.clientSecret);
  params.set('code', code);
  params.set('grant_type', 'authorization_code');
  params.set('redirect_uri', config.redirectUri);

  const response = await fetchImpl(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  return fetchJsonResponse(response);
}

async function fetchTikTokUser(fetchImpl, accessToken, scopes) {
  const fields = getTikTokRequestedFields(scopes).join(',');
  const url = `${TIKTOK_USER_INFO_URL}?fields=${encodeURIComponent(fields)}`;
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const body = await fetchJsonResponse(response);
  return body?.data?.user || {};
}

async function exchangeMetaCode(fetchImpl, config, code) {
  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/oauth/access_token`);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('code', code);

  const response = await fetchImpl(url.toString());
  return fetchJsonResponse(response);
}

async function exchangeMetaLongLivedToken(fetchImpl, config, accessToken) {
  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('fb_exchange_token', accessToken);

  const response = await fetchImpl(url.toString());
  return fetchJsonResponse(response);
}

async function fetchMetaUser(fetchImpl, config, accessToken) {
  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/me`);
  url.searchParams.set('fields', 'id,name');
  url.searchParams.set('access_token', accessToken);

  const response = await fetchImpl(url.toString());
  return fetchJsonResponse(response);
}

async function fetchMetaInstagramAccount(fetchImpl, config, accessToken) {
  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/me/accounts`);
  url.searchParams.set(
    'fields',
    'id,name,instagram_business_account{id,username,name,profile_picture_url},connected_instagram_account{id,username,name,profile_picture_url}'
  );
  url.searchParams.set('access_token', accessToken);

  const response = await fetchImpl(url.toString());
  const body = await fetchJsonResponse(response);
  const page = (body?.data || []).find((candidate) => (
    candidate?.instagram_business_account?.id ||
    candidate?.connected_instagram_account?.id
  ));

  if (!page) {
    throw new Error('No Instagram professional account is connected to an eligible Facebook Page');
  }

  const instagramAccount = page.instagram_business_account || page.connected_instagram_account;
  return {
    facebookPageId: page.id || null,
    facebookPageName: page.name || null,
    instagramAccount,
  };
}

function createPopupHtml(payload) {
  const serializedPayload = JSON.stringify(payload).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      case '\u2029':
        return '\\u2029';
      default:
        return char;
    }
  });
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Connected Account</title>
</head>
<body style="font-family: Arial, sans-serif; padding: 24px;">
  <p>Account connection complete. You can close this window.</p>
  <script>
    (function () {
      var payload = ${serializedPayload};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, window.location.origin);
      }
      window.close();
    }());
  </script>
</body>
</html>`;
}

function buildPlatformStatus(accounts) {
  const platforms = {
    tiktok: { connected: false, account: null },
    instagram: { connected: false, account: null },
  };

  for (const account of accounts) {
    platforms[account.platform] = {
      connected: account.status === 'active',
      account,
    };
  }

  return platforms;
}

function handleProviderConfigError(res, error) {
  if (!error?.missingEnvVars) return false;
  res.status(500).json({
    error: error.message,
    missingEnvVars: error.missingEnvVars,
  });
  return true;
}

async function handleTikTokCallback(req, res, options) {
  const db = getDb(options);
  const fetchImpl = getFetchImpl(options);
  const config = getTikTokConfig();
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.status(200).type('html').send(createPopupHtml({
      type: 'social-oauth-error',
      platform: 'tiktok',
      error: errorDescription || error,
    }));
  }
  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  const stateRecord = await consumeSocialAuthState(db, state, 'tiktok');
  const tokenResponse = await exchangeTikTokCode(fetchImpl, config, code);
  const grantedScopes = splitScopes(tokenResponse.scope, stateRecord.data.requestedScopes);
  const profile = await fetchTikTokUser(fetchImpl, tokenResponse.access_token, grantedScopes);

  const account = await upsertConnectedSocialAccount(db, stateRecord.data.userId, {
    platform: 'tiktok',
    platformAccountId: profile.open_id || tokenResponse.open_id || null,
    displayName: profile.display_name || null,
    username: profile.username || null,
    status: 'active',
    loginProvider: 'tiktok_oauth',
    scopes: grantedScopes,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token || null,
    tokenType: tokenResponse.token_type || 'Bearer',
    tokenExpiresAt: addSecondsToNow(Number(tokenResponse.expires_in)),
    refreshTokenExpiresAt: addSecondsToNow(Number(tokenResponse.refresh_expires_in)),
    meta: {
      openId: profile.open_id || tokenResponse.open_id || null,
      unionId: profile.union_id || null,
      avatarUrl: profile.avatar_url || null,
      profileDeepLink: profile.profile_deep_link || null,
    },
  });

  return res.status(200).type('html').send(createPopupHtml({
    type: 'social-oauth-success',
    platform: 'tiktok',
    account,
    redirectPath: stateRecord.data.redirectPath || null,
    storyId: stateRecord.data.storyId || null,
    takeId: stateRecord.data.takeReportId || null,
  }));
}

async function handleInstagramCallback(req, res, options) {
  const db = getDb(options);
  const fetchImpl = getFetchImpl(options);
  const config = getMetaConfig();
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.status(200).type('html').send(createPopupHtml({
      type: 'social-oauth-error',
      platform: 'instagram',
      error: errorDescription || error,
    }));
  }
  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  const stateRecord = await consumeSocialAuthState(db, state, 'instagram');
  const shortLivedToken = await exchangeMetaCode(fetchImpl, config, code);
  const longLivedToken = await exchangeMetaLongLivedToken(fetchImpl, config, shortLivedToken.access_token);
  const accessToken = longLivedToken.access_token || shortLivedToken.access_token;
  const facebookUser = await fetchMetaUser(fetchImpl, config, accessToken);
  const instagramResult = await fetchMetaInstagramAccount(fetchImpl, config, accessToken);
  const grantedScopes = stateRecord.data.requestedScopes?.length
    ? stateRecord.data.requestedScopes
    : config.scopes;

  const account = await upsertConnectedSocialAccount(db, stateRecord.data.userId, {
    platform: 'instagram',
    platformAccountId: instagramResult.instagramAccount.id,
    displayName: instagramResult.instagramAccount.name || instagramResult.instagramAccount.username || null,
    username: instagramResult.instagramAccount.username || null,
    status: 'active',
    loginProvider: 'facebook_login_for_business',
    scopes: grantedScopes,
    accessToken,
    refreshToken: null,
    tokenType: longLivedToken.token_type || shortLivedToken.token_type || 'Bearer',
    tokenExpiresAt: addSecondsToNow(Number(longLivedToken.expires_in || shortLivedToken.expires_in)),
    refreshTokenExpiresAt: null,
    meta: {
      igUserId: instagramResult.instagramAccount.id || null,
      facebookPageId: instagramResult.facebookPageId,
      facebookPageName: instagramResult.facebookPageName,
      facebookUserId: facebookUser.id || null,
      avatarUrl: instagramResult.instagramAccount.profile_picture_url || null,
    },
  });

  return res.status(200).type('html').send(createPopupHtml({
    type: 'social-oauth-success',
    platform: 'instagram',
    account,
    redirectPath: stateRecord.data.redirectPath || null,
    storyId: stateRecord.data.storyId || null,
    takeId: stateRecord.data.takeReportId || null,
  }));
}

function createRouter(options = {}) {
  const router = express.Router();
  const db = getDb(options);

  router.get('/accounts', requireAuth, async (req, res) => {
    try {
      const accounts = await listSocialAccounts(db, req.user.uid);
      res.json({
        accounts,
        platforms: buildPlatformStatus(accounts),
      });
    } catch (err) {
      console.error('[social GET /accounts]', err.message);
      res.status(500).json({ error: 'Failed to load social accounts' });
    }
  });

  router.delete('/accounts/:socialAccountId', requireAuth, async (req, res) => {
    try {
      const account = await disconnectOwnedSocialAccount(db, req.user.uid, req.params.socialAccountId);
      if (!account) {
        return res.status(404).json({ error: 'Social account not found' });
      }

      res.json({
        ok: true,
        account: account.serialized,
      });
    } catch (err) {
      console.error('[social DELETE /accounts/:socialAccountId]', err.message);
      res.status(500).json({ error: 'Failed to disconnect social account' });
    }
  });

  router.post('/tiktok/connect/start', rateLimiters.socialConnect, requireAuth, async (req, res) => {
    try {
      const config = getTikTokConfig();
      const stateRecord = await createSocialAuthState(db, {
        userId: req.user.uid,
        platform: 'tiktok',
        storyId: req.body?.storyId || null,
        takeReportId: req.body?.takeId || null,
        redirectPath: req.body?.redirectPath || null,
        requestedScopes: config.scopes,
      });

      res.json({
        ok: true,
        platform: 'tiktok',
        authorizeUrl: buildTikTokAuthorizeUrl(config, stateRecord),
        redirectUri: config.redirectUri,
      });
    } catch (err) {
      if (handleProviderConfigError(res, err)) return;
      console.error('[social POST /tiktok/connect/start]', err.message);
      res.status(500).json({ error: 'Failed to start TikTok connection' });
    }
  });

  router.get('/tiktok/connect/callback', rateLimiters.socialConnect, async (req, res) => {
    try {
      await handleTikTokCallback(req, res, options);
    } catch (err) {
      console.error('[social GET /tiktok/connect/callback]', err.message);
      res.status(500).type('html').send(createPopupHtml({
        type: 'social-oauth-error',
        platform: 'tiktok',
        error: err.message || 'Failed to connect TikTok account',
      }));
    }
  });

  router.post('/instagram/connect/start', rateLimiters.socialConnect, requireAuth, async (req, res) => {
    try {
      const config = getMetaConfig();
      const stateRecord = await createSocialAuthState(db, {
        userId: req.user.uid,
        platform: 'instagram',
        storyId: req.body?.storyId || null,
        takeReportId: req.body?.takeId || null,
        redirectPath: req.body?.redirectPath || null,
        requestedScopes: config.scopes,
      });

      res.json({
        ok: true,
        platform: 'instagram',
        authorizeUrl: buildMetaAuthorizeUrl(config, stateRecord),
        redirectUri: config.redirectUri,
      });
    } catch (err) {
      if (handleProviderConfigError(res, err)) return;
      console.error('[social POST /instagram/connect/start]', err.message);
      res.status(500).json({ error: 'Failed to start Instagram connection' });
    }
  });

  router.get('/instagram/connect/callback', rateLimiters.socialConnect, async (req, res) => {
    try {
      await handleInstagramCallback(req, res, options);
    } catch (err) {
      console.error('[social GET /instagram/connect/callback]', err.message);
      res.status(500).type('html').send(createPopupHtml({
        type: 'social-oauth-error',
        platform: 'instagram',
        error: err.message || 'Failed to connect Instagram account',
      }));
    }
  });

  router.get('/publishes/:publishJobId', requireAuth, async (req, res) => {
    try {
      const publishJob = await getOwnedPublishJob(db, req.user.uid, req.params.publishJobId);
      if (!publishJob) {
        return res.status(404).json({ error: 'Publish job not found' });
      }

      res.json({ publishJob: publishJob.serialized });
    } catch (err) {
      console.error('[social GET /publishes/:publishJobId]', err.message);
      res.status(500).json({ error: 'Failed to load publish job' });
    }
  });

  return router;
}

const defaultRouter = createRouter();

module.exports = defaultRouter;
module.exports.createRouter = createRouter;
module.exports._private = {
  buildMetaAuthorizeUrl,
  buildTikTokAuthorizeUrl,
  getAbsoluteBaseUrl,
  getMetaConfig,
  getTikTokConfig,
};
