const crypto = require('crypto');
const admin = require('firebase-admin');

const SOCIAL_AUTH_STATE_COLLECTION = 'socialAuthStates';
const DEFAULT_STATE_TTL_MINUTES = 10;

function timestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}

function getStateTtlMs() {
  const configuredMinutes = Number(process.env.SOCIAL_OAUTH_STATE_TTL_MINUTES || DEFAULT_STATE_TTL_MINUTES);
  const ttlMinutes = Number.isFinite(configuredMinutes) && configuredMinutes > 0
    ? configuredMinutes
    : DEFAULT_STATE_TTL_MINUTES;
  return ttlMinutes * 60 * 1000;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return value?.toDate?.() || null;
}

function sanitizeRedirectPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (/[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function createCodeVerifier() {
  return crypto.randomBytes(48).toString('base64url');
}

function createCodeChallenge(codeVerifier) {
  return crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function createSocialAuthState(db, payload) {
  const state = crypto.randomBytes(24).toString('base64url');
  const codeVerifier = payload.codeVerifier || null;
  const expiresAt = new Date(Date.now() + getStateTtlMs());

  await db.collection(SOCIAL_AUTH_STATE_COLLECTION).doc(state).set({
    userId: payload.userId,
    platform: payload.platform,
    storyId: payload.storyId || null,
    takeReportId: payload.takeReportId || null,
    codeVerifier,
    redirectPath: sanitizeRedirectPath(payload.redirectPath),
    requestedScopes: Array.isArray(payload.requestedScopes) ? payload.requestedScopes : [],
    createdAt: timestamp(),
    expiresAt,
    usedAt: null,
  });

  return {
    state,
    codeVerifier,
    codeChallenge: codeVerifier ? createCodeChallenge(codeVerifier) : null,
    expiresAt,
  };
}

function assertUsableStateDoc(doc, platform) {
  if (!doc.exists) {
    throw new Error('Invalid OAuth state');
  }

  const data = doc.data() || {};
  if (data.platform !== platform) {
    throw new Error('OAuth state platform mismatch');
  }
  if (data.usedAt) {
    throw new Error('OAuth state already used');
  }

  const expiresAt = toDate(data.expiresAt);
  if (expiresAt && expiresAt.getTime() < Date.now()) {
    throw new Error('OAuth state expired');
  }

  return data;
}

async function consumeSocialAuthState(db, state, platform) {
  const stateRef = db.collection(SOCIAL_AUTH_STATE_COLLECTION).doc(state);
  if (typeof db.runTransaction === 'function') {
    return db.runTransaction(async (transaction) => {
      const doc = await transaction.get(stateRef);
      const data = assertUsableStateDoc(doc, platform);
      transaction.update(stateRef, {
        usedAt: timestamp(),
      });

      return {
        stateRef,
        doc,
        data,
      };
    });
  }

  const doc = await stateRef.get();
  const data = assertUsableStateDoc(doc, platform);

  await stateRef.update({
    usedAt: timestamp(),
  });

  return {
    stateRef,
    doc,
    data,
  };
}

module.exports = {
  SOCIAL_AUTH_STATE_COLLECTION,
  consumeSocialAuthState,
  createCodeChallenge,
  createCodeVerifier,
  createSocialAuthState,
  sanitizeRedirectPath,
};
