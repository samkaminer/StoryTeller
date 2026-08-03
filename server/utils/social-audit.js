function redactId(value) {
  if (!value) return null;
  const text = String(value);
  if (text.length <= 8) return text;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function summarizeError(error) {
  if (!error) return null;
  return {
    message: error.message || null,
    httpStatus: error.httpStatus || error.status || null,
    code: error.uiSafeError?.code || error.code || null,
    platformCode: error.platformCode || error.uiSafeError?.platformCode || null,
    platformSubcode: error.platformSubcode || error.uiSafeError?.platformSubcode || null,
    retryable: typeof error.uiSafeError?.retryable === 'boolean'
      ? error.uiSafeError.retryable
      : (typeof error.retryable === 'boolean' ? error.retryable : null),
  };
}

function logSocialAudit(action, details = {}) {
  const level = details.level || 'info';
  const payload = {
    timestamp: new Date().toISOString(),
    area: 'social',
    action,
    platform: details.platform || null,
    publishJobId: redactId(details.publishJobId),
    socialAccountId: redactId(details.socialAccountId),
    userId: redactId(details.userId),
    storyId: redactId(details.storyId),
    takeReportId: redactId(details.takeReportId),
    status: details.status || null,
    attempt: Number.isFinite(details.attempt) ? details.attempt : null,
    httpStatus: details.httpStatus || null,
    providerCode: details.providerCode || null,
    providerSubcode: details.providerSubcode || null,
    retryInMs: details.retryInMs || null,
    message: details.message || null,
    error: summarizeError(details.error),
  };

  const logger = typeof console[level] === 'function' ? console[level] : console.info;
  logger('[SocialAudit]', JSON.stringify(payload));
}

module.exports = {
  logSocialAudit,
  redactId,
  summarizeError,
};
