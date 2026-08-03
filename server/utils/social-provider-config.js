const { assertSocialTokenEncryptionConfig } = require('./social-crypto');

function normalizeScopes(scopes) {
  return Array.isArray(scopes)
    ? [...new Set(scopes.filter((scope) => typeof scope === 'string' && scope.trim()).map((scope) => scope.trim()))]
    : [];
}

function splitScopes(value, fallback) {
  if (Array.isArray(value)) return normalizeScopes(value);
  if (typeof value !== 'string' || !value.trim()) return normalizeScopes(fallback);
  return normalizeScopes(value.split(/[,\s]+/));
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

module.exports = {
  addSecondsToNow,
  getMetaConfig,
  getMissingEnvVars,
  getTikTokConfig,
  normalizeScopes,
  splitScopes,
};
