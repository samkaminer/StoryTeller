const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
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

const TIKTOK_UPLOAD_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const TIKTOK_STATUS_FETCH_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const FIVE_MB = 5 * 1024 * 1024;
const SIXTY_FOUR_MB = 64 * 1024 * 1024;
const ONE_HUNDRED_TWENTY_EIGHT_MB = 128 * 1024 * 1024;
const TIKTOK_MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;

function isFinalStatus(status) {
  return status === 'completed' || status === 'failed';
}

function getFetchImpl(options) {
  return options.fetchImpl || fetch;
}

function getPollDelayMs(status) {
  if (status === 'awaiting_user_action') return 15000;
  return 5000;
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

function mapTikTokApiError(errorCode, fallbackMessage) {
  switch (errorCode) {
    case 'access_token_invalid':
    case 'scope_not_authorized':
      return createUiSafeError(
        'tiktok_reconnect_required',
        'Your TikTok connection is missing permissions or has expired. Reconnect TikTok and try again.',
        false
      );
    case 'spam_risk_too_many_pending_share':
      return createUiSafeError(
        'tiktok_pending_share_limit',
        'TikTok says this account already has too many pending draft uploads. Finish or clear drafts in TikTok, then try again.',
        false
      );
    case 'spam_risk_user_banned_from_posting':
      return createUiSafeError(
        'tiktok_posting_restricted',
        'TikTok says this account cannot upload new drafts right now.',
        false
      );
    case 'rate_limit_exceeded':
      return createUiSafeError(
        'tiktok_rate_limited',
        'TikTok rate-limited this request. Try again in a few minutes.',
        true
      );
    case 'url_ownership_unverified':
      return createUiSafeError(
        'tiktok_url_unverified',
        'TikTok rejected the media source configuration. Contact support and try again later.',
        false
      );
    case 'invalid_publish_id':
      return createUiSafeError(
        'tiktok_publish_not_found',
        'TikTok could not find this upload. Start a new draft upload and try again.',
        false
      );
    case 'token_not_authorized_for_specified_publish_id':
      return createUiSafeError(
        'tiktok_publish_not_authorized',
        'Your TikTok connection can no longer access this draft upload. Reconnect TikTok and try again.',
        false
      );
    case 'internal_error':
      return createUiSafeError(
        'tiktok_internal_error',
        'TikTok had a temporary server error while processing this draft. Try again shortly.',
        true
      );
    default:
      return createUiSafeError(
        'tiktok_publish_failed',
        fallbackMessage || 'TikTok could not process this publish request.',
        false
      );
  }
}

function mapTikTokFailReason(failReason) {
  switch (failReason) {
    case 'file_format_check_failed':
      return createUiSafeError(
        'tiktok_invalid_format',
        'TikTok rejected this video format. Try exporting an MP4, MOV, or WebM file.',
        false
      );
    case 'duration_check_failed':
      return createUiSafeError(
        'tiktok_invalid_duration',
        'TikTok rejected this take because its duration is outside TikTok upload limits for this account.',
        false
      );
    case 'frame_rate_check_failed':
      return createUiSafeError(
        'tiktok_invalid_frame_rate',
        'TikTok rejected this take because the frame rate is unsupported.',
        false
      );
    case 'picture_size_check_failed':
      return createUiSafeError(
        'tiktok_invalid_dimensions',
        'TikTok rejected this take because its dimensions are unsupported.',
        false
      );
    case 'video_pull_failed':
      return createUiSafeError(
        'tiktok_media_transfer_failed',
        'TikTok could not finish receiving the video file. Try again.',
        true
      );
    case 'spam_risk_text':
      return createUiSafeError(
        'tiktok_caption_rejected',
        'TikTok rejected the draft because of caption or text risk checks.',
        false
      );
    case 'internal':
      return createUiSafeError(
        'tiktok_internal_error',
        'TikTok had a temporary server error while processing this draft. Try again shortly.',
        true
      );
    default:
      return createUiSafeError(
        'tiktok_publish_failed',
        'TikTok reported that this draft upload failed.',
        false
      );
  }
}

function mapLocalPublishError(error) {
  switch (error?.message) {
    case 'Storage is required for TikTok publishing':
    case 'Invalid GCS path':
      return createUiSafeError(
        'tiktok_media_unavailable',
        'This take is not currently available for TikTok publishing. Re-render it and try again.',
        false
      );
    case 'Video size must be greater than zero':
      return createUiSafeError(
        'tiktok_invalid_media',
        'This take does not contain a usable video file for TikTok publishing.',
        false
      );
    case 'Video exceeds TikTok maximum upload size':
      return createUiSafeError(
        'tiktok_video_too_large',
        'This take exceeds TikTok’s current 4 GB upload limit.',
        false
      );
    case 'Unable to calculate a valid TikTok upload chunk plan':
    case 'Calculated an invalid TikTok upload chunk size':
      return createUiSafeError(
        'tiktok_invalid_media',
        'This take could not be prepared for TikTok upload. Re-export it and try again.',
        false
      );
    default:
      return createUiSafeError(
        'tiktok_publish_failed',
        'TikTok draft upload failed.',
        false
      );
  }
}

async function readTikTokResponse(response) {
  const text = await response.text();
  let body = {};

  try {
    body = text ? JSON.parse(text) : {};
  } catch (_error) {
    body = { raw: text };
  }

  const errorCode = body?.error?.code;
  const errorMessage = body?.error?.message || body?.message || null;
  if (!response.ok || (errorCode && errorCode !== 'ok')) {
    const uiSafeError = mapTikTokApiError(
      errorCode,
      errorMessage || `TikTok request failed with status ${response.status}`
    );
    const err = new Error(uiSafeError.message);
    err.httpStatus = response.status;
    err.platformCode = errorCode || null;
    err.retryAfter = response.headers?.get?.('retry-after') || null;
    err.uiSafeError = uiSafeError;
    err.responseBody = body;
    throw err;
  }

  return body;
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
  if (fallbackContentType && /^video\/(mp4|quicktime|webm)$/.test(fallbackContentType)) {
    return fallbackContentType;
  }

  const extension = path.extname(filePathValue || '').toLowerCase();
  if (extension === '.mov') return 'video/quicktime';
  if (extension === '.webm') return 'video/webm';
  return 'video/mp4';
}

function buildChunkPlan(totalBytes) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new Error('Video size must be greater than zero');
  }

  if (totalBytes > TIKTOK_MAX_VIDEO_BYTES) {
    throw new Error('Video exceeds TikTok maximum upload size');
  }

  if (totalBytes <= FIVE_MB) {
    return {
      chunkSize: totalBytes,
      totalChunkCount: 1,
    };
  }

  const totalChunkCount = Math.ceil(totalBytes / SIXTY_FOUR_MB);
  const chunkSize = Math.ceil(totalBytes / totalChunkCount);
  if (chunkSize < FIVE_MB || chunkSize > SIXTY_FOUR_MB || totalChunkCount > 1000) {
    throw new Error('Unable to calculate a valid TikTok upload chunk plan');
  }

  return {
    chunkSize,
    totalChunkCount,
  };
}

async function downloadFileFromGcs(storage, defaultBucketName, gcsUrl) {
  if (!storage) {
    throw new Error('Storage is required for TikTok publishing');
  }

  const { bucketName, filePath } = parseGsUrl(gcsUrl, defaultBucketName);
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(filePath);
  const [metadata = {}] = await file.getMetadata();
  const tempPath = path.join(os.tmpdir(), `storyteller-tiktok-${Date.now()}-${path.basename(filePath || 'video')}`);

  try {
    if (typeof file.download === 'function') {
      await file.download({ destination: tempPath });
    } else {
      await pipeline(file.createReadStream(), fs.createWriteStream(tempPath));
    }

    const stats = await fsPromises.stat(tempPath);
    return {
      tempPath,
      bucketName,
      filePath,
      fileSizeBytes: stats.size,
      mimeType: inferMimeType(filePath, metadata.contentType),
      cleanup: async () => {
        await fsPromises.unlink(tempPath).catch(() => {});
      },
    };
  } catch (error) {
    await fsPromises.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function initializeTikTokUpload(fetchImpl, accessToken, uploadInfo) {
  const body = await executePlatformRequest(async () => {
    const response = await fetchImpl(TIKTOK_UPLOAD_INIT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: uploadInfo.videoSize,
          chunk_size: uploadInfo.chunkSize,
          total_chunk_count: uploadInfo.totalChunkCount,
        },
      }),
    });

    return readTikTokResponse(response);
  }, {
    audit: {
      platform: 'tiktok',
      message: 'Initialize TikTok upload',
    },
  });
  return {
    publishId: body?.data?.publish_id || null,
    uploadUrl: body?.data?.upload_url || null,
  };
}

async function uploadFileToTikTok(fetchImpl, uploadUrl, localPath, mimeType, totalBytes, chunkPlan) {
  const handle = await fsPromises.open(localPath, 'r');

  try {
    for (let chunkIndex = 0; chunkIndex < chunkPlan.totalChunkCount; chunkIndex += 1) {
      const start = chunkIndex * chunkPlan.chunkSize;
      const bytesRemaining = totalBytes - start;
      const chunkLength = Math.min(chunkPlan.chunkSize, bytesRemaining);
      if (chunkLength <= 0 || chunkLength > ONE_HUNDRED_TWENTY_EIGHT_MB) {
        throw new Error('Calculated an invalid TikTok upload chunk size');
      }

      const buffer = Buffer.alloc(chunkLength);
      const { bytesRead } = await handle.read(buffer, 0, chunkLength, start);
      const requestBody = bytesRead === chunkLength ? buffer : buffer.subarray(0, bytesRead);
      const end = start + bytesRead - 1;

      await executePlatformRequest(async () => {
        const response = await fetchImpl(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(bytesRead),
            'Content-Range': `bytes ${start}-${end}/${totalBytes}`,
          },
          body: requestBody,
        });

        if (![201, 206].includes(response.status)) {
          const errorText = await response.text().catch(() => '');
          const err = new Error('TikTok did not accept the uploaded video chunk');
          err.httpStatus = response.status;
          err.platformCode = 'upload_chunk_failed';
          err.retryAfter = response.headers?.get?.('retry-after') || null;
          err.uiSafeError = mapTikTokApiError(
            response.status === 429 ? 'rate_limit_exceeded' : 'internal_error',
            errorText || 'TikTok rejected the uploaded video chunk.'
          );
          throw err;
        }
      }, {
        audit: {
          platform: 'tiktok',
          message: 'Upload TikTok video chunk',
          attempt: chunkIndex + 1,
        },
      });
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function fetchTikTokPublishStatus(fetchImpl, accessToken, publishId) {
  const body = await executePlatformRequest(async () => {
    const response = await fetchImpl(TIKTOK_STATUS_FETCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ publish_id: publishId }),
    });

    return readTikTokResponse(response);
  }, {
    audit: {
      platform: 'tiktok',
      message: 'Fetch TikTok publish status',
    },
  });
  return body?.data || {};
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

async function processTikTokDraftPublishJob(options) {
  const { db, storage, defaultBucketName, publishJobId } = options;
  const fetchImpl = getFetchImpl(options);
  const context = await loadPublishJobContext(db, publishJobId);
  if (!context) return null;

  let { publishJob, socialAccount } = context;
  if (publishJob.data.platform !== 'tiktok' || publishJob.data.publishMode !== 'tiktok_draft') {
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
        'tiktok_reconnect_required',
        'Your TikTok connection is no longer active. Reconnect TikTok and try again.',
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

  let downloadResult = null;

  try {
    const accessToken = await ensureUsableSocialAccessToken({
      ...options,
      db,
      socialAccount,
      platform: 'tiktok',
    });

    await updateSocialPublishJob(db, publishJobId, {
      status: 'processing',
      statusMessage: 'Preparing TikTok draft upload…',
      startedAt: publishJob.data.startedAt || new Date(),
      attemptCount: (publishJob.data.attemptCount || 0) + 1,
      lastError: null,
    }, {
      type: 'publish_started',
      status: 'processing',
      message: 'Preparing TikTok draft upload',
      attempt: (publishJob.data.attemptCount || 0) + 1,
    });

    downloadResult = await downloadFileFromGcs(
      storage,
      defaultBucketName,
      publishJob.data.mediaSnapshot?.videoGcsUrl
    );

    const chunkPlan = buildChunkPlan(downloadResult.fileSizeBytes);
    const initResult = await initializeTikTokUpload(fetchImpl, accessToken, {
      videoSize: downloadResult.fileSizeBytes,
      chunkSize: chunkPlan.chunkSize,
      totalChunkCount: chunkPlan.totalChunkCount,
    });

    if (!initResult.publishId || !initResult.uploadUrl) {
      throw Object.assign(new Error('TikTok did not return upload details'), {
        uiSafeError: createUiSafeError(
          'tiktok_missing_upload_details',
          'TikTok did not return upload details for this draft request.',
          true
        ),
      });
    }

    await updateSocialPublishJob(db, publishJobId, {
      status: 'uploading',
      statusMessage: 'Uploading video to TikTok…',
      platformPublishId: initResult.publishId,
      platformStatus: 'INITIALIZED',
      mediaSnapshot: {
        ...publishJob.data.mediaSnapshot,
        mimeType: downloadResult.mimeType,
        fileSizeBytes: downloadResult.fileSizeBytes,
      },
    }, {
      type: 'publish_initialized',
      status: 'uploading',
      message: 'TikTok draft upload initialized',
      attempt: (publishJob.data.attemptCount || 0) + 1,
    });

    await uploadFileToTikTok(
      fetchImpl,
      initResult.uploadUrl,
      downloadResult.tempPath,
      downloadResult.mimeType,
      downloadResult.fileSizeBytes,
      chunkPlan
    );

    await updateSocialPublishJob(db, publishJobId, {
      status: 'processing',
      statusMessage: 'TikTok is processing the uploaded draft…',
      platformStatus: 'PROCESSING_UPLOAD',
      processingLeaseOwner: null,
      processingLeaseExpiresAt: null,
      lastPolledAt: new Date(),
      nextPollAt: plusMs(getPollDelayMs('processing')),
    }, {
      type: 'upload_completed',
      status: 'processing',
      message: 'TikTok received the uploaded video',
      attempt: (publishJob.data.attemptCount || 0) + 1,
    });

    return refreshTikTokPublishJobStatus({
      ...options,
      publishJobId,
      force: true,
    });
  } catch (error) {
    if (error?.uiSafeError?.code === 'tiktok_reconnect_required') {
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
  } finally {
    if (downloadResult?.cleanup) {
      await downloadResult.cleanup();
    }
  }
}

async function refreshTikTokPublishJobStatus(options) {
  const { db, publishJobId, force = false } = options;
  const fetchImpl = getFetchImpl(options);
  const context = await loadPublishJobContext(db, publishJobId);
  if (!context) return null;

  const { publishJob, socialAccount } = context;
  if (publishJob.data.platform !== 'tiktok' || publishJob.data.publishMode !== 'tiktok_draft') {
    return publishJob.serialized;
  }

  if (isFinalStatus(publishJob.data.status) || !publishJob.data.platformPublishId) {
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
        'tiktok_reconnect_required',
        'Your TikTok connection is no longer active. Reconnect TikTok and try again.',
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
      platform: 'tiktok',
    });
    const statusResult = await fetchTikTokPublishStatus(fetchImpl, accessToken, publishJob.data.platformPublishId);
    const platformStatus = statusResult.status || null;
    const patch = {
      platformStatus,
      lastPolledAt: new Date(),
      lastError: null,
    };
    let event = null;

    if (platformStatus === 'FAILED') {
      const uiSafeError = mapTikTokFailReason(statusResult.fail_reason);
      const failed = await markPublishJobFailed(
        db,
        publishJob,
        {
          ...uiSafeError,
          failReason: statusResult.fail_reason || null,
        },
        'publish_status_failed',
        {
          platformStatus,
        }
      );
      return failed?.serialized || null;
    }

    if (platformStatus === 'SEND_TO_USER_INBOX') {
      patch.status = 'awaiting_user_action';
      patch.statusMessage = 'Draft delivered to TikTok. Open TikTok to review, edit, and post it.';
      patch.nextPollAt = plusMs(getPollDelayMs('awaiting_user_action'));
      event = {
        type: 'publish_status_updated',
        status: 'awaiting_user_action',
        message: 'TikTok draft delivered to the creator inbox',
      };
    } else if (platformStatus === 'PUBLISH_COMPLETE') {
      patch.status = 'completed';
      patch.statusMessage = 'The TikTok draft was posted from TikTok.';
      patch.completedAt = new Date();
      patch.nextPollAt = null;
      patch.platformPostId = Array.isArray(statusResult.publicaly_available_post_id)
        ? String(statusResult.publicaly_available_post_id[0] || '')
        : null;
      event = {
        type: 'publish_completed',
        status: 'completed',
        message: 'TikTok reported the draft workflow completed',
      };
    } else {
      patch.status = 'processing';
      patch.statusMessage = 'TikTok is still processing the uploaded draft…';
      patch.nextPollAt = plusMs(getPollDelayMs('processing'));
      event = {
        type: 'publish_status_updated',
        status: 'processing',
        message: `TikTok status: ${platformStatus || 'PROCESSING'}`,
      };
    }

    await updateSocialPublishJob(db, publishJobId, patch, event);
    const refreshed = await getSocialPublishJob(db, publishJobId);
    return refreshed?.serialized || null;
  } catch (error) {
    const uiSafeError = error.uiSafeError || createUiSafeError(
      'tiktok_status_refresh_failed',
      'StoryTeller could not refresh TikTok publish status right now.',
      true
    );

    if (uiSafeError.code === 'tiktok_reconnect_required' || uiSafeError.retryable === false) {
      if (socialAccount) {
        if (uiSafeError.code === 'tiktok_reconnect_required') {
          try {
            await handlePlatformReconnectSignal({
              db,
              socialAccount,
              platform: 'tiktok',
              message: uiSafeError.message,
            });
          } catch (_ignored) {}
        }
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
      statusMessage: 'TikTok status refresh is temporarily unavailable. Poll again shortly.',
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

async function syncTikTokPublishJob(options) {
  const { db, publishJobId } = options;
  const publishJob = await getSocialPublishJob(db, publishJobId);
  if (!publishJob) return null;

  if (publishJob.data.platform !== 'tiktok' || publishJob.data.publishMode !== 'tiktok_draft') {
    return publishJob.serialized;
  }

  if (isFinalStatus(publishJob.data.status)) {
    return publishJob.serialized;
  }

  if (!publishJob.data.platformPublishId) {
    return processTikTokDraftPublishJob(options);
  }

  return refreshTikTokPublishJobStatus(options);
}

function scheduleTikTokPublishJob(options) {
  setImmediate(() => {
    syncTikTokPublishJob(options).catch((error) => {
      logSocialAudit('publish_job_crashed', {
        level: 'error',
        platform: 'tiktok',
        publishJobId: options.publishJobId,
        error,
      });
      console.error('[TikTokPublishJob]', error.message);
    });
  });
}

module.exports = {
  processTikTokDraftPublishJob,
  refreshTikTokPublishJobStatus,
  scheduleTikTokPublishJob,
  syncTikTokPublishJob,
  _private: {
    buildChunkPlan,
    createUiSafeError,
    downloadFileFromGcs,
    inferMimeType,
    mapTikTokApiError,
    mapTikTokFailReason,
    mapLocalPublishError,
    parseGsUrl,
    readTikTokResponse,
  },
};
