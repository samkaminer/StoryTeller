const path = require('path');
const fetch = require('node-fetch');
const {
  getEffectiveSocialAccountStatus,
  getOwnedSocialAccount,
  claimSocialPublishJobLease,
  getSocialPublishJob,
  updateSocialPublishJob,
} = require('../utils/social-store');
const { logSocialAudit } = require('../utils/social-audit');
const { executePlatformRequest } = require('../utils/social-http');
const {
  ensureUsableSocialAccessToken,
  handlePlatformReconnectSignal,
} = require('./social-token-service');

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v23.0';
const META_GRAPH_BASE_URL = 'https://graph.facebook.com';
const INSTAGRAM_REEL_MAX_BYTES = 300 * 1024 * 1024;
const INSTAGRAM_REEL_MIN_DURATION_SEC = 3;
const INSTAGRAM_REEL_MAX_DURATION_SEC = 15 * 60;

function isFinalStatus(status) {
  return status === 'completed' || status === 'failed';
}

function getFetchImpl(options) {
  return options.fetchImpl || fetch;
}

function getPollDelayMs(status) {
  if (status === 'processing') return 5000;
  return 15000;
}

function plusMs(ms) {
  return new Date(Date.now() + ms);
}

function createUiSafeError(code, message, retryable, extra = {}) {
  return {
    code,
    message,
    retryable: Boolean(retryable),
    ...extra,
  };
}

function getGraphVersion() {
  return process.env.META_GRAPH_API_VERSION || DEFAULT_GRAPH_VERSION;
}

function getGraphApiUrl(resourcePath) {
  const normalizedPath = String(resourcePath || '').replace(/^\/+/, '');
  return `${META_GRAPH_BASE_URL}/${getGraphVersion()}/${normalizedPath}`;
}

function parseGsUrl(gcsUrl, defaultBucketName) {
  if (!gcsUrl || typeof gcsUrl !== 'string' || !gcsUrl.startsWith('gs://')) {
    throw new Error('Invalid GCS path');
  }

  const withoutPrefix = gcsUrl.slice('gs://'.length);
  const slashIndex = withoutPrefix.indexOf('/');
  if (slashIndex === -1) {
    return {
      bucketName: defaultBucketName || withoutPrefix,
      filePath: '',
    };
  }

  return {
    bucketName: withoutPrefix.slice(0, slashIndex),
    filePath: withoutPrefix.slice(slashIndex + 1),
  };
}

function inferMimeType(filePathValue, fallbackContentType) {
  if (fallbackContentType && typeof fallbackContentType === 'string') {
    return fallbackContentType;
  }

  const extension = path.extname(filePathValue || '').toLowerCase();
  if (extension === '.mov') return 'video/quicktime';
  if (extension === '.webm') return 'video/webm';
  return 'video/mp4';
}

function buildFailurePatch(uiSafeError, extraPatch = {}) {
  return {
    status: 'failed',
    statusMessage: uiSafeError.message,
    completedAt: new Date(),
    processingLeaseOwner: null,
    processingLeaseExpiresAt: null,
    nextPollAt: null,
    lastError: uiSafeError,
    ...extraPatch,
  };
}

function mapMetaApiError(error, fallbackMessage) {
  const code = Number(error?.error?.code || error?.code || 0) || null;
  const errorSubcode = Number(error?.error?.error_subcode || error?.error_subcode || 0) || null;
  const message = error?.error?.message || error?.message || fallbackMessage || 'Instagram could not process this publish request.';

  if (code === 190 || code === 102) {
    return createUiSafeError(
      'instagram_reconnect_required',
      'Your Instagram connection has expired or is invalid. Reconnect Instagram and try again.',
      false,
      { platformCode: code, platformSubcode: errorSubcode }
    );
  }

  if ([4, 17, 32, 613].includes(code) || /rate limit/i.test(message)) {
    return createUiSafeError(
      'instagram_rate_limited',
      'Instagram rate-limited this request. Try again in a few minutes.',
      true,
      { platformCode: code, platformSubcode: errorSubcode }
    );
  }

  if (/Page Publishing Authorization|PPA/i.test(message)) {
    return createUiSafeError(
      'instagram_page_authorization_required',
      'Instagram publishing is blocked until the connected Facebook Page completes Page Publishing Authorization.',
      false,
      { platformCode: code, platformSubcode: errorSubcode }
    );
  }

  if (/two-factor authentication/i.test(message)) {
    return createUiSafeError(
      'instagram_two_factor_required',
      'Instagram publishing is blocked until the connected Facebook account completes two-factor authentication.',
      false,
      { platformCode: code, platformSubcode: errorSubcode }
    );
  }

  if (/content publishing limit|quota/i.test(message)) {
    return createUiSafeError(
      'instagram_publish_limit_reached',
      'Instagram says this account has reached its current publishing limit. Try again later.',
      false,
      { platformCode: code, platformSubcode: errorSubcode }
    );
  }

  if (/unsupported format|video format|video codec|aspect ratio|duration|file size/i.test(message)) {
    return createUiSafeError(
      'instagram_invalid_media',
      'Instagram rejected this Reel because the selected take does not meet its media requirements.',
      false,
      { platformCode: code, platformSubcode: errorSubcode }
    );
  }

  return createUiSafeError(
    'instagram_publish_failed',
    message,
    false,
    { platformCode: code, platformSubcode: errorSubcode }
  );
}

function mapLocalPublishError(error) {
  switch (error?.message) {
    case 'Storage is required for Instagram publishing':
    case 'Invalid GCS path':
      return createUiSafeError(
        'instagram_media_unavailable',
        'This take is not currently available for Instagram publishing. Re-render it and try again.',
        false
      );
    case 'Instagram Reels only support MP4 or MOV videos':
      return createUiSafeError(
        'instagram_invalid_format',
        'Instagram Reels currently require an MP4 or MOV export.',
        false
      );
    case 'Instagram Reels are limited to 300 MB':
      return createUiSafeError(
        'instagram_video_too_large',
        'This take exceeds Instagram’s current 300 MB Reel upload limit.',
        false
      );
    case 'Instagram Reels require a video duration of at least 3 seconds':
    case 'Instagram Reels cannot exceed 15 minutes':
      return createUiSafeError(
        'instagram_invalid_duration',
        error.message,
        false
      );
    case 'Take thumbnail is not available for Instagram cover image':
      return createUiSafeError(
        'instagram_cover_unavailable',
        'This take does not have a usable thumbnail for the Reel cover image.',
        false
      );
    default:
      return createUiSafeError(
        'instagram_publish_failed',
        'Instagram Reel publishing failed.',
        false
      );
  }
}

async function readMetaResponse(response) {
  const text = await response.text();
  let body = {};

  try {
    body = text ? JSON.parse(text) : {};
  } catch (_error) {
    body = { raw: text };
  }

  if (!response.ok || body?.error) {
    const uiSafeError = mapMetaApiError(
      body,
      `Instagram request failed with status ${response.status}`
    );
    const err = new Error(uiSafeError.message);
    err.httpStatus = response.status;
    err.platformCode = uiSafeError.platformCode || null;
    err.platformSubcode = uiSafeError.platformSubcode || null;
    err.retryAfter = response.headers?.get?.('retry-after') || null;
    err.uiSafeError = uiSafeError;
    err.responseBody = body;
    throw err;
  }

  return body;
}

async function getSignedGcsMedia(storage, defaultBucketName, gcsUrl) {
  if (!storage) {
    throw new Error('Storage is required for Instagram publishing');
  }

  const { bucketName, filePath } = parseGsUrl(gcsUrl, defaultBucketName);
  const file = storage.bucket(bucketName).file(filePath);
  const [metadata = {}] = await file.getMetadata();
  const [signedUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + (24 * 60 * 60 * 1000),
  });

  return {
    bucketName,
    filePath,
    signedUrl,
    fileSizeBytes: Number(metadata.size || 0) || 0,
    mimeType: inferMimeType(filePath, metadata.contentType),
    metadata,
  };
}

function validateInstagramVideoSource(videoSource, publishJob) {
  if (!videoSource.signedUrl) {
    throw new Error('Invalid GCS path');
  }

  if (!/^video\/(mp4|quicktime)$/.test(videoSource.mimeType)) {
    throw new Error('Instagram Reels only support MP4 or MOV videos');
  }

  if (videoSource.fileSizeBytes > INSTAGRAM_REEL_MAX_BYTES) {
    throw new Error('Instagram Reels are limited to 300 MB');
  }

  const durationSec = Number(
    publishJob.data.mediaSnapshot?.durationSec ||
    videoSource.metadata?.metadata?.durationSec ||
    videoSource.metadata?.durationSec ||
    0
  );
  if (durationSec > 0 && durationSec < INSTAGRAM_REEL_MIN_DURATION_SEC) {
    throw new Error('Instagram Reels require a video duration of at least 3 seconds');
  }
  if (durationSec > INSTAGRAM_REEL_MAX_DURATION_SEC) {
    throw new Error('Instagram Reels cannot exceed 15 minutes');
  }
}

async function loadPublishJobContext(db, publishJobId) {
  const publishJob = await getSocialPublishJob(db, publishJobId);
  if (!publishJob) return null;

  const socialAccount = await getOwnedSocialAccount(
    db,
    publishJob.data.userId,
    publishJob.data.socialAccountId
  );

  return {
    publishJob,
    socialAccount,
  };
}

async function markPublishJobFailed(db, publishJob, uiSafeError, eventType, extraPatch = {}) {
  await updateSocialPublishJob(db, publishJob.doc.id, buildFailurePatch(uiSafeError, extraPatch), {
    type: eventType || 'publish_failed',
    status: 'failed',
    message: uiSafeError.message,
    platformCode: uiSafeError.platformCode || uiSafeError.code || null,
    httpStatus: uiSafeError.httpStatus || 0,
    attempt: publishJob.data.attemptCount || 0,
  });

  return getSocialPublishJob(db, publishJob.doc.id);
}

async function createInstagramReelContainer(fetchImpl, accessToken, igUserId, payload) {
  return executePlatformRequest(async () => {
    const response = await fetchImpl(getGraphApiUrl(`${igUserId}/media`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(payload),
    });

    return readMetaResponse(response);
  }, {
    audit: {
      platform: 'instagram',
      message: 'Create Instagram Reel container',
    },
  });
}

async function publishInstagramContainer(fetchImpl, accessToken, igUserId, creationId) {
  return executePlatformRequest(async () => {
    const response = await fetchImpl(getGraphApiUrl(`${igUserId}/media_publish`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        creation_id: creationId,
      }),
    });

    return readMetaResponse(response);
  }, {
    audit: {
      platform: 'instagram',
      message: 'Publish Instagram Reel container',
    },
  });
}

async function fetchInstagramContainerStatus(fetchImpl, accessToken, containerId) {
  const url = new URL(getGraphApiUrl(containerId));
  url.searchParams.set('fields', 'status_code,status');
  return executePlatformRequest(async () => {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return readMetaResponse(response);
  }, {
    audit: {
      platform: 'instagram',
      message: 'Fetch Instagram container status',
    },
  });
}

async function processInstagramReelPublishJob(options) {
  const { db, storage, defaultBucketName, publishJobId } = options;
  const fetchImpl = getFetchImpl(options);
  const context = await loadPublishJobContext(db, publishJobId);
  if (!context) return null;

  let { publishJob, socialAccount } = context;
  if (publishJob.data.platform !== 'instagram' || publishJob.data.publishMode !== 'instagram_reel') {
    return publishJob.serialized;
  }

  if (isFinalStatus(publishJob.data.status)) {
    return publishJob.serialized;
  }

  if (!socialAccount || getEffectiveSocialAccountStatus(socialAccount.data) !== 'active') {
    const failed = await markPublishJobFailed(
      db,
      publishJob,
      createUiSafeError(
        'instagram_reconnect_required',
        'Your Instagram connection is no longer active. Reconnect Instagram and try again.',
        false
      ),
      'publish_failed_precheck'
    );
    return failed?.serialized || null;
  }

  const igUserId = socialAccount.data.meta?.igUserId || socialAccount.data.platformAccountId || null;
  if (!igUserId) {
    const failed = await markPublishJobFailed(
      db,
      publishJob,
      createUiSafeError(
        'instagram_reconnect_required',
        'Your Instagram connection is missing the professional account identifier. Reconnect Instagram and try again.',
        false
      ),
      'publish_failed_precheck'
    );
    return failed?.serialized || null;
  }

  const leaseClaim = await claimSocialPublishJobLease(db, publishJobId);
  if (!leaseClaim) return null;
  if (!leaseClaim.claimed) {
    return leaseClaim.serialized;
  }

  publishJob = {
    ...publishJob,
    data: leaseClaim.data,
    serialized: leaseClaim.serialized,
  };

  try {
    const accessToken = await ensureUsableSocialAccessToken({
      ...options,
      db,
      socialAccount,
      platform: 'instagram',
    });

    await updateSocialPublishJob(db, publishJobId, {
      status: 'processing',
      statusMessage: 'Preparing Instagram Reel publish…',
      startedAt: publishJob.data.startedAt || new Date(),
      attemptCount: (publishJob.data.attemptCount || 0) + 1,
      lastError: null,
    }, {
      type: 'publish_started',
      status: 'processing',
      message: 'Preparing Instagram Reel publish',
      attempt: (publishJob.data.attemptCount || 0) + 1,
    });

    const videoSource = await getSignedGcsMedia(
      storage,
      defaultBucketName,
      publishJob.data.mediaSnapshot?.videoGcsUrl
    );
    validateInstagramVideoSource(videoSource, publishJob);

    const platformOptions = publishJob.data.platformOptions || {};
    const containerPayload = {
      media_type: 'REELS',
      video_url: videoSource.signedUrl,
    };

    if (publishJob.data.caption) {
      containerPayload.caption = publishJob.data.caption;
    }
    if (typeof platformOptions.shareToFeed === 'boolean') {
      containerPayload.share_to_feed = platformOptions.shareToFeed;
    }
    if (Number.isFinite(platformOptions.thumbOffsetMs)) {
      containerPayload.thumb_offset = String(Math.trunc(platformOptions.thumbOffsetMs));
    } else if (platformOptions.useTakeThumbnailAsCover) {
      if (!publishJob.data.mediaSnapshot?.thumbnailGcsUrl) {
        throw new Error('Take thumbnail is not available for Instagram cover image');
      }
      const coverSource = await getSignedGcsMedia(
        storage,
        defaultBucketName,
        publishJob.data.mediaSnapshot.thumbnailGcsUrl
      );
      containerPayload.cover_url = coverSource.signedUrl;
    }

    const initResult = await createInstagramReelContainer(
      fetchImpl,
      accessToken,
      igUserId,
      containerPayload
    );
    const containerId = initResult?.id || null;
    if (!containerId) {
      throw Object.assign(new Error('Instagram did not return a media container ID'), {
        uiSafeError: createUiSafeError(
          'instagram_missing_container',
          'Instagram did not return a media container for this Reel publish request.',
          true
        ),
      });
    }

    await updateSocialPublishJob(db, publishJobId, {
      status: 'processing',
      statusMessage: 'Instagram is preparing the Reel media container…',
      platformContainerId: containerId,
      platformStatus: 'IN_PROGRESS',
      processingLeaseOwner: null,
      processingLeaseExpiresAt: null,
      mediaSnapshot: {
        ...publishJob.data.mediaSnapshot,
        mimeType: videoSource.mimeType,
        fileSizeBytes: videoSource.fileSizeBytes,
      },
      lastPolledAt: new Date(),
      nextPollAt: plusMs(getPollDelayMs('processing')),
    }, {
      type: 'publish_initialized',
      status: 'processing',
      message: 'Instagram Reel container created',
      attempt: (publishJob.data.attemptCount || 0) + 1,
    });

    return refreshInstagramPublishJobStatus({
      ...options,
      publishJobId,
      force: true,
    });
  } catch (error) {
    if (error?.uiSafeError?.code === 'instagram_reconnect_required') {
      const failed = await markPublishJobFailed(db, publishJob, error.uiSafeError, 'publish_failed_precheck');
      return failed?.serialized || null;
    }
    const uiSafeError = error.uiSafeError || mapLocalPublishError(error);
    const failed = await markPublishJobFailed(db, publishJob, {
      ...uiSafeError,
      platformCode: error.platformCode || uiSafeError.platformCode || null,
      httpStatus: error.httpStatus || uiSafeError.httpStatus || 0,
    }, 'publish_failed');
    return failed?.serialized || null;
  }
}

async function refreshInstagramPublishJobStatus(options) {
  const { db, publishJobId, force = false } = options;
  const fetchImpl = getFetchImpl(options);
  const context = await loadPublishJobContext(db, publishJobId);
  if (!context) return null;

  const { publishJob, socialAccount } = context;
  if (publishJob.data.platform !== 'instagram' || publishJob.data.publishMode !== 'instagram_reel') {
    return publishJob.serialized;
  }

  if (isFinalStatus(publishJob.data.status) || !publishJob.data.platformContainerId) {
    return publishJob.serialized;
  }

  const nextPollAtMs = publishJob.data.nextPollAt?.toDate?.()?.getTime?.() || new Date(publishJob.data.nextPollAt || 0).getTime() || 0;
  if (!force && nextPollAtMs && nextPollAtMs > Date.now()) {
    return publishJob.serialized;
  }

  if (!socialAccount || getEffectiveSocialAccountStatus(socialAccount.data) !== 'active') {
    const failed = await markPublishJobFailed(
      db,
      publishJob,
      createUiSafeError(
        'instagram_reconnect_required',
        'Your Instagram connection is no longer active. Reconnect Instagram and try again.',
        false
      ),
      'status_refresh_failed'
    );
    return failed?.serialized || null;
  }

  const igUserId = socialAccount.data.meta?.igUserId || socialAccount.data.platformAccountId || null;
  if (!igUserId) {
    const failed = await markPublishJobFailed(
      db,
      publishJob,
      createUiSafeError(
        'instagram_reconnect_required',
        'Your Instagram connection is missing the professional account identifier. Reconnect Instagram and try again.',
        false
      ),
      'status_refresh_failed'
    );
    return failed?.serialized || null;
  }

  try {
    const accessToken = await ensureUsableSocialAccessToken({
      ...options,
      db,
      socialAccount,
      platform: 'instagram',
    });
    const statusResult = await fetchInstagramContainerStatus(
      fetchImpl,
      accessToken,
      publishJob.data.platformContainerId
    );
    const platformStatus = statusResult.status_code || null;
    const patch = {
      platformStatus,
      lastPolledAt: new Date(),
      lastError: null,
    };
    let event = null;

    if (platformStatus === 'ERROR') {
      const failed = await markPublishJobFailed(
        db,
        publishJob,
        mapMetaApiError(
          { error: { message: `Instagram container error ${statusResult.status || 'unknown'}` } },
          'Instagram could not finish preparing this Reel.'
        ),
        'publish_status_failed',
        {
          platformStatus,
        }
      );
      return failed?.serialized || null;
    }

    if (platformStatus === 'EXPIRED') {
      const failed = await markPublishJobFailed(
        db,
        publishJob,
        createUiSafeError(
          'instagram_container_expired',
          'Instagram did not publish this Reel before the media container expired. Start a new publish attempt.',
          false
        ),
        'publish_status_failed',
        {
          platformStatus,
        }
      );
      return failed?.serialized || null;
    }

    if (platformStatus === 'FINISHED' && !publishJob.data.platformPostId) {
      const publishResult = await publishInstagramContainer(
        fetchImpl,
        accessToken,
        igUserId,
        publishJob.data.platformContainerId
      );

      patch.status = 'completed';
      patch.statusMessage = 'Instagram Reel published.';
      patch.platformStatus = 'PUBLISHED';
      patch.platformPostId = publishResult?.id || null;
      patch.completedAt = new Date();
      patch.nextPollAt = null;
      event = {
        type: 'publish_completed',
        status: 'completed',
        message: 'Instagram Reel published successfully',
      };
    } else if (platformStatus === 'PUBLISHED') {
      patch.status = 'completed';
      patch.statusMessage = 'Instagram Reel published.';
      patch.completedAt = new Date();
      patch.nextPollAt = null;
      event = {
        type: 'publish_completed',
        status: 'completed',
        message: 'Instagram reported the Reel as published',
      };
    } else {
      patch.status = 'processing';
      patch.statusMessage = 'Instagram is still preparing the Reel…';
      patch.nextPollAt = plusMs(getPollDelayMs('processing'));
      event = {
        type: 'publish_status_updated',
        status: 'processing',
        message: `Instagram status: ${platformStatus || 'IN_PROGRESS'}`,
      };
    }

    await updateSocialPublishJob(db, publishJobId, patch, event);
    const refreshed = await getSocialPublishJob(db, publishJobId);
    return refreshed?.serialized || null;
  } catch (error) {
    const uiSafeError = error.uiSafeError || createUiSafeError(
      'instagram_status_refresh_failed',
      'StoryTeller could not refresh Instagram publish status right now.',
      true
    );

    if (uiSafeError.code === 'instagram_reconnect_required' || uiSafeError.retryable === false) {
      if (uiSafeError.code === 'instagram_reconnect_required' && socialAccount) {
        try {
          await handlePlatformReconnectSignal({
            db,
            socialAccount,
            platform: 'instagram',
            message: uiSafeError.message,
          });
        } catch (_ignored) {}
      }
      const failed = await markPublishJobFailed(
        db,
        publishJob,
        {
          ...uiSafeError,
          platformCode: error.platformCode || null,
          httpStatus: error.httpStatus || 0,
        },
        'status_refresh_failed'
      );
      return failed?.serialized || null;
    }

    await updateSocialPublishJob(db, publishJobId, {
      statusMessage: 'Instagram status refresh is temporarily unavailable. Poll again shortly.',
      nextPollAt: plusMs(getPollDelayMs('processing')),
      lastError: {
        ...uiSafeError,
        platformCode: error.platformCode || null,
        httpStatus: error.httpStatus || 0,
      },
    }, {
      type: 'status_refresh_deferred',
      status: publishJob.data.status || 'processing',
      message: uiSafeError.message,
      platformCode: error.platformCode || null,
      httpStatus: error.httpStatus || 0,
      attempt: publishJob.data.attemptCount || 0,
    });

    const refreshed = await getSocialPublishJob(db, publishJobId);
    return refreshed?.serialized || null;
  }
}

async function syncInstagramPublishJob(options) {
  const { db, publishJobId } = options;
  const publishJob = await getSocialPublishJob(db, publishJobId);
  if (!publishJob) return null;

  if (publishJob.data.platform !== 'instagram' || publishJob.data.publishMode !== 'instagram_reel') {
    return publishJob.serialized;
  }

  if (isFinalStatus(publishJob.data.status)) {
    return publishJob.serialized;
  }

  if (!publishJob.data.platformContainerId) {
    return processInstagramReelPublishJob(options);
  }

  return refreshInstagramPublishJobStatus(options);
}

function scheduleInstagramPublishJob(options) {
  setImmediate(() => {
    syncInstagramPublishJob(options).catch((error) => {
      logSocialAudit('publish_job_crashed', {
        level: 'error',
        platform: 'instagram',
        publishJobId: options.publishJobId,
        error,
      });
      console.error('[InstagramPublishJob]', error.message);
    });
  });
}

module.exports = {
  processInstagramReelPublishJob,
  refreshInstagramPublishJobStatus,
  scheduleInstagramPublishJob,
  syncInstagramPublishJob,
  _private: {
    createUiSafeError,
    getSignedGcsMedia,
    inferMimeType,
    mapLocalPublishError,
    mapMetaApiError,
    parseGsUrl,
    readMetaResponse,
    validateInstagramVideoSource,
  },
};
