const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const { encryptSecret } = require('./social-crypto');

const SOCIAL_ACCOUNT_COLLECTION = 'socialAccounts';
const SOCIAL_PUBLISH_JOB_COLLECTION = 'socialPublishJobs';

function timestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}

function toIsoString(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return value?.toDate?.()?.toISOString?.() || null;
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

function serializePublishJob(doc) {
  const data = doc.data() || {};
  return {
    publishJobId: doc.id,
    userId: data.userId || null,
    storyId: data.storyId || null,
    takeReportId: data.takeReportId || null,
    takeResponseDocId: data.takeResponseDocId || null,
    socialAccountId: data.socialAccountId || null,
    platform: data.platform || null,
    publishMode: data.publishMode || null,
    status: data.status || null,
    caption: data.caption || '',
    platformOptions: data.platformOptions || {},
    mediaSnapshot: data.mediaSnapshot || {},
    attemptCount: data.attemptCount || 0,
    lastError: data.lastError || null,
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
    queuedAt: toIsoString(data.queuedAt),
    startedAt: toIsoString(data.startedAt),
    completedAt: toIsoString(data.completedAt),
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
    queuedAt: timestamp(),
    startedAt: null,
    completedAt: null,
    lastPolledAt: null,
    nextPollAt: null,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };

  await db.collection(SOCIAL_PUBLISH_JOB_COLLECTION).doc(publishJobId).set(publishJobDoc);
  await db.collection(SOCIAL_PUBLISH_JOB_COLLECTION).doc(publishJobId)
    .collection('events')
    .doc(uuidv4())
    .set({
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
      createdAt: timestamp(),
    });

  return {
    publishJobId,
    ...publishJobDoc,
    queuedAt: null,
    createdAt: null,
    updatedAt: null,
  };
}

async function getOwnedPublishJob(db, userId, publishJobId) {
  const doc = await db.collection(SOCIAL_PUBLISH_JOB_COLLECTION).doc(publishJobId).get();
  if (!doc.exists) return null;

  const data = doc.data() || {};
  if (data.userId !== userId) return null;

  return {
    doc,
    data,
    serialized: serializePublishJob(doc),
  };
}

module.exports = {
  SOCIAL_ACCOUNT_COLLECTION,
  SOCIAL_PUBLISH_JOB_COLLECTION,
  createSocialAccount,
  listSocialAccounts,
  getOwnedSocialAccount,
  upsertConnectedSocialAccount,
  createSocialPublishJob,
  getOwnedPublishJob,
  serializeSocialAccount,
  serializeSocialAccountStatusData,
  serializePublishJob,
  sanitizePlatform,
  normalizeScopes,
  toIsoString,
};
