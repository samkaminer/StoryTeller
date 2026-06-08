const rateLimit = require('express-rate-limit');

function createJsonRateLimiter(config) {
  const { message, ...rest } = config;
  return rateLimit({
    ...rest,
    message,
    handler: (req, res, _next, options) => {
      res.status(options.statusCode).json({
        error: message,
        code: 'RATE_LIMITED',
      });
    },
  });
}

// Different rate limiters for different endpoints
const rateLimiters = {
  // Strict limit for authentication endpoints
  auth: createJsonRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 requests per window
    message: 'Too many authentication attempts, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
  }),

  // Strict limit for third-party OAuth connect flows
  socialConnect: createJsonRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 OAuth starts/callbacks per window
    message: 'Too many social connection attempts, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
  }),

  // Moderate limit for API endpoints
  api: createJsonRateLimiter({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // 60 requests per minute
    message: 'Too many requests, please slow down',
    standardHeaders: true,
    legacyHeaders: false,
  }),

  // Strict limit for report generation
  reportGeneration: createJsonRateLimiter({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3, // 3 reports per 5 minutes
    message: 'Too many report generation requests, please wait before trying again',
    standardHeaders: true,
    legacyHeaders: false,
  }),

  // Moderate limit for anonymous interview access
  anonymousInterview: createJsonRateLimiter({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    message: 'Too many requests, please slow down',
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true, // Don't count successful requests
  }),

  // Very strict limit for file uploads
  fileUpload: createJsonRateLimiter({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 10, // 10 uploads per 10 minutes
    message: 'Too many file uploads, please wait before uploading more',
    standardHeaders: true,
    legacyHeaders: false,
  }),

  // Moderate limit for interview recordings
  interviewRecording: createJsonRateLimiter({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 100, // 100 recordings per 5 minutes (allows rapid re-recording)
    message: 'Too many recording uploads, please wait a moment before trying again',
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
  }),

  // Strict limit for audio processing
  audioProcessing: createJsonRateLimiter({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute
    message: 'Too many audio processing requests, please slow down',
    standardHeaders: true,
    legacyHeaders: false,
  })
};

module.exports = rateLimiters;
