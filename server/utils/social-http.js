const { logSocialAudit } = require('./social-audit');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

function isRetryablePlatformError(error) {
  const status = error?.httpStatus || error?.status || null;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  if (error?.type === 'system') return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(error?.code)) {
    return true;
  }
  return false;
}

async function executePlatformRequest(operation, options = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 5_000,
    sleepImpl = sleep,
    audit = {},
    isRetryable = isRetryablePlatformError,
  } = options;

  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await operation({ attempt });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt >= maxAttempts) {
        throw error;
      }

      const parsedRetryAfterMs = parseRetryAfterMs(error?.retryAfter);
      const retryAfterMs = parsedRetryAfterMs !== null
        ? Math.min(maxDelayMs, Math.max(0, parsedRetryAfterMs))
        : Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      logSocialAudit('outbound_retry_scheduled', {
        ...audit,
        level: 'warn',
        attempt,
        httpStatus: error?.httpStatus || error?.status || null,
        providerCode: error?.platformCode || null,
        providerSubcode: error?.platformSubcode || null,
        retryInMs: retryAfterMs,
        error,
      });

      await sleepImpl(retryAfterMs);
    }
  }

  throw lastError;
}

module.exports = {
  executePlatformRequest,
  isRetryablePlatformError,
  parseRetryAfterMs,
};
