const {
  executePlatformRequest,
  parseRetryAfterMs,
} = require('../utils/social-http');

describe('social http helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('parses numeric retry-after headers as milliseconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
  });

  it('caps provider retry-after delays to the configured maximum', async () => {
    const sleepImpl = jest.fn(async () => {});
    const operation = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Rate limited'), {
        httpStatus: 429,
        retryAfter: '120',
      }))
      .mockResolvedValueOnce({ ok: true });

    const result = await executePlatformRequest(operation, {
      maxAttempts: 2,
      maxDelayMs: 5000,
      sleepImpl,
    });

    expect(result).toEqual({ ok: true });
    expect(sleepImpl).toHaveBeenCalledWith(5000);
  });
});
