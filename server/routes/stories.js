const express = require('express');
const admin = require('firebase-admin');
const { requireAuth } = require('../middleware/auth');
const rateLimiters = require('../middleware/rateLimiter');
const {
  gcsSignedUrl,
  loadStoryDoc,
  toIsoString,
  listStoryTakes,
  buildLegacyStoryTake,
  resolveStoryTake,
} = require('../utils/story-takes');
const {
  getEffectiveSocialAccountStatus,
  getOwnedSocialAccount,
  createSocialPublishJob,
  listOwnedPublishJobs,
} = require('../utils/social-store');
const { logSocialAudit } = require('../utils/social-audit');
const { scheduleSocialPublishJob } = require('../services/social-publish-runner');

const REQUIRED_PUBLISH_SCOPES = {
  tiktok: ['video.upload'],
  instagram: ['instagram_basic', 'instagram_content_publish'],
};

function validatePublishRequest(platform, body = {}) {
  if (!body.socialAccountId || typeof body.socialAccountId !== 'string') {
    return 'socialAccountId is required';
  }

  if (body.caption !== undefined && typeof body.caption !== 'string') {
    return 'caption must be a string';
  }

  if (typeof body.caption === 'string' && body.caption.length > 2200) {
    return 'caption must be 2200 characters or fewer';
  }

  if (body.platformOptions !== undefined && (!body.platformOptions || typeof body.platformOptions !== 'object' || Array.isArray(body.platformOptions))) {
    return 'platformOptions must be an object';
  }

  const platformOptions = body.platformOptions || {};
  const optionKeys = Object.keys(platformOptions);
  if (platform === 'tiktok' && optionKeys.length > 0) {
    return 'TikTok draft publishing does not support platformOptions yet';
  }

  if (platform === 'instagram') {
    const supportedOptionKeys = new Set(['shareToFeed', 'thumbOffsetMs', 'useTakeThumbnailAsCover']);
    const unsupportedOption = optionKeys.find((key) => !supportedOptionKeys.has(key));
    if (unsupportedOption) {
      return `platformOptions.${unsupportedOption} is not supported for Instagram Reels`;
    }

    if (platformOptions.shareToFeed !== undefined && typeof platformOptions.shareToFeed !== 'boolean') {
      return 'platformOptions.shareToFeed must be a boolean';
    }

    if (
      platformOptions.thumbOffsetMs !== undefined &&
      (!Number.isInteger(platformOptions.thumbOffsetMs) || platformOptions.thumbOffsetMs < 0)
    ) {
      return 'platformOptions.thumbOffsetMs must be a non-negative integer';
    }

    if (
      platformOptions.useTakeThumbnailAsCover !== undefined &&
      typeof platformOptions.useTakeThumbnailAsCover !== 'boolean'
    ) {
      return 'platformOptions.useTakeThumbnailAsCover must be a boolean';
    }

    if (platformOptions.useTakeThumbnailAsCover && platformOptions.thumbOffsetMs !== undefined) {
      return 'Choose either platformOptions.useTakeThumbnailAsCover or platformOptions.thumbOffsetMs';
    }
  }

  return null;
}

function getMissingPublishScopes(platform, scopes = []) {
  const grantedScopes = Array.isArray(scopes) ? scopes : [];
  const requiredScopes = REQUIRED_PUBLISH_SCOPES[platform] || [];
  return requiredScopes.filter((scope) => !grantedScopes.includes(scope));
}

function createPublishHandler({ platform, publishMode, publishJobScheduler }) {
  return async (req, res) => {
    try {
      const db = admin.firestore();
      const { storyId, takeId } = req.params;
      const { socialAccountId, caption, platformOptions } = req.body || {};

      const validationError = validatePublishRequest(platform, req.body || {});
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      const loaded = await loadStoryDoc(db, storyId, req.user.uid);
      if (!loaded.doc) return res.status(loaded.status).json(loaded.body);

      const take = await resolveStoryTake(db, req.app.locals.storage || null, req.app.locals.bucketName || null, storyId, loaded.data, takeId);
      if (!take) {
        return res.status(404).json({ error: 'Take not found' });
      }

      if (!take.finalVideoGcs) {
        return res.status(409).json({ error: 'Take video is not ready for publishing' });
      }

      const account = await getOwnedSocialAccount(db, req.user.uid, socialAccountId);
      if (!account) {
        return res.status(404).json({ error: 'Social account not found' });
      }
      if (account.data.platform !== platform) {
        return res.status(400).json({ error: `Selected social account is not a ${platform} account` });
      }
      if (getEffectiveSocialAccountStatus(account.data) !== 'active') {
        return res.status(409).json({ error: 'Reconnect this account before publishing' });
      }

      const missingScopes = getMissingPublishScopes(platform, account.data.scopes);
      if (missingScopes.length > 0) {
        return res.status(409).json({
          error: 'Reconnect this account to restore required publishing permissions',
          missingScopes,
        });
      }

      const publishJob = await createSocialPublishJob(db, req.user.uid, {
        storyId,
        takeReportId: take.reportId || take.takeId,
        takeResponseDocId: take.takeResponseDocId || take.responseDocId || null,
        socialAccountId,
        platform,
        publishMode,
        caption,
        platformOptions: platformOptions && typeof platformOptions === 'object' ? platformOptions : {},
        mediaSnapshot: {
          videoGcsUrl: take.finalVideoGcs || null,
          audioGcsUrl: take.finalAudioGcs || null,
          thumbnailGcsUrl: take.thumbnailGcs || null,
        },
      });

      res.status(202).json({
        ok: true,
        takeId: take.takeId,
        publishJob,
      });

      logSocialAudit('publish_job_created', {
        platform,
        userId: req.user.uid,
        socialAccountId,
        publishJobId: publishJob.publishJobId,
        storyId,
        takeReportId: take.reportId || take.takeId,
        message: `Queued ${publishMode} publish job`,
      });

      if (typeof publishJobScheduler === 'function') {
        publishJobScheduler({
          db,
          storage: req.app.locals.storage || null,
          defaultBucketName: req.app.locals.bucketName || null,
          publishJobId: publishJob.publishJobId,
        });
      }
    } catch (err) {
      console.error(`[stories publish ${platform}]`, err.message);
      if (err.message === 'Unsupported platform') {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: 'Failed to create publish job' });
    }
  };
}

function getPublishJobActivityAt(publishJob) {
  return publishJob.completedAt
    || publishJob.updatedAt
    || publishJob.startedAt
    || publishJob.createdAt
    || publishJob.queuedAt
    || null;
}

function decoratePublishJob(publishJob) {
  return {
    ...publishJob,
    activityAt: getPublishJobActivityAt(publishJob),
    failureReason: publishJob.lastError?.message || null,
  };
}

function summarizeStoryPublishJobs(publishJobs) {
  const latestByPlatform = new Map();
  for (const publishJob of publishJobs) {
    if (!publishJob?.platform) continue;
    if (!latestByPlatform.has(publishJob.platform)) {
      latestByPlatform.set(publishJob.platform, {
        platform: publishJob.platform,
        status: publishJob.status || null,
        activityAt: getPublishJobActivityAt(publishJob),
        failureReason: publishJob.lastError?.message || null,
      });
    }
  }

  return Array.from(latestByPlatform.values());
}

function createRouter(storage, bucketName, options = {}) {
  const router = express.Router();
  const db = admin.firestore();
  const publishJobScheduler = options.publishJobScheduler || scheduleSocialPublishJob;
  router.use((req, _res, next) => {
    req.app.locals.storage = storage;
    req.app.locals.bucketName = bucketName;
    next();
  });

  // GET /api/stories — list stories for the authenticated user
  router.get('/', requireAuth, async (req, res) => {
    try {
      const snapshot = await db.collection('stories')
        .where('userId', '==', req.user.uid)
        .limit(50)
        .get();
      const ownedPublishJobs = await listOwnedPublishJobs(db, req.user.uid);
      const publishJobsByStoryId = new Map();
      ownedPublishJobs.forEach((publishJob) => {
        const storyPublishJobs = publishJobsByStoryId.get(publishJob.data.storyId) || [];
        storyPublishJobs.push(publishJob.serialized);
        publishJobsByStoryId.set(publishJob.data.storyId, storyPublishJobs);
      });

      const stories = await Promise.all(snapshot.docs.map(async (doc) => {
        const data = doc.data();
        const thumbnailSignedUrl = await gcsSignedUrl(storage, bucketName, data.thumbnail_gcs);
        const storyPublishJobs = publishJobsByStoryId.get(doc.id) || [];
        return {
          id: doc.id,
          promptText: data.promptText || null,
          status: data.status || null,
          createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
          thumbnailSignedUrl,
          publishSummary: summarizeStoryPublishJobs(storyPublishJobs),
        };
      }));

      stories.sort((a, b) => {
        if (!a.createdAt) return 1;
        if (!b.createdAt) return -1;
        return b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : 0;
      });

      res.json({ stories });
    } catch (err) {
      console.error('[stories GET /]', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/:storyId/reanalyze', requireAuth, async (req, res) => {
    try {
      const { storyId } = req.params;
      const loaded = await loadStoryDoc(db, storyId, req.user.uid);
      if (!loaded.doc) return res.status(loaded.status).json(loaded.body);

      const { data } = loaded;
      const transcript = Array.isArray(data.transcript) ? data.transcript : [];
      const assistantQuestions = transcript
        .filter(turn => turn && turn.role === 'interviewer' && typeof turn.text === 'string' && turn.text.trim())
        .map(turn => turn.text.trim());
      const interviewResponses = transcript
        .filter(turn => turn && turn.role === 'user' && typeof turn.text === 'string' && turn.text.trim())
        .map(turn => turn.text.trim());

      if (!assistantQuestions.length && !interviewResponses.length) {
        return res.status(400).json({ error: 'Story transcript unavailable for analysis' });
      }

      await loaded.doc.ref.update({
        status: 'analyzing',
        analysisError: null,
      });

      const { generateStoryAnalysis } = require('../utils/storyAnalysis');
      const result = await generateStoryAnalysis(
        `story-retry:${storyId}`,
        storyId,
        { assistantQuestions, interviewResponses },
        db,
        admin
      );

      if (!result.notes.length) {
        return res.status(502).json({ error: 'Unable to generate story notes' });
      }

      res.json({
        ok: true,
        notesCount: result.notes.length,
        analysisSource: result.analysisSource,
      });
    } catch (err) {
      console.error('[stories POST /:storyId/reanalyze]', err.message);
      res.status(500).json({ error: 'Failed to reanalyze story' });
    }
  });

  router.post(
    '/:storyId/takes/:takeId/publish/tiktok',
    rateLimiters.socialPublishAction,
    requireAuth,
    createPublishHandler({ platform: 'tiktok', publishMode: 'tiktok_draft', publishJobScheduler })
  );

  router.post(
    '/:storyId/takes/:takeId/publish/instagram',
    rateLimiters.socialPublishAction,
    requireAuth,
    createPublishHandler({ platform: 'instagram', publishMode: 'instagram_reel', publishJobScheduler })
  );

  // GET /api/stories/:storyId — fetch a single story with signed URLs
  router.get('/:storyId', requireAuth, async (req, res) => {
    try {
      const { storyId } = req.params;
      const loaded = await loadStoryDoc(db, storyId, req.user.uid);
      if (!loaded.doc) return res.status(loaded.status).json(loaded.body);

      const { doc, data } = loaded;
      let takes = await listStoryTakes(db, storage, bucketName, doc.id, data);
      if (!takes.length) {
        const legacyTake = await buildLegacyStoryTake(storage, bucketName, doc.id, data);
        if (legacyTake) takes = [legacyTake];
      }
      const publishJobs = await listOwnedPublishJobs(db, req.user.uid, { storyId });
      const publishJobsByTakeReportId = new Map();
      const decoratedPublishJobs = publishJobs.map((publishJob) => decoratePublishJob(publishJob.serialized));
      decoratedPublishJobs.forEach((publishJob) => {
        const takeJobs = publishJobsByTakeReportId.get(publishJob.takeReportId) || [];
        takeJobs.push(publishJob);
        publishJobsByTakeReportId.set(publishJob.takeReportId, takeJobs);
      });

      takes = takes.map((take, index) => ({
        ...take,
        isLatest: take.reportId ? take.reportId === data.finalReportId : index === 0,
        publishHistory: publishJobsByTakeReportId.get(take.reportId || take.takeId) || [],
      }));

      const latestTake = takes.find((take) => take.isLatest) || takes[0] || null;
      const latestAvailableTake = latestTake?.videoSignedUrl
        ? latestTake
        : takes.find((take) => take.videoSignedUrl) || latestTake;
      const videoSignedUrl = latestAvailableTake?.videoSignedUrl || null;
      const thumbnailSignedUrl = latestAvailableTake?.thumbnailSignedUrl || null;
      const audioSignedUrl = latestAvailableTake?.audioSignedUrl || null;
      const responseDocId = latestTake?.responseDocId || null;
      const mediaProcessingError = latestTake?.mediaProcessingError || data.mediaProcessingError || null;
      const mediaProcessingFailedAt = latestTake?.mediaProcessingFailedAt || toIsoString(data.mediaProcessingFailedAt);

      if (latestTake && latestTake.reportId === data.finalReportId) {
        const patch = {};
        if (latestTake.finalVideoGcs && latestTake.finalVideoGcs !== data.final_video_gcs) patch.final_video_gcs = latestTake.finalVideoGcs;
        if (latestTake.finalAudioGcs && latestTake.finalAudioGcs !== data.final_audio_gcs) patch.final_audio_gcs = latestTake.finalAudioGcs;
        if (latestTake.thumbnailGcs && latestTake.thumbnailGcs !== data.thumbnail_gcs) patch.thumbnail_gcs = latestTake.thumbnailGcs;
        if (Object.keys(patch).length) await doc.ref.update(patch).catch(() => {});
      }

      res.json({
        id: doc.id,
        storyId: doc.id,
        promptText: data.promptText || null,
        status: data.status || null,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        videoSignedUrl,
        finalVideoSignedUrl: videoSignedUrl,
        thumbnailSignedUrl,
        audioSignedUrl,
        finalVideoGcs: latestAvailableTake?.finalVideoGcs || null,
        thumbnailGcs: latestAvailableTake?.thumbnailGcs || null,
        finalReportId: data.finalReportId || null,
        latestTakeId: latestTake?.reportId || null,
        responseDocId,
        mediaProcessingError,
        mediaProcessingFailedAt,
        notes: data.notes || [],
        publishJobs: decoratedPublishJobs,
        takes,
      });
    } catch (err) {
      console.error('[stories GET /:storyId]', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = { createRouter };
