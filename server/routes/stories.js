const express = require('express');
const admin = require('firebase-admin');
const { requireAuth } = require('../middleware/auth');

async function gcsSignedUrl(storage, bucketName, gcsPath) {
  if (!storage || !bucketName || !gcsPath) return null;
  try {
    const filePath = gcsPath.replace(`gs://${bucketName}/`, '');
    const [url] = await storage.bucket(bucketName).file(filePath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    return url;
  } catch {
    return null;
  }
}

async function loadStoryDoc(db, storyId, userId) {
  const doc = await db.collection('stories').doc(storyId).get();
  if (!doc.exists) return { status: 404, body: { error: 'Not found' } };

  const data = doc.data() || {};
  if (data.userId && data.userId !== userId) {
    return { status: 403, body: { error: 'Forbidden' } };
  }

  return { doc, data };
}

function toIsoString(value) {
  return value?.toDate?.()?.toISOString?.() || null;
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  return 0;
}

async function findStoryMediaFromReport(db, finalReportId) {
  if (!db || !finalReportId) return null;

  const responsesSnap = await db.collection('reports')
    .doc(finalReportId)
    .collection('responses')
    .get();

  if (responsesSnap.empty) return null;

  for (const doc of responsesSnap.docs) {
    const data = doc.data() || {};
    if (data.video_gcs_url || data.audio_gcs_url || data.mediaProcessingError || data.mediaProcessingFailedAt) {
      return {
        responseDocId: doc.id,
        videoGcsUrl: data.video_gcs_url || null,
        audioGcsUrl: data.audio_gcs_url || null,
        mediaProcessingError: data.mediaProcessingError || null,
        mediaProcessingFailedAt: data.mediaProcessingFailedAt?.toDate?.()?.toISOString?.() || null,
        createdAt: toIsoString(data.timestamp),
      };
    }
  }

  return null;
}

async function buildStoryTake(db, storage, bucketName, reportDoc, storyData, fallbackToStoryDoc = false) {
  const reportData = reportDoc.data() || {};
  const fallbackMedia = await findStoryMediaFromReport(db, reportDoc.id);
  const useStoryDocMedia = fallbackToStoryDoc && !fallbackMedia?.videoGcsUrl && !fallbackMedia?.audioGcsUrl;

  const videoGcsUrl = fallbackMedia?.videoGcsUrl || (useStoryDocMedia ? storyData.final_video_gcs || null : null);
  const audioGcsUrl = fallbackMedia?.audioGcsUrl || (useStoryDocMedia ? storyData.final_audio_gcs || null : null);
  const thumbnailGcsUrl = useStoryDocMedia ? storyData.thumbnail_gcs || null : null;
  const mediaProcessingError = fallbackMedia?.mediaProcessingError || (useStoryDocMedia ? storyData.mediaProcessingError || null : null);
  const mediaProcessingFailedAt = fallbackMedia?.mediaProcessingFailedAt || (useStoryDocMedia ? toIsoString(storyData.mediaProcessingFailedAt) : null);

  const [videoSignedUrl, thumbnailSignedUrl, audioSignedUrl] = await Promise.all([
    gcsSignedUrl(storage, bucketName, videoGcsUrl),
    gcsSignedUrl(storage, bucketName, thumbnailGcsUrl),
    gcsSignedUrl(storage, bucketName, audioGcsUrl),
  ]);

  return {
    takeId: reportDoc.id,
    reportId: reportDoc.id,
    responseDocId: fallbackMedia?.responseDocId || null,
    status: reportData.status || null,
    createdAt: toIsoString(reportData.start_timestamp) || fallbackMedia?.createdAt || null,
    videoSignedUrl,
    thumbnailSignedUrl,
    audioSignedUrl,
    finalVideoGcs: videoGcsUrl,
    thumbnailGcs: thumbnailGcsUrl,
    finalAudioGcs: audioGcsUrl,
    mediaProcessingError,
    mediaProcessingFailedAt,
  };
}

async function listStoryTakes(db, storage, bucketName, storyId, storyData) {
  if (!db || !storyId) return [];

  const reportsSnap = await db.collection('reports')
    .where('story_id', '==', storyId)
    .get();

  const reportDocs = reportsSnap.docs
    .filter((doc) => (doc.data() || {}).report_type === 'final_telling')
    .sort((a, b) => toMillis(b.data()?.start_timestamp) - toMillis(a.data()?.start_timestamp));

  if (!reportDocs.length) return [];

  return Promise.all(reportDocs.map((reportDoc) => (
    buildStoryTake(db, storage, bucketName, reportDoc, storyData, reportDoc.id === storyData.finalReportId)
  )));
}

async function buildLegacyStoryTake(storage, bucketName, storyData) {
  const videoGcsUrl = storyData.final_video_gcs || null;
  const thumbnailGcsUrl = storyData.thumbnail_gcs || null;
  const audioGcsUrl = storyData.final_audio_gcs || null;

  if (!videoGcsUrl && !audioGcsUrl && !storyData.mediaProcessingError && !storyData.mediaProcessingFailedAt) {
    return null;
  }

  const [videoSignedUrl, thumbnailSignedUrl, audioSignedUrl] = await Promise.all([
    gcsSignedUrl(storage, bucketName, videoGcsUrl),
    gcsSignedUrl(storage, bucketName, thumbnailGcsUrl),
    gcsSignedUrl(storage, bucketName, audioGcsUrl),
  ]);

  return {
    takeId: storyData.finalReportId || 'legacy-story-take',
    reportId: storyData.finalReportId || null,
    responseDocId: null,
    status: storyData.status || null,
    createdAt: toIsoString(storyData.finalRecordedAt) || null,
    videoSignedUrl,
    thumbnailSignedUrl,
    audioSignedUrl,
    finalVideoGcs: videoGcsUrl,
    thumbnailGcs: thumbnailGcsUrl,
    finalAudioGcs: audioGcsUrl,
    mediaProcessingError: storyData.mediaProcessingError || null,
    mediaProcessingFailedAt: toIsoString(storyData.mediaProcessingFailedAt),
  };
}

function createRouter(storage, bucketName) {
  const router = express.Router();
  const db = admin.firestore();

  // GET /api/stories — list stories for the authenticated user
  router.get('/', requireAuth, async (req, res) => {
    try {
      const snapshot = await db.collection('stories')
        .where('userId', '==', req.user.uid)
        .limit(50)
        .get();

      const stories = await Promise.all(snapshot.docs.map(async (doc) => {
        const data = doc.data();
        const thumbnailSignedUrl = await gcsSignedUrl(storage, bucketName, data.thumbnail_gcs);
        return {
          id: doc.id,
          promptText: data.promptText || null,
          status: data.status || null,
          createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
          thumbnailSignedUrl,
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

  // GET /api/stories/:storyId — fetch a single story with signed URLs
  router.get('/:storyId', requireAuth, async (req, res) => {
    try {
      const { storyId } = req.params;
      const loaded = await loadStoryDoc(db, storyId, req.user.uid);
      if (!loaded.doc) return res.status(loaded.status).json(loaded.body);

      const { doc, data } = loaded;
      let takes = await listStoryTakes(db, storage, bucketName, doc.id, data);
      if (!takes.length) {
        const legacyTake = await buildLegacyStoryTake(storage, bucketName, data);
        if (legacyTake) takes = [legacyTake];
      }

      takes = takes.map((take, index) => ({
        ...take,
        isLatest: take.reportId ? take.reportId === data.finalReportId : index === 0,
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
