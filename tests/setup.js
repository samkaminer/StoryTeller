// Test setup file
require('dotenv').config();

// Helper: create a Firestore-like QuerySnapshot mock from an array of doc mocks
global.createMockSnapshot = (docs = []) => ({
  docs,
  empty: docs.length === 0,
  size: docs.length,
  forEach: (fn) => docs.forEach(fn),
});

// Helper: create a Firestore-like query chain stub that resolves to a snapshot
global.createMockQuery = (docs = []) => {
  const snap = global.createMockSnapshot(docs);
  const terminal = { get: jest.fn(() => Promise.resolve(snap)) };
  const withLimit = { limit: jest.fn(() => terminal) };
  const withOrderBy = { orderBy: jest.fn(() => withLimit) };
  const withWhere = {
    where: jest.fn(() => withWhere),
    orderBy: jest.fn(() => withLimit),
    get: jest.fn(() => Promise.resolve(snap)),
  };
  return { ...withWhere };
};

// Mock external services
jest.mock('firebase-admin', () => {
  const snap = (docs = []) => ({
    docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach: (fn) => docs.forEach(fn),
  });

  const mockFirestore = {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ exists: false, data: () => ({}) })),
        set: jest.fn(() => Promise.resolve()),
        update: jest.fn(() => Promise.resolve()),
        delete: jest.fn(() => Promise.resolve()),
        collection: jest.fn(() => ({
          doc: jest.fn(() => ({
            set: jest.fn(() => Promise.resolve()),
            update: jest.fn(() => Promise.resolve()),
            get: jest.fn(() => Promise.resolve({ exists: false, data: () => ({}) })),
          })),
          orderBy: jest.fn(() => ({
            get: jest.fn(() => Promise.resolve(snap()))
          })),
          where: jest.fn(function mockSubWhere() {
            return {
              where: mockSubWhere,
              get: jest.fn(() => Promise.resolve(snap())),
              orderBy: jest.fn(() => ({
                get: jest.fn(() => Promise.resolve(snap()))
              }))
            };
          })
        }))
      })),
      add: jest.fn(() => Promise.resolve({ id: 'mock-id' })),
      where: jest.fn(function mockWhere() {
        return {
          where: mockWhere,
          get: jest.fn(() => Promise.resolve(snap())),
          orderBy: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: jest.fn(() => Promise.resolve(snap()))
            }))
          }))
        };
      }),
      orderBy: jest.fn(() => ({
        limit: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve(snap()))
        }))
      }))
    }))
  };

  const mockFirestoreFn = jest.fn(() => mockFirestore);
  mockFirestoreFn.FieldValue = {
    serverTimestamp: jest.fn(() => new Date()),
    increment: jest.fn((n) => n),
    arrayUnion: jest.fn((...args) => args),
    arrayRemove: jest.fn((...args) => args),
  };

  return {
    initializeApp: jest.fn(),
    credential: {
      cert: jest.fn()
    },
    firestore: mockFirestoreFn,
    auth: jest.fn(() => ({
      verifyIdToken: jest.fn(() => Promise.resolve({ uid: 'test-uid', email: 'test@example.com' })),
      getUser: jest.fn(() => Promise.resolve({ uid: 'test-uid', email: 'test@example.com' }))
    }))
  };
});

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({
    bucket: jest.fn(() => ({
      exists: jest.fn(() => Promise.resolve([true])),
      getFiles: jest.fn(() => Promise.resolve([[]])),
      file: jest.fn(() => ({
        save: jest.fn(() => Promise.resolve()),
        createReadStream: jest.fn(() => {
          const { Readable } = require('stream');
          const stream = new Readable();
          stream.push('mock file content');
          stream.push(null);
          return stream;
        }),
        exists: jest.fn(() => Promise.resolve([true])),
        delete: jest.fn(() => Promise.resolve()),
        getSignedUrl: jest.fn(() => Promise.resolve(['https://signed-url.example.com/file'])),
        getMetadata: jest.fn(() => Promise.resolve([{ contentType: 'audio/mpeg', size: 1024 }])),
        createWriteStream: jest.fn(() => {
          const { Writable } = require('stream');
          const stream = new Writable({ write(chunk, encoding, cb) { cb(); } });
          setImmediate(() => stream.emit('finish'));
          return stream;
        }),
      }))
    }))
  }))
}));

jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn(() => Promise.resolve())
}));

jest.mock('stripe', () => {
  return jest.fn(() => ({
    customers: {
      create: jest.fn(() => Promise.resolve({ id: 'cus_mock' })),
      retrieve: jest.fn(() => Promise.resolve({ id: 'cus_mock' }))
    },
    subscriptions: {
      create: jest.fn(() => Promise.resolve({ id: 'sub_mock' })),
      retrieve: jest.fn(() => Promise.resolve({ id: 'sub_mock' }))
    },
    checkout: {
      sessions: {
        create: jest.fn(() => Promise.resolve({ url: 'https://checkout.stripe.com/mock' }))
      }
    },
    webhookEndpoints: {
      create: jest.fn(() => Promise.resolve({ secret: 'whsec_mock' }))
    }
  }));
});

jest.mock('@deepgram/sdk', () => ({
  Deepgram: jest.fn(() => ({
    transcription: {
      live: jest.fn(() => ({
        on: jest.fn(),
        send: jest.fn(),
        finish: jest.fn()
      }))
    }
  })),
  createClient: jest.fn(() => ({
    listen: {
      live: jest.fn(() => ({
        on: jest.fn(),
        send: jest.fn(),
        finish: jest.fn()
      }))
    }
  })),
  LiveTranscriptionEvents: {
    Transcript: 'transcript',
    Error: 'error',
    Close: 'close'
  }
}));

jest.mock('openai', () => {
  return jest.fn(() => ({
    chat: {
      completions: {
        create: jest.fn(() => Promise.resolve({
          choices: [{
            message: {
              content: 'Mock AI response'
            }
          }]
        }))
      }
    }
  }));
});

// Mock memory service
jest.mock('../memoryService', () => ({
  initialize: jest.fn(() => Promise.resolve()),
  add: jest.fn(() => Promise.resolve()),
  search: jest.fn(() => Promise.resolve([])),
  deleteAll: jest.fn(() => Promise.resolve()),
  isInitialized: jest.fn(() => true)
}));

// Mock pricing service
jest.mock('../pricingService', () => ({
  PricingService: jest.fn(() => ({
    checkUsageLimit: jest.fn(() => Promise.resolve({ allowed: true })),
    incrementUsage: jest.fn(() => Promise.resolve()),
    getUsageStats: jest.fn(() => Promise.resolve({ count: 0, limit: 100 })),
    getUserSubscription: jest.fn(() => Promise.resolve({ subscription: { plan: 'pro' } })),
    canCompleteInterview: jest.fn(() => Promise.resolve(true)),
    incrementInterviewUsage: jest.fn(() => Promise.resolve()),
    getPricingPlans: jest.fn(() => []),
    getFreeTrialLimit: jest.fn(() => 3),
    getUserFeatures: jest.fn(() => Promise.resolve({ features: [] })),
    createCheckoutSession: jest.fn(() => Promise.resolve({ url: 'https://checkout.stripe.com/test' })),
    handleSubscriptionSuccess: jest.fn(() => Promise.resolve()),
    handleInterviewPurchase: jest.fn(() => Promise.resolve()),
  }))
}));

// Set test environment variables
process.env.NODE_ENV = 'test';
// Provide mock credentials so Firebase and GCS initialize (giving tests real mock instances)
const mockServiceAccount = JSON.stringify({
  type: 'service_account', project_id: 'test-project', private_key_id: 'test-key-id',
  private_key: 'test-key', client_email: 'test@test-project.iam.gserviceaccount.com',
  client_id: '123', auth_uri: '', token_uri: '', auth_provider_x509_cert_url: '',
  client_x509_cert_url: ''
});
if (!process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  process.env.FIREBASE_SERVICE_ACCOUNT = mockServiceAccount;
}
if (!process.env.GOOGLE_CLOUD_CREDENTIALS && !process.env.GOOGLE_CLOUD_CREDENTIALS_BASE64) {
  process.env.GOOGLE_CLOUD_CREDENTIALS = mockServiceAccount;
}
process.env.OPENAI_API_KEY = 'test-key';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.DEEPGRAM_API_KEY = 'test-key';
process.env.SENDGRID_API_KEY = 'test-key';
process.env.STRIPE_SECRET_KEY = 'test-key';
process.env.BASE_URL = 'http://localhost:3001';

jest.mock('pdf-parse', () => jest.fn(() => Promise.resolve({ text: 'Extracted PDF text content from mock document for testing purposes' })));

jest.mock('mammoth', () => ({
  extractRawText: jest.fn(() => Promise.resolve({ value: 'Extracted Word document text content for testing purposes' }))
}));

// Increase test timeout for async operations
jest.setTimeout(30000);

// Suppress console logs during tests unless explicitly needed
global.console = {
  ...console,
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
};