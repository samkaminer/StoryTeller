const crypto = require('crypto');

const DEFAULT_KEY_VERSION = 'v1';

function getEncryptionKeyVersion() {
  return process.env.SOCIAL_TOKEN_ENCRYPTION_KEY_VERSION || DEFAULT_KEY_VERSION;
}

function getEncryptionKey() {
  const encodedKey = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64;
  if (!encodedKey) {
    throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64 is required');
  }

  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) {
    throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY_BASE64 must decode to 32 bytes');
  }

  return key;
}

function encryptSecret(value) {
  if (!value) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion: getEncryptionKeyVersion(),
  };
}

function decryptSecret(record) {
  if (!record?.ciphertext || !record?.iv || !record?.tag) return null;

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(record.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}

function assertSocialTokenEncryptionConfig() {
  getEncryptionKey();
}

module.exports = {
  assertSocialTokenEncryptionConfig,
  decryptSecret,
  encryptSecret,
  getEncryptionKeyVersion,
};
