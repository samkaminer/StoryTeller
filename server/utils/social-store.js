const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const { encryptSecret } = require('./social-crypto');

const SOCIAL_ACCOUNT_COLLECTION = 'socialAccounts';
const SOCIAL_PUBLISH_JOB_COLLECTION = 'socialPublishJobs';
const SOCIAL_PUBLISH_EVENT_SUBCOLLECTION = 'events';
const SOCIAL_PUBLISH_LEASE_DURATION_MS = 5 * 60 * 1000;

function timestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}

function toIsoString(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return value?.toDate?.()?.toISOString?.() || null;
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const firestoreDate = value?.toDate?.();
  return firestoreDate instanceof Date ? firestoreDate : null;
}

function sanitizePlatform(platform) {
  if (platform === 'tiktok' || platform === 'instagram') return platform;
  throw new Error('Unsupported platform');
}

function normalizeScopes(scopes) {
  return Array.isArray(scopes)
    ? [...new Set(scopes.filter((scope) => typeof scope === 'string' && scope.trim()).map((scope) => scope.trim()))]
    : [];
}

function buildSafeMeta(meta = {}) {
  return {
    openId: meta.openId || null,
    unionId: meta.unionId || null,
    avatarUrl: meta.avatarUrl || null,
    profileDeepLink: meta.profileDeepLink || null,
    igUserId: meta.igUserId || null,
    facebookPageId: meta.facebookPageId || null,
    facebookPageName: meta.facebookPageName || null,
    facebookUserId: meta.facebookUserId || null,
  };
}

function serializeSocialAccountStatusData(data = {}, socialAccountId = null) {
  return {
    socialAccountId,
    platform: data.platform || null,
    displayName: data.displayName || null,
    username: data.username || null,
    status: data.status || null,
    connectedAt: toIsoString(data.connectedAt),
    updatedAt: toIsoString(data.updatedAt),
    hasRefreshToken: Boolean(data.refreshToken?.ciphertext),
  };
}

function serializeSocialAccount(doc) {
  const data = doc.data() || {};
  return serializeSocialAccountStatusData(data, doc.id);
}

async function findExistingSocialAccountDoc(db, userId, platform) {
  const snapshot = await db.collection(SOCIAL_ACCOUNT_COLLECTION)
    .where('userId', '==', userId)
    .where('platform', '==', platform)
    .limit(1)
    .get();

  return snapshot.docs[0] || null;
}

async function upsertConnectedSocialAccount(db, userId, payload) {
  const platform = sanitizePlatform(payload.platform);
  const existingDoc = await findExistingSocialAccountDoc(db, userId, platform);
  const socialAccountId = existingDoc?.id || uuidv4();
  const socialAccountRef = db.collection(SOCIAL_ACCOUNT_COLLECTION).doc(socialAccountId);
  const existingData = existingDoc?.data?.() || {};

  const accountDoc = {
    userId,
    platform,
    platformAccountId: payload.platformAccountId || existingData.platformAccountId || socialAccountId,
    displayName: payload.displayName || existingData.displayName || null,
    username: payload.username || existingData.username || null,
    status: payload.status || 'active',
    isPrimary: true,
    loginProvider: payload.loginProvider || existingData.loginProvider || null,
    scopes: normalizeScopes(payload.scopes?.length ? payload.scopes : existingData.scopes),
    accessToken: payload.accessToken ? encryptSecret(payload.accessToken) : (existingData.accessToken || null),
    refreshToken: payload.refreshToken
      ? encryptSecret(payload.refreshToken)
      : (payload.refreshToken === null ? null : (existingData.refreshToken || null)),
    tokenType: payload.tokenType || existingData.tokenType || 'Bearer',
    tokenExpiresAt: payload.tokenExpiresAt || null,
    refreshTokenExpiresAt: payload.refreshTokenExpiresAt || null,
    connectedAt: existingData.connectedAt || timestamp(),
    lastValidatedAt: timestamp(),
    lastRefreshAt: existingData.lastRefreshAt || null,
    updatedAt: timestamp(),
    meta: {
      ...buildSafeMeta(existingData.meta),
      ...buildSafeMeta(payload.meta),
    },
  };

  await socialAccountRef.set(accountDoc);

  return serializeSocialAccountStatusData({
    ...accountDoc,
    connectedAt: existingData.connectedAt || null,
    updatedAt: null,
    lastValidatedAt: null,
  }, socialAccountId);
}

async function createSocialAccount(db, userId, payload) {
  return upsertConnectedSocialAccount(db, userId, payload);
}

async function listSocialAccounts(db, userId) {
  const snapshot = await db.collection(SOCIAL_ACCOUNT_COLLECTION)
    .where('userId', '==', userId)
    .get();

  return snapshot.docs.map(serializeSocialAccount);
}

async function getOwnedSocialAccount(db, userId, socialAccountId) {
  const doc = await db.collection(SOCIAL_ACCOUNT_COLLECTION).doc(socialAccountId).get();
  if (!doc.exists) return null;

  const data = doc.data() || {};
  if (data.userId !== userId) return null;

  return {
    doc,
    data,
    serialized: serializeSocialAccount(doc),
  };
}

async function disconnectOwnedSocialAccount(db, userId, socialAccountId) {
  const ownedAccount = await getOwnedSocialAccount(db, userId, socialAccountId);
  if (!ownedAccount) return null;

  await db.collection(SOCIAL_ACCOUNT_COLLECTION).doc(socialAccountId).update({
    status: 'disconnected',
    accessToken: null,
    refreshToken: null,
    tokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    lastValidatedAt: null,
    lastRefreshAt: null,
    updatedAt: timestamp(),
  });

  return {
    ...ownedAccount,
    data: {
      ...ownedAccount.data,
      status: 'disconnected',
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      lastValidatedAt: null,
      lastRefreshAt: null,
      updatedAt: new Date().toISOString(),
    },
    serialized: serializeSocialAccountStatusData({
      ...ownedAccount.data,
      status: 'disconnected',
      accessToken: null,
      refreshToken: null,
      updatedAt: new Date().toISOString(),
    }, socialAccountId),
  };
}

function serializePublishJob(doc) {
  const data = doc.data() || {};
  return serializePublishJobData(data, doc.id);
}

function serializePublishJobData(data = {}, publishJobId = null) {
  return {
    publishJobId,
    userId: data.userId || null,
    storyId: data.storyId || null,
    takeReportId: data.takeReportId || null,
    takeResponseDocId: data.takeResponseDocId || null,
    socialAccountId: data.socialAccountId || null,
    platform: data.platform || null,
    publishMode: data.publishMode || null,
    status: data.status || null,
    statusMessage: data.statusMessage || null,
    platformStatus: data.platformStatus || null,
    caption: data.caption || '',
    platformOptions: data.platformOptions || {},
    mediaSnapshot: data.mediaSnapshot || {},
    platformPublishId: data.platformPublishId || null,
    platformContainerId: data.platformContainerId || null,
    platformPostId: data.platformPostId || null,
    platformPermalink: data.platformPermalink || null,
    attemptCount: data.attemptCount || 0,
    lastError: data.lastError || null,
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
    queuedAt: toIsoString(data.queuedAt),
    startedAt: toIsoString(data.startedAt),
    completedAt: toIsoString(data.completedAt),
    lastPolledAt: toIsoString(data.lastPolledAt),
    nextPollAt: toIsoString(data.nextPollAt),
  };
}

async function createSocialPublishJob(db, userId, payload) {
  const platform = sanitizePlatform(payload.platform);
  const publishJobId = uuidv4();
  const publishJobDoc = {
    userId,
    storyId: payload.storyId,
    takeReportId: payload.takeReportId,
    takeResponseDocId: payload.takeResponseDocId || null,
    socialAccountId: payload.socialAccountId,
    platform,
    publishMode: payload.publishMode,
    status: 'queued',
    statusMessage: payload.statusMessage || 'Queued for publishing',
    platformStatus: null,
    caption: payload.caption || '',
    platformOptions: payload.platformOptions || {},
    mediaSnapshot: {
      videoGcsUrl: payload.mediaSnapshot?.videoGcsUrl || null,
      audioGcsUrl: payload.mediaSnapshot?.audioGcsUrl || null,
      thumbnailGcsUrl: payload.mediaSnapshot?.thumbnailGcsUrl || null,
      mimeType: payload.mediaSnapshot?.mimeType || null,
      durationSec: payload.mediaSnapshot?.durationSec || null,
      width: payload.mediaSnapshot?.width || null,
      height: payload.mediaSnapshot?.height || null,
      fileSizeBytes: payload.mediaSnapshot?.fileSizeBytes || null,
    },
    platformPublishId: null,
    platformContainerId: null,
    platformPostId: null,
    platformPermalink: null,
    attemptCount: 0,
    lastError: null,
    processingLeaseOwner: null,
    processingLeaseExpiresAt: null,
    queuedAt: timestamp(),
    startedAt: null,
    completedAt: null,
    lastPolledAt: null,
    nextPollAt: null,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };

  await db.collection(SOCIAL_PUBLISH_JOB_COLLECTION).doc(publishJobId).set(publishJobDoc);
  await appendSocialPublishJobEvent(db, publishJobId, {
    type: 'job_created',
    status: 'queued',
    message: `Queued ${platform} publish job for take ${payload.takeReportId}`,
    platformCode: null,
    httpStatus: 0,
    attempt: 0,
    payloadRedacted: {
      storyId: payload.storyId,
      takeReportId: payload.takeReportId,
      socialAccountId: payload.socialAccountId,
    },
  });

  return {
    publishJobId,
    ...publishJobDoc,
    queuedAt: null,
    createdAt: null,
    updatedAt: null,
  };
}

async function appendSocialPublishJobEvent(db, publishJobId, event) {
  await db.collection(SOCIAL_PUBLISH_JOB_COLLECTION)
    .doc(publishJobId)
    .collection(SOCIAL_PUBLISH_EVENT_SUBCOLLECTION)
    .doc(uuidv4())
    .set({
      type: event.type || 'job_event',
      status: event.status || null,
      message: event.message || null,
      platformCode: event.platformCode || null,
      httpStatus: Number.isFinite(event.httpStatus) ? event.httpStatus : 0,
      attempt: Number.isFinite(event.attempt) ? event.attempt : 0,
      payloadRedacted: event.payloadRedacted || null,
      createdAt: timestamp(),
    });
}

async function getSocialPublishJob(db, publishJobId) {
  const doc = await db.collection(SOCIAL_PUBLISH_JOB_COLLECTION).doc(publishJobId).get();
  if (!doc.exists) return null;

  return {
    doc,
    data: doc.data() || {},
    serialized: serializePublishJob(doc),
  };
}

async function getOwnedPublishJob(db, userId, publishJobId) {
  const publishJob = await getSocialPublishJob(db, publishJobId);
  if (!publishJob) return null;
  if (publishJob.data.userId !== userId) return null;

  return {
    ...publishJob,
  };
}

async function updateSocialPublishJob(db, publishJobId, patch = {}, event = null) {
  await db.collection(SOCIAL_PUBLISH_JOB_COLLECTION).doc(publishJobId).update({
    ...patch,
    updatedAt: timestamp(),
  });

  if (event) {
    await appendSocialPublishJobEvent(db, publishJobId, event);
  }
}

function buildLeaseClaimResult(data, publishJobId, claimed, leaseOwner, leaseExpiresAt, now) {
  const mergedData = claimed
    ? {
      ...data,
      processingLeaseOwner: leaseOwner,
      processingLeaseExpiresAt: leaseExpiresAt,
      updatedAt: now,
    }
    : data;

  return {
    claimed,
    data: mergedData,
    serialized: serializePublishJobData(mergedData, publishJobId),
  };
}

function evaluateLeaseClaim(snapshot, publishJobId, leaseOwner, leaseExpiresAt, now) {
  if (!snapshot.exists) {
    return {
      patch: null,
      result: null,
    };
  }

  const data = snapshot.data() || {};
  const status = data.status || null;
  const currentLeaseExpiresAt = toDate(data.processingLeaseExpiresAt);
  const hasActiveLease = Boolean(
    data.processingLeaseOwner &&
    currentLeaseExpiresAt &&
    currentLeaseExpiresAt.getTime() > now.getTime()
  );

  if (status === 'completed' || status === 'failed' || data.platformPublishId || hasActiveLease) {
    return {
      patch: null,
      result: buildLeaseClaimResult(data, publishJobId, false, leaseOwner, leaseExpiresAt, now),
    };
  }

  return {
    patch: {
      processingLeaseOwner: leaseOwner,
      processingLeaseExpiresAt: leaseExpiresAt,
      updatedAt: timestamp(),
    },
    result: buildLeaseClaimResult(data, publishJobId, true, leaseOwner, leaseExpiresAt, now),
  };
}

async function claimSocialPublishJobLease(db, publishJobId, options = {}) {
  const leaseOwner = options.leaseOwner || uuidv4();
  const leaseDurationMs = Number.isFinite(options.leaseDurationMs) && options.leaseDurationMs > 0
    ? options.leaseDurationMs
    : SOCIAL_PUBLISH_LEASE_DURATION_MS;
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
  const docRef = db.collection(SOCIAL_PUBLISH_JOB_COLLECTION).doc(publishJobId);

  if (typeof db.runTransaction === 'function') {
    let claimResult = null;

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);
      const evaluated = evaluateLeaseClaim(snapshot, publishJobId, leaseOwner, leaseExpiresAt, now);
      claimResult = evaluated.result;
      if (evaluated.patch) {
        transaction.update(docRef, evaluated.patch);
      }
    });

    return claimResult;
  }

  const snapshot = await docRef.get();
  const evaluated = evaluateLeaseClaim(snapshot, publishJobId, leaseOwner, leaseExpiresAt, now);
  if (evaluated.patch) {
    await docRef.update(evaluated.patch);
  }

  return evaluated.result;
}

module.exports = {
  SOCIAL_ACCOUNT_COLLECTION,
  SOCIAL_PUBLISH_JOB_COLLECTION,
  SOCIAL_PUBLISH_EVENT_SUBCOLLECTION,
  SOCIAL_PUBLISH_LEASE_DURATION_MS,
  createSocialAccount,
  listSocialAccounts,
  getOwnedSocialAccount,
  disconnectOwnedSocialAccount,
  upsertConnectedSocialAccount,
  createSocialPublishJob,
  appendSocialPublishJobEvent,
  claimSocialPublishJobLease,
  getSocialPublishJob,
  getOwnedPublishJob,
  updateSocialPublishJob,
  serializeSocialAccount,
  serializeSocialAccountStatusData,
  serializePublishJob,
  serializePublishJobData,
  sanitizePlatform,
  normalizeScopes,
  toIsoString,
};
