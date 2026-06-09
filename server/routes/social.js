const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const rateLimiters = require('../middleware/rateLimiter');
const {
  SOCIAL_PUBLISH_EVENT_SUBCOLLECTION,
  canRetryPublishJobData,
  buildSocialPublishJobRecord,
  createSocialPublishJob,
  disconnectOwnedSocialAccount,
  findLatestOwnedPublishJobForTarget,
  getEffectiveSocialAccountStatus,
  getOwnedSocialAccount,
  getOwnedPublishJob,
  isPublishJobFinalStatus,
  listSocialAccounts,
  serializePublishJobData,
  updateSocialPublishJob,
  upsertConnectedSocialAccount,
} = require('../utils/social-store');
const { createSocialAuthState, consumeSocialAuthState } = require('../utils/social-auth-state');
const { logSocialAudit } = require('../utils/social-audit');
const { executePlatformRequest } = require('../utils/social-http');
const {
  addSecondsToNow,
  getMetaConfig,
  getTikTokConfig,
  splitScopes,
} = require('../utils/social-provider-config');
const { scheduleSocialPublishJob, syncSocialPublishJob } = require('../services/social-publish-runner');

const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/';
const REQUIRED_PUBLISH_SCOPES = {
  tiktok: ['video.upload'],
  instagram: ['instagram_basic', 'instagram_content_publish'],
};

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

function getMissingPublishScopes(platform, scopes = []) {
  const grantedScopes = Array.isArray(scopes) ? scopes : [];
  const requiredScopes = REQUIRED_PUBLISH_SCOPES[platform] || [];
  return requiredScopes.filter((scope) => !grantedScopes.includes(scope));
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
    error.httpStatus = response.status;
    error.retryAfter = response.headers?.get?.('retry-after') || null;
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
  return executePlatformRequest(async () => {
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
  }, {
    audit: {
      platform: 'tiktok',
      message: 'Exchange TikTok OAuth code',
    },
  });
}

async function fetchTikTokUser(fetchImpl, accessToken, scopes) {
  const fields = getTikTokRequestedFields(scopes).join(',');
  const url = `${TIKTOK_USER_INFO_URL}?fields=${encodeURIComponent(fields)}`;
  return executePlatformRequest(async () => {
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const body = await fetchJsonResponse(response);
    return body?.data?.user || {};
  }, {
    audit: {
      platform: 'tiktok',
      message: 'Fetch TikTok user profile',
    },
  });
}

async function exchangeMetaCode(fetchImpl, config, code) {
  return executePlatformRequest(async () => {
    const url = new URL(`https://graph.facebook.com/${config.graphVersion}/oauth/access_token`);
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('client_secret', config.appSecret);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('code', code);

    const response = await fetchImpl(url.toString());
    return fetchJsonResponse(response);
  }, {
    audit: {
      platform: 'instagram',
      message: 'Exchange Meta OAuth code',
    },
  });
}

async function exchangeMetaLongLivedToken(fetchImpl, config, accessToken) {
  return executePlatformRequest(async () => {
    const url = new URL(`https://graph.facebook.com/${config.graphVersion}/oauth/access_token`);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('client_secret', config.appSecret);
    url.searchParams.set('fb_exchange_token', accessToken);

    const response = await fetchImpl(url.toString());
    return fetchJsonResponse(response);
  }, {
    audit: {
      platform: 'instagram',
      message: 'Exchange Meta long-lived token',
    },
  });
}

async function fetchMetaUser(fetchImpl, config, accessToken) {
  return executePlatformRequest(async () => {
    const url = new URL(`https://graph.facebook.com/${config.graphVersion}/me`);
    url.searchParams.set('fields', 'id,name');
    url.searchParams.set('access_token', accessToken);

    const response = await fetchImpl(url.toString());
    return fetchJsonResponse(response);
  }, {
    audit: {
      platform: 'instagram',
      message: 'Fetch Meta user profile',
    },
  });
}

async function fetchMetaInstagramAccount(fetchImpl, config, accessToken) {
  const body = await executePlatformRequest(async () => {
    const url = new URL(`https://graph.facebook.com/${config.graphVersion}/me/accounts`);
    url.searchParams.set(
      'fields',
      'id,name,instagram_business_account{id,username,name,profile_picture_url},connected_instagram_account{id,username,name,profile_picture_url}'
    );
    url.searchParams.set('access_token', accessToken);

    const response = await fetchImpl(url.toString());
    return fetchJsonResponse(response);
  }, {
    audit: {
      platform: 'instagram',
      message: 'Fetch Meta Page and Instagram account mapping',
    },
  });
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

function getPlatformSetupStatus(platform) {
  try {
    if (platform === 'tiktok') {
      getTikTokConfig();
    } else if (platform === 'instagram') {
      getMetaConfig();
    } else {
      throw new Error('Unsupported platform');
    }

    return {
      configured: true,
    };
  } catch (_error) {
    return {
      configured: false,
    };
  }
}

function buildPlatformConfigs() {
  return {
    tiktok: getPlatformSetupStatus('tiktok'),
    instagram: getPlatformSetupStatus('instagram'),
  };
}

function handleProviderConfigError(res, error) {
  if (!error?.missingEnvVars && !String(error?.message || '').includes('SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64')) {
    return false;
  }

  const providerLabel = String(error?.message || '').includes('TikTok') ? 'TikTok' : 'Instagram';
  res.status(503).json({
    error: `${providerLabel} connection is not available right now.`,
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
  logSocialAudit('oauth_callback_received', {
    platform: 'tiktok',
    userId: stateRecord.data.userId,
    storyId: stateRecord.data.storyId,
    takeReportId: stateRecord.data.takeReportId,
  });
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
  logSocialAudit('oauth_callback_received', {
    platform: 'instagram',
    userId: stateRecord.data.userId,
    storyId: stateRecord.data.storyId,
    takeReportId: stateRecord.data.takeReportId,
  });
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

function buildPublishTargetFilters(publishJobData = {}) {
  return {
    storyId: publishJobData.storyId || null,
    takeReportId: publishJobData.takeReportId || null,
    platform: publishJobData.platform || null,
    publishMode: publishJobData.publishMode || null,
  };
}

function createRouter(options = {}) {
  const router = express.Router();
  const publishJobStatusSync = options.publishJobStatusSync || syncSocialPublishJob;
  const publishJobScheduler = options.publishJobScheduler || scheduleSocialPublishJob;

  router.get('/accounts', requireAuth, async (req, res) => {
    try {
      const db = getDb(options);
      const accounts = await listSocialAccounts(db, req.user.uid);
      res.json({
        accounts,
        platforms: buildPlatformStatus(accounts),
        platformConfigs: buildPlatformConfigs(),
      });
    } catch (err) {
      console.error('[social GET /accounts]', err.message);
      res.status(500).json({ error: 'Failed to load social accounts' });
    }
  });

  router.delete('/accounts/:socialAccountId', requireAuth, async (req, res) => {
    try {
      const db = getDb(options);
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
      const db = getDb(options);
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
      const db = getDb(options);
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

  router.post('/publishes/:publishJobId/retry', rateLimiters.socialPublishAction, requireAuth, async (req, res) => {
    try {
      const db = getDb(options);
      const originalJob = await getOwnedPublishJob(db, req.user.uid, req.params.publishJobId);
      if (!originalJob) {
        return res.status(404).json({ error: 'Publish job not found' });
      }

      const latestTargetJob = await findLatestOwnedPublishJobForTarget(
        db,
        req.user.uid,
        buildPublishTargetFilters(originalJob.data)
      );

      if (latestTargetJob && latestTargetJob.doc.id !== originalJob.doc.id) {
        const latestIsFinal = isPublishJobFinalStatus(latestTargetJob.data.status);
        return res.status(409).json({
          error: latestIsFinal
            ? 'A newer publish attempt already exists for this take and platform'
            : 'A newer publish attempt is already in progress for this take and platform',
          publishJob: latestTargetJob.serialized,
        });
      }

      if (!canRetryPublishJobData(originalJob.data)) {
        return res.status(409).json({
          error: originalJob.data.lastError?.retryable === false
            ? 'This publish failure cannot be retried safely'
            : 'Only failed publish jobs can be retried',
          publishJob: originalJob.serialized,
        });
      }

      const account = await getOwnedSocialAccount(db, req.user.uid, originalJob.data.socialAccountId);
      if (!account || account.data.platform !== originalJob.data.platform) {
        return res.status(409).json({ error: 'Reconnect this account before retrying the publish' });
      }
      if (getEffectiveSocialAccountStatus(account.data) !== 'active') {
        return res.status(409).json({ error: 'Reconnect this account before retrying the publish' });
      }
      const missingScopes = getMissingPublishScopes(originalJob.data.platform, account.data.scopes);
      if (missingScopes.length > 0) {
        return res.status(409).json({
          error: 'Reconnect this account to restore required publishing permissions',
          missingScopes,
        });
      }

      const retryPayload = {
        storyId: originalJob.data.storyId,
        takeReportId: originalJob.data.takeReportId,
        takeResponseDocId: originalJob.data.takeResponseDocId || null,
        socialAccountId: originalJob.data.socialAccountId,
        platform: originalJob.data.platform,
        publishMode: originalJob.data.publishMode,
        caption: originalJob.data.caption || '',
        platformOptions: originalJob.data.platformOptions || {},
        mediaSnapshot: originalJob.data.mediaSnapshot || {},
        retryOfPublishJobId: originalJob.doc.id,
        statusMessage: 'Queued for retry',
      };
      let retryJob = null;

      if (typeof db.runTransaction === 'function') {
        const originalJobRef = db.collection('socialPublishJobs').doc(originalJob.doc.id);
        const { publishJobId, publishJobDoc, createdEvent } = buildSocialPublishJobRecord(req.user.uid, retryPayload);
        const retryJobRef = db.collection('socialPublishJobs').doc(publishJobId);
        const now = new Date();

        await db.runTransaction(async (transaction) => {
          const originalSnapshot = await transaction.get(originalJobRef);
          if (!originalSnapshot.exists) {
            const error = new Error('Publish job not found');
            error.status = 404;
            throw error;
          }

          const freshOriginalData = originalSnapshot.data() || {};
          if (freshOriginalData.userId !== req.user.uid) {
            const error = new Error('Publish job not found');
            error.status = 404;
            throw error;
          }
          if (!canRetryPublishJobData(freshOriginalData)) {
            const error = new Error(freshOriginalData.supersededByPublishJobId
              ? 'A newer publish attempt already exists for this take and platform'
              : (freshOriginalData.lastError?.retryable === false
                ? 'This publish failure cannot be retried safely'
                : 'Only failed publish jobs can be retried'));
            error.status = 409;
            throw error;
          }

          transaction.set(retryJobRef, publishJobDoc);
          transaction.set(
            retryJobRef.collection(SOCIAL_PUBLISH_EVENT_SUBCOLLECTION).doc(uuidv4()),
            {
              ...createdEvent,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }
          );
          transaction.update(originalJobRef, {
            supersededByPublishJobId: publishJobId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          transaction.set(
            originalJobRef.collection(SOCIAL_PUBLISH_EVENT_SUBCOLLECTION).doc(uuidv4()),
            {
              type: 'job_retry_queued',
              status: freshOriginalData.status || 'failed',
              message: `Retry queued as ${publishJobId}`,
              platformCode: freshOriginalData.platformStatus || null,
              httpStatus: 0,
              attempt: freshOriginalData.attemptCount || 0,
              payloadRedacted: {
                retryPublishJobId: publishJobId,
              },
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }
          );
        });

        retryJob = serializePublishJobData({
          ...publishJobDoc,
          queuedAt: now,
          createdAt: now,
          updatedAt: now,
        }, publishJobId);
      } else {
        retryJob = await createSocialPublishJob(db, req.user.uid, retryPayload);
        await updateSocialPublishJob(db, originalJob.doc.id, {
          supersededByPublishJobId: retryJob.publishJobId,
        }, {
          type: 'job_retry_queued',
          status: originalJob.data.status || 'failed',
          message: `Retry queued as ${retryJob.publishJobId}`,
          platformCode: originalJob.data.platformStatus || null,
          httpStatus: 0,
          attempt: originalJob.data.attemptCount || 0,
          payloadRedacted: {
            retryPublishJobId: retryJob.publishJobId,
          },
        });
      }

      res.status(202).json({
        ok: true,
        reusedExisting: false,
        publishJob: retryJob,
      });

      logSocialAudit('publish_retry_queued', {
        platform: retryJob.platform,
        userId: req.user.uid,
        socialAccountId: retryJob.socialAccountId,
        publishJobId: retryJob.publishJobId,
        retryOfPublishJobId: originalJob.doc.id,
        storyId: retryJob.storyId,
        takeReportId: retryJob.takeReportId,
        message: 'Queued retry publish job',
      });

      if (typeof publishJobScheduler === 'function') {
        publishJobScheduler({
          db,
          storage: options.storage || null,
          defaultBucketName: options.bucketName || null,
          publishJobId: retryJob.publishJobId,
        });
      }
    } catch (err) {
      console.error('[social POST /publishes/:publishJobId/retry]', err.message);
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to retry publish job' });
    }
  });

  router.get('/publishes/:publishJobId', rateLimiters.socialPublishStatus, requireAuth, async (req, res) => {
    try {
      const db = getDb(options);
      let publishJob = await getOwnedPublishJob(db, req.user.uid, req.params.publishJobId);
      if (!publishJob) {
        return res.status(404).json({ error: 'Publish job not found' });
      }

      if (typeof publishJobStatusSync === 'function') {
        const refreshedJob = await publishJobStatusSync({
          db,
          storage: options.storage || null,
          defaultBucketName: options.bucketName || null,
          publishJobId: req.params.publishJobId,
        });

        if (refreshedJob?.publishJobId) {
          publishJob = {
            ...publishJob,
            serialized: refreshedJob,
            data: {
              ...publishJob.data,
              status: refreshedJob.status,
              statusMessage: refreshedJob.statusMessage,
              platformStatus: refreshedJob.platformStatus,
              platformPublishId: refreshedJob.platformPublishId,
              platformContainerId: refreshedJob.platformContainerId,
              platformPostId: refreshedJob.platformPostId,
              platformPermalink: refreshedJob.platformPermalink,
              lastError: refreshedJob.lastError,
            },
          };
        }
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
  buildPlatformConfigs,
};
