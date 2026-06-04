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
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return value?.toDate?.()?.toISOString?.() || null;
}

function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  return 0;
}

function readNormalizedTakeMedia(reportData) {
  if (!reportData || typeof reportData !== 'object') return null;

  const media = {
    responseDocId: reportData.take_response_doc_id || null,
    videoGcsUrl: reportData.take_video_gcs_url || null,
    audioGcsUrl: reportData.take_audio_gcs_url || null,
    thumbnailGcsUrl: reportData.take_thumbnail_gcs_url || null,
    mediaProcessedAt: toIsoString(reportData.take_media_processed_at),
    mediaProcessingError: reportData.take_media_processing_error || null,
    mediaProcessingFailedAt: toIsoString(reportData.take_media_processing_failed_at),
  };

  const hasMedia = Boolean(
    media.videoGcsUrl ||
    media.audioGcsUrl ||
    media.thumbnailGcsUrl ||
    media.mediaProcessingError ||
    media.mediaProcessingFailedAt ||
    media.mediaProcessedAt
  );

  return hasMedia ? media : null;
}

async function findStoryMediaFromReport(db, reportId) {
  if (!db || !reportId) return null;

  const responsesSnap = await db.collection('reports')
    .doc(reportId)
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
        thumbnailGcsUrl: null,
        mediaProcessedAt: toIsoString(data.mediaProcessedAt),
        mediaProcessingError: data.mediaProcessingError || null,
        mediaProcessingFailedAt: toIsoString(data.mediaProcessingFailedAt),
        createdAt: toIsoString(data.timestamp),
      };
    }
  }

  return null;
}

async function buildStoryTake(db, storage, bucketName, reportDoc, storyId, storyData, fallbackToStoryDoc = false) {
  const reportData = reportDoc.data() || {};
  const normalizedMedia = readNormalizedTakeMedia(reportData);
  const resolvedMedia = normalizedMedia || await findStoryMediaFromReport(db, reportDoc.id);
  const useStoryDocMedia = fallbackToStoryDoc && !resolvedMedia?.videoGcsUrl && !resolvedMedia?.audioGcsUrl;

  const videoGcsUrl = resolvedMedia?.videoGcsUrl || (useStoryDocMedia ? storyData.final_video_gcs || null : null);
  const audioGcsUrl = resolvedMedia?.audioGcsUrl || (useStoryDocMedia ? storyData.final_audio_gcs || null : null);
  const thumbnailGcsUrl = resolvedMedia?.thumbnailGcsUrl || (useStoryDocMedia ? storyData.thumbnail_gcs || null : null);
  const mediaProcessedAt = resolvedMedia?.mediaProcessedAt || (useStoryDocMedia ? toIsoString(storyData.mediaProcessedAt) : null);
  const mediaProcessingError = resolvedMedia?.mediaProcessingError || (useStoryDocMedia ? storyData.mediaProcessingError || null : null);
  const mediaProcessingFailedAt = resolvedMedia?.mediaProcessingFailedAt || (useStoryDocMedia ? toIsoString(storyData.mediaProcessingFailedAt) : null);
  const takeMediaStatus = reportData.take_media_status || (videoGcsUrl ? 'ready' : null);

  const [videoSignedUrl, thumbnailSignedUrl, audioSignedUrl] = await Promise.all([
    gcsSignedUrl(storage, bucketName, videoGcsUrl),
    gcsSignedUrl(storage, bucketName, thumbnailGcsUrl),
    gcsSignedUrl(storage, bucketName, audioGcsUrl),
  ]);

  return {
    storyId,
    takeId: reportDoc.id,
    reportId: reportDoc.id,
    responseDocId: reportData.take_response_doc_id || resolvedMedia?.responseDocId || null,
    takeResponseDocId: reportData.take_response_doc_id || resolvedMedia?.responseDocId || null,
    status: reportData.status || null,
    createdAt: toIsoString(reportData.start_timestamp) || resolvedMedia?.createdAt || null,
    videoSignedUrl,
    thumbnailSignedUrl,
    audioSignedUrl,
    finalVideoGcs: videoGcsUrl,
    thumbnailGcs: thumbnailGcsUrl,
    finalAudioGcs: audioGcsUrl,
    mediaProcessedAt,
    takeMediaStatus,
    mediaProcessingError,
    mediaProcessingFailedAt,
    media: {
      ready: Boolean(videoGcsUrl),
      status: takeMediaStatus,
      processedAt: mediaProcessedAt,
      processingError: mediaProcessingError,
      processingFailedAt: mediaProcessingFailedAt,
      videoSignedUrl,
      audioSignedUrl,
      thumbnailSignedUrl,
      videoGcsUrl,
      audioGcsUrl,
      thumbnailGcsUrl,
    },
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
    buildStoryTake(db, storage, bucketName, reportDoc, storyId, storyData, reportDoc.id === storyData.finalReportId)
  )));
}

async function buildLegacyStoryTake(storage, bucketName, storyId, storyData) {
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
    storyId,
    takeId: storyData.finalReportId || 'legacy-story-take',
    reportId: storyData.finalReportId || null,
    responseDocId: null,
    takeResponseDocId: null,
    status: storyData.status || null,
    createdAt: toIsoString(storyData.finalRecordedAt) || null,
    videoSignedUrl,
    thumbnailSignedUrl,
    audioSignedUrl,
    finalVideoGcs: videoGcsUrl,
    thumbnailGcs: thumbnailGcsUrl,
    finalAudioGcs: audioGcsUrl,
    mediaProcessedAt: toIsoString(storyData.mediaProcessedAt),
    takeMediaStatus: videoGcsUrl ? 'ready' : null,
    mediaProcessingError: storyData.mediaProcessingError || null,
    mediaProcessingFailedAt: toIsoString(storyData.mediaProcessingFailedAt),
    media: {
      ready: Boolean(videoGcsUrl),
      status: videoGcsUrl ? 'ready' : null,
      processedAt: toIsoString(storyData.mediaProcessedAt),
      processingError: storyData.mediaProcessingError || null,
      processingFailedAt: toIsoString(storyData.mediaProcessingFailedAt),
      videoSignedUrl,
      audioSignedUrl,
      thumbnailSignedUrl,
      videoGcsUrl,
      audioGcsUrl,
      thumbnailGcsUrl,
    },
  };
}

function isMatchingTakeId(take, takeId) {
  if (!take || !takeId) return false;
  return take.takeId === takeId || take.reportId === takeId || take.responseDocId === takeId;
}

async function resolveStoryTake(db, storage, bucketName, storyId, storyData, takeId) {
  let takes = await listStoryTakes(db, storage, bucketName, storyId, storyData);
  if (!takes.length) {
    const legacyTake = await buildLegacyStoryTake(storage, bucketName, storyId, storyData);
    if (legacyTake) takes = [legacyTake];
  }

  return takes.find((take) => isMatchingTakeId(take, takeId)) || null;
}

module.exports = {
  gcsSignedUrl,
  loadStoryDoc,
  toIsoString,
  toMillis,
  listStoryTakes,
  buildLegacyStoryTake,
  resolveStoryTake,
};
