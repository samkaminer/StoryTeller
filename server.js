// Initial startup logging
console.log('=== SERVER STARTUP INITIATED ===');
console.log(`Node version: ${process.version}`);
console.log(`Current directory: ${process.cwd()}`);
console.log(`Script location: ${__filename}`);
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

// Load environment variables from .env file
// Load .env.local if it exists (takes precedence over .env)
try {
  require('dotenv').config({ path: '.env.local' });
  console.log('.env.local loaded (if exists)');
} catch (e) {
  console.log('.env.local not found or error loading:', e.message);
}

try {
  require('dotenv').config();
  console.log('.env loaded (if exists)');
} catch (e) {
  console.log('.env not found or error loading:', e.message);
}

console.log('Environment variables loaded');
// Enhanced video generation with waveforms

// This server implements Anthropic's prompt caching best practices:
// - System instructions and static content are cached using cache_control: {"type": "ephemeral"}
// - For interviews: system instructions and conversation history are cached
// - For reports: the entire report prompt including context is cached
// - Claude 4 models: Cache has a 60-minute lifetime (TTL)
// - Older models: Cache has a 5-minute lifetime (TTL)
// - Cache is refreshed on each use, extending the TTL
// - Caching reduces costs by 90% for cached tokens and improves response times

// Load core modules with error handling
let express, cors, bodyParser, fetch, path, http, socketIo, multer, OpenAI, fs, os;
let pdfParse, mammoth, ffmpeg, ffmpegInstaller, ffprobeInstaller;
let Deepgram, createClient, LiveTranscriptionEvents;
let admin, uuidv4, Storage, sgMail;
let memoryService, stripe, PricingService, StreamingTTSService;
let extractTextFromFileBuffer, documentProcessing;
let buildPersonalizedReportPrompt;

// Load report generation module before try-catch
try {
  const reportGenModule = require('./server/utils/reportGeneration');
  buildPersonalizedReportPrompt = reportGenModule.buildPersonalizedReportPrompt;
  console.log('Report generation module loaded successfully');
  console.log('buildPersonalizedReportPrompt type:', typeof buildPersonalizedReportPrompt);
} catch (error) {
  console.error('CRITICAL: Failed to load report generation module:', error);
  process.exit(1); // Exit if we can't load this critical module
}

try {
  console.log('Loading core dependencies...');
  express = require('express');
  cors = require('cors');
  bodyParser = require('body-parser');
  fetch = require('node-fetch');
  path = require('path');
  http = require('http');
  socketIo = require('socket.io');
  multer = require('multer');
  OpenAI = require('openai');
  fs = require('fs');
  os = require('os');
  const { Readable } = require('stream');
  console.log('Core dependencies loaded');

  console.log('Loading file processing dependencies...');
  pdfParse = require('pdf-parse');
  mammoth = require('mammoth');
  console.log('File processing dependencies loaded');

  console.log('Loading FFmpeg dependencies...');
  ffmpeg = require('fluent-ffmpeg');
  ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  ffprobeInstaller = require('@ffprobe-installer/ffprobe');
  console.log('FFmpeg dependencies loaded');

  console.log('Loading Deepgram SDK...');
  const deepgramModule = require('@deepgram/sdk');
  Deepgram = deepgramModule.Deepgram;
  createClient = deepgramModule.createClient;
  LiveTranscriptionEvents = deepgramModule.LiveTranscriptionEvents;
  console.log('Deepgram SDK loaded');

  console.log('Loading Firebase admin...');
  admin = require('firebase-admin');
  const uuidModule = require('uuid');
  uuidv4 = uuidModule.v4;
  console.log('Firebase admin loaded');

  console.log('Loading Google Cloud Storage...');
  const gcsModule = require('@google-cloud/storage');
  Storage = gcsModule.Storage;
  console.log('Google Cloud Storage loaded');

  console.log('Loading SendGrid...');
  sgMail = require('@sendgrid/mail');
  if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    console.log('SendGrid loaded and configured');
  } else {
    console.log('SendGrid loaded but no API key configured');
  }

  console.log('Loading local modules...');
  memoryService = require('./memoryService');
  console.log('Memory service loaded');
  
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('Stripe loaded');
  } else {
    console.log('Stripe not loaded - no secret key');
  }
  
  const pricingModule = require('./pricingService');
  PricingService = pricingModule.PricingService;
  console.log('Pricing service loaded');
  
  StreamingTTSService = require('./server/utils/streamingTTS');
  console.log('Streaming TTS service loaded');
  
  // Load modular components
  const textExtractionModule = require('./server/utils/text-extraction');
  extractTextFromFileBuffer = textExtractionModule.extractTextFromFileBuffer;
  console.log('Text extraction utilities loaded');
  documentProcessing = require('./server/routes/document-processing');
  console.log('Document processing module loaded');

} catch (error) {
  console.error('CRITICAL ERROR loading dependencies:', error);
  console.error('Error type:', error.constructor.name);
  console.error('Error message:', error.message);
  console.error('Stack trace:', error.stack);
  process.exit(1);
}
// Add rate limiting for security
const rateLimiters = require('./server/middleware/rateLimiter');
const { SocketRateLimiter, socketLimits } = require('./server/middleware/socketRateLimiter');
const socketRateLimiter = new SocketRateLimiter();
// Add input validation
const { validators, handleValidationErrors } = require('./server/middleware/validation');
const { param } = require('express-validator');
const { validateAndSanitizeSocketEvent } = require('./server/middleware/socketValidation');
// Add authentication middleware
const { requireAuth, optionalAuth } = require('./server/middleware/auth');
// Add media processing queue
const { mediaQueue, reportVideoQueue, initialize: initializeMediaQueue } = require('./server/utils/mediaQueue');
// Add core interviewing techniques
const { assembleInterviewPrompt } = require('./server/prompts/core-interviewing-techniques');

// Add question generation utilities
const { 
    checkForPreviousInterviews, 
    buildMemoryContextString, 
    handleStaticFirstQuestion, 
    buildConversationHistory 
} = require('./server/utils/questionGeneration');

// Add video processing utilities
const { 
    createTextOverlayVideo, 
    createAudioVisualizationVideo, 
    handleAudioOnlyClip, 
    extractVideoSegment, 
    convertVideoToMP4, 
    stitchVideoFiles,
    levenshteinDistance,
    findBestSubsegment,
    parseReportAndPrepareAudioSegments,
    generateVideoFilesFromSegments,
    generateAndStoreReportVideo
} = require('./server/utils/video');


// REQUIRED ENVIRONMENT VARIABLES:
// SENDGRID_API_KEY - Your SendGrid API key for sending emails
// SENDGRID_FROM_EMAIL - The "from" email address (must be verified in SendGrid, defaults to admin@example.com)
// BASE_URL - The base URL of your application for generating report permalinks (defaults to http://localhost:3001)

// Initialize Firebase Admin SDK
let firebaseInitialized = false;
try {
  // Check if we're in a production environment or if service account is provided
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    // Use base64 encoded service account (more reliable for Railway)
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8');
    const serviceAccount = JSON.parse(decoded);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully using base64 environment credentials');
    firebaseInitialized = true;
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Use service account from environment variable (JSON string)
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully using environment credentials');
    firebaseInitialized = true;
  } else if (process.env.NODE_ENV !== 'production' && fs.existsSync('./firebase-service-account.local.json')) {
    // Only try local file in development
    const serviceAccount = require('./firebase-service-account.local.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully using local file');
    firebaseInitialized = true;
  } else {
    console.warn('WARNING: Firebase service account credentials not found');
    console.warn('To fix: Set FIREBASE_SERVICE_ACCOUNT environment variable with service account JSON');
    console.warn('Continuing without Firebase - custom interviews will not be available');
  }
} catch (error) {
  console.error('Error initializing Firebase Admin SDK:', error);
  console.error('Error details:', error.message);
  // Continue without Firebase if initialization fails
  console.warn('Continuing without Firebase - custom interviews will not be available');
}

// Reference to Firestore
const db = firebaseInitialized && admin.firestore ? admin.firestore() : null;

// System prompt for report generation (text-only)
const REPORT_GENERATION_SYSTEM_PROMPT = `You are a world-class writer who expertly synthesizes the interviewee's answers into a coherent, engaging report.

IMPORTANT RULES:
- Ensure your report contains direct quotes from the interviewee
- Do not ever attribute quotes to the interviewee that were not directly quoted in the response
- Weave quotes into a coherent narrative with analysis
- You can trim quotes on both sides, and in the middle with ellipses...
- You can edit quotes to remove filler words like "um" and "uh" and "like" and "you know"
- You can correct obvious typos, mistranscriptions, and grammatical errors
- Aim to achieve 50/50 human quotes and AI analysis
- Use markdown formatting to enhance readability (headers, bold, italics, lists, etc.)

Ensure you return your response in <individual_summary_report> tags`;

// REPORT_GENERATION_SYSTEM_PROMPT removed - no longer needed since all reports are text-only

// Initialize Google Cloud Storage
let storage;
let GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'prompter-media';

try {
  if (process.env.GOOGLE_CLOUD_CREDENTIALS_BASE64) {
    // Use base64 encoded credentials (more reliable for Railway)
    const decoded = Buffer.from(process.env.GOOGLE_CLOUD_CREDENTIALS_BASE64, 'base64').toString('utf-8');
    const credentials = JSON.parse(decoded);
    storage = new Storage({ credentials });
    console.log('Google Cloud Storage initialized successfully using base64 environment credentials');
  } else if (process.env.GOOGLE_CLOUD_CREDENTIALS) {
    // Use credentials from environment variable
    const credentials = JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS);
    storage = new Storage({ credentials });
    console.log('Google Cloud Storage initialized successfully using environment credentials');
  } else if (process.env.NODE_ENV !== 'production' && fs.existsSync('google-cloud-credentials.local.json')) {
    // Only try local file in development
    const credentials = JSON.parse(fs.readFileSync('google-cloud-credentials.local.json'));
    storage = new Storage({ credentials });
    console.log('Google Cloud Storage initialized successfully using local file');
  } else {
    console.warn('WARNING: Google Cloud Storage credentials not found - audio/video storage will not work');
    console.warn('To fix: Set GOOGLE_CLOUD_CREDENTIALS environment variable with service account JSON');
    // Continue without GCS - interviews can still run but audio/video won't be stored
    storage = null;
  }
} catch (error) {
  console.error('Error initializing Google Cloud Storage:', error);
  console.error('Continuing without GCS - audio/video storage will not work');
  storage = null;
}


// Once db is initialized, ensure indexes
if (db) {
  // Ensure necessary indexes exist
  ensureFirebaseIndexes().catch(err => {
    console.error('Error ensuring Firebase indexes:', err);
  });
}

// Initialize memory service
memoryService.initialize().catch(err => {
  console.error('Error initializing memory service:', err);
  // Continue without memory service if initialization fails
  console.warn('Continuing without memory service - interview memories will not be available');
});

// Initialize pricing service
let pricingService = null;
if (db && stripe) {
  pricingService = new PricingService(db, stripe);
  console.log('Pricing service initialized successfully');
} else {
  console.warn('Pricing service not initialized - missing database or Stripe configuration');
}

// Media queue will be initialized after OpenAI client is created

// Configure FFmpeg with newer version if available
const { configureFFmpeg } = require('./server/config/ffmpeg');
const ffmpegConfig = configureFFmpeg();
console.log(`FFmpeg configured: version ${ffmpegConfig.version}, path: ${ffmpegConfig.ffmpegPath}`);

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = socketIo(server, {
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB limit for socket uploads
  pingTimeout: 60000, // Increase ping timeout to 60 seconds
  pingInterval: 25000, // Increase ping interval to 25 seconds
  connectTimeout: 45000, // Connection timeout
  allowEIO3: true, // Allow compatibility with older clients
  cors: {
    origin: process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "*",
    methods: ["GET", "POST"]
  }
});

// Make io globally accessible for other modules (e.g., mediaQueue)
global.io = io;

// Use PORT from environment variable or default to 3001
const PORT = process.env.PORT || 3001;

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf', 
      'application/msword', 
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',  // Text files
      'text/markdown', // Markdown files
      'text/csv', // CSV files
      'application/json', // JSON files
      'application/xml', // XML files
      'text/xml', // XML files
      'image/png', // Images
      'image/jpeg',
      'image/jpg',
      'image/gif',
      'image/webp',
      'image/svg+xml'
    ];
    
    // Check both explicit types and general categories
    if (allowedTypes.includes(file.mimetype) || 
        file.mimetype.startsWith('text/') || 
        file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Supported types: PDF, Word, Text, Images (PNG, JPG, GIF, WebP, SVG), CSV, JSON, XML, and Markdown files.'));
    }
  }
});

// Configure multer for media uploads (audio/video recordings)
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB limit for video files
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'audio/webm',
      'video/webm',
      'audio/mp4',
      'video/mp4',
      'audio/mpeg',
      'audio/wav'
    ];
    if (allowedTypes.includes(file.mimetype) || file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only audio and video files are allowed.'));
    }
  }
});

// Middleware
app.use(cors({
  origin: '*', // Allow all origins for testing
  methods: ['GET', 'POST', 'DELETE', 'PUT'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
  credentials: true
}));

// Add session support for testing
const session = require('express-session');
app.use(session({
  secret: process.env.SESSION_SECRET || 'test-secret-for-development',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true in production with HTTPS
}));

// Apply body parsing to all routes EXCEPT Stripe webhook
app.use((req, res, next) => {
  if (req.path === '/api/webhooks/stripe') {
    next();
  } else {
    bodyParser.json({ limit: '50mb' })(req, res, next);
  }
});

// Health check endpoint for deployment verification
app.get('/health', (req, res) => {
  const status = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      firebase: db ? 'connected' : 'not connected',
      storage: storage ? 'connected' : 'not connected',
      sendgrid: process.env.SENDGRID_API_KEY ? 'configured' : 'not configured',
      stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'not configured',
      memory: memoryService ? 'available' : 'not available',
    },
    apiKeys: {
      claude: !!CLAUDE_API_KEY,
      openai: !!OPENAI_API_KEY,
      deepgram: !!DEEPGRAM_API_KEY,
      sendgrid: !!SENDGRID_API_KEY,
    },
    environment: {
      nodeEnv: process.env.NODE_ENV || 'development',
      port: PORT,
      baseUrl: process.env.BASE_URL || 'not set',
    }
  };
  
  res.json(status);
});

// Redirect old interview links to new /i path
app.get('/index.html', (req, res, next) => {
  if (req.query && req.query.interview) {
    const query = new URLSearchParams(req.query).toString();
    return res.redirect(302, `/i/index.html?${query}`);
  }
  next();
});

// Soft password gate on the Convent Vision Alignment brief.
// - GET /convent (or /convent.html) without the unlock cookie → magazine-styled
//   password form (200, no native Basic Auth prompt).
// - POST with correct password → set cookie + 303 redirect to /convent.
// - POST with wrong password → re-show the form with an error.
// - Cookie present → call next() and let express.static / the GET /convent
//   route serve the actual brief.
// The transcripts JSON and the /api/analyst-videos redirect stay open so
// agents can fetch them without re-prompting humans.
const CONVENT_PASSWORD = 'soups';
const CONVENT_COOKIE = 'convent_unlocked';
const CONVENT_COOKIE_VALUE = '1';

function isConventUnlocked(req) {
    const cookies = (req.headers.cookie || '').split(';');
    for (const c of cookies) {
        if (c.trim() === `${CONVENT_COOKIE}=${CONVENT_COOKIE_VALUE}`) return true;
    }
    return false;
}

function conventGateHtml(showError) {
    const errorMarkup = showError ? '<p class="gate-error">Wrong password.</p>' : '';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Convent Vision Alignment</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300..800;1,6..72,300..800&family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, rgba(176,58,34,0.04), transparent 35%),
        #f1ead7;
      color: #14110d;
      font-family: "Space Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      display: grid;
      place-items: center;
      padding: 40px 24px;
    }
    .gate { max-width: 460px; width: 100%; text-align: center; }
    .gate-seal {
      width: 56px; height: 56px;
      margin: 0 auto 28px;
      display: grid; place-items: center;
      border: 1px solid #14110d;
      font-family: "Newsreader", ui-serif, Georgia, serif;
      font-size: 30px;
      line-height: 1;
    }
    .gate-eyebrow {
      margin: 0 0 14px;
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
      font-size: 10.5px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: #7a7062;
    }
    .gate h1 {
      font-family: "Newsreader", ui-serif, Georgia, serif;
      font-variation-settings: "opsz" 60;
      font-weight: 400;
      font-size: clamp(38px, 5.6vw, 56px);
      line-height: 0.98;
      letter-spacing: -0.02em;
      margin: 0 0 14px;
    }
    .gate h1 em { font-style: italic; font-weight: 300; color: #b03a22; }
    .gate-sub {
      margin: 0 0 32px;
      color: #3a342c;
      font-family: "Newsreader", ui-serif, Georgia, serif;
      font-style: italic;
      font-size: 18px;
      line-height: 1.45;
    }
    form { display: grid; gap: 10px; text-align: left; }
    label {
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 10.5px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: #7a7062;
    }
    input[type=password] {
      width: 100%;
      padding: 14px 16px;
      font-family: "Newsreader", ui-serif, Georgia, serif;
      font-size: 18px;
      border: 1px solid #14110d;
      background: #fffdf7;
      color: #14110d;
      border-radius: 0;
      appearance: none;
    }
    input[type=password]:focus { outline: 2px solid #b03a22; outline-offset: 2px; }
    button {
      margin-top: 8px;
      padding: 14px 16px;
      border: 1px solid #14110d;
      background: #14110d;
      color: #f1ead7;
      font-family: "Space Grotesk", sans-serif;
      font-weight: 600;
      font-size: 13px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
    }
    button:hover { background: #b03a22; border-color: #b03a22; transform: translateY(-1px); }
    .gate-error {
      margin: 16px 0 0;
      color: #b03a22;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      text-align: center;
    }
    .gate-foot {
      margin-top: 44px;
      padding-top: 22px;
      border-top: 1px solid rgba(20,17,13,0.18);
      color: #7a7062;
      font-family: "JetBrains Mono", monospace;
      font-size: 10.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <main class="gate">
    <div class="gate-seal" aria-hidden="true">C</div>
    <p class="gate-eyebrow">Internal Listening Brief · Issue No. I</p>
    <h1>Convent <em>Vision</em> Alignment</h1>
    <p class="gate-sub">A read from inside the room. Enter the password to continue.</p>
    <form method="POST" action="/convent">
      <label for="convent-password">Password</label>
      <input id="convent-password" name="password" type="password" autocomplete="off" autofocus required>
      <button type="submit">Enter</button>
    </form>
    ${errorMarkup}
    <p class="gate-foot">Greenpoint, Brooklyn · May MMXXVI</p>
  </main>
</body>
</html>`;
}

const conventGateBody = express.urlencoded({ extended: false, limit: '2kb' });
app.use(['/convent', '/convent.html'], conventGateBody, (req, res, next) => {
    if (isConventUnlocked(req)) return next();

    if (req.method === 'POST' && req.body && req.body.password === CONVENT_PASSWORD) {
        res.setHeader('Set-Cookie',
            `${CONVENT_COOKIE}=${CONVENT_COOKIE_VALUE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
        return res.redirect(303, '/convent');
    }

    const showError = req.method === 'POST';
    return res.status(showError ? 401 : 200).type('html').send(conventGateHtml(showError));
});

app.use(express.static(path.join(__dirname, 'public')));

// Apply general API rate limiting
app.use('/api/', rateLimiters.api);

// Mount modular routes
app.use('/api/gmail', require('./server/routes/gmail-oauth'));
app.use('/api/campaigns', require('./server/routes/campaigns'));
app.use('/api/context-strings', require('./server/routes/context-strings'));

// Initialize email service
const EmailService = require('./server/services/email-service');

// Serve interview app directory with dynamic meta tags
app.get('/i', async (req, res) => {
    const interviewId = req.query.interview;
    
    // Default meta tags
    let metaTitle = 'Personal AI Readiness Report (PAIRR)';
    let metaDescription = 'Answer a few voice-based questions to understand your skills and experience in the context of an AI-transformed workplace.';
    let metaImage = `${req.protocol}://${req.get('host')}/saylogo.png`;
    
    // If interview ID is provided, try to fetch interview details
    if (interviewId && db) {
        try {
            const interviewDoc = await db.collection('interviews').doc(interviewId).get();
            if (interviewDoc.exists) {
                const interview = interviewDoc.data();
                
                // Customize meta tags based on interview data
                if (interview.introTextHeading) {
                    metaTitle = interview.introTextHeading;
                } else if (interview.templateName) {
                    metaTitle = interview.templateName;
                }
                
                if (interview.introTextSubheading) {
                    metaDescription = interview.introTextSubheading;
                } else if (interview.templateDescription) {
                    metaDescription = interview.templateDescription;
                }
                
                // Add creator info if available
                if (interview.adminName) {
                    metaDescription += ` Created by ${interview.adminName}`;
                    if (interview.adminOrganization) {
                        metaDescription += ` from ${interview.adminOrganization}`;
                    }
                }
                
                // Escape HTML entities for safe injection
                metaTitle = metaTitle.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                metaDescription = metaDescription.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }
        } catch (error) {
            console.error('Error fetching interview for meta tags:', error);
            // Continue with default meta tags
        }
    }
    
    // Read the original HTML file
    const htmlPath = path.join(__dirname, 'public', 'i', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    
    // Inject Open Graph and Twitter Card meta tags in the <head> section
    const metaTags = `
    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="${req.protocol}://${req.get('host')}/i/?interview=${interviewId || ''}">
    <meta property="og:title" content="${metaTitle}">
    <meta property="og:description" content="${metaDescription}">
    <meta property="og:image" content="${metaImage}">
    
    <!-- Twitter -->
    <meta property="twitter:card" content="summary_large_image">
    <meta property="twitter:url" content="${req.protocol}://${req.get('host')}/i/?interview=${interviewId || ''}">
    <meta property="twitter:title" content="${metaTitle}">
    <meta property="twitter:description" content="${metaDescription}">
    <meta property="twitter:image" content="${metaImage}">
    
    <!-- WhatsApp Preview -->
    <meta property="og:site_name" content="Say - AI Interview Platform">
    <meta property="og:locale" content="en_US">`;
    
    // Update the title tag as well
    html = html.replace('<title>Personal AI Readiness Report (PAIRR)</title>', 
                       `<title>${metaTitle}</title>`);
    
    // Inject meta tags right before the closing </head> tag
    html = html.replace('</head>', `${metaTags}\n</head>`);
    
    res.send(html);
});

// Serve report.html for the /report route
app.get('/report.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'report.html'));
});

// New route for the interview special report page
app.get('/i/:interviewId/report-summary', (req, res) => {
    // The actual interviewId will be extracted client-side from the URL
    res.sendFile(path.join(__dirname, 'public', 'interview-report-summary.html'));
});

// Subscription pages
app.get('/subscription-success', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'subscription-success.html'));
});

app.get('/subscription-cancel', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'subscription-cancel.html'));
});

// Interview purchase pages
app.get('/interview-purchase-success', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'interview-purchase-success.html'));
});

app.get('/interview-purchase-cancel', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'interview-purchase-cancel.html'));
});

// API Keys from environment variables
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Log API key status (without exposing the actual keys)
console.log('API Keys Status:');
console.log(`- CLAUDE_API_KEY: ${CLAUDE_API_KEY ? '✓ Set' : '✗ Missing'}`);
console.log(`- OPENAI_API_KEY: ${OPENAI_API_KEY ? '✓ Set' : '✗ Missing'}`);
console.log(`- DEEPGRAM_API_KEY: ${DEEPGRAM_API_KEY ? '✓ Set' : '✗ Missing'}`);

// Warn about critical missing keys
if (!CLAUDE_API_KEY) {
  console.error('CRITICAL: CLAUDE_API_KEY is not set - interview generation will fail');
}
if (!OPENAI_API_KEY) {
  console.error('CRITICAL: OPENAI_API_KEY is not set - text-to-speech will fail');
}
if (!DEEPGRAM_API_KEY) {
  console.error('CRITICAL: DEEPGRAM_API_KEY is not set - speech-to-text will fail');
}

// Initialize SendGrid client (EmailService will handle both SendGrid and Gmail)
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

console.log(`- SENDGRID_API_KEY: ${SENDGRID_API_KEY ? '✓ Set' : '✗ Missing'}`);
console.log(`- GMAIL_CLIENT_ID: ${process.env.GMAIL_CLIENT_ID ? '✓ Set' : '✗ Missing (optional)'}`);
console.log(`- STRIPE_SECRET_KEY: ${process.env.STRIPE_SECRET_KEY ? '✓ Set' : '✗ Missing'}`);
console.log(`- MEM0_API_KEY: ${process.env.MEM0_API_KEY ? '✓ Set' : '✗ Missing (optional)'}`);
console.log(`- BASE_URL: ${process.env.BASE_URL || 'Using default'}`);
console.log(`- PORT: ${PORT}`);
if (SENDGRID_API_KEY) {
    sgMail.setApiKey(SENDGRID_API_KEY);
    console.log('SendGrid client initialized successfully');
} else {
    console.warn('SENDGRID_API_KEY not found. Email will use Gmail if configured per user.');
}

if (!CLAUDE_API_KEY || !OPENAI_API_KEY) {
    console.error('Missing required API keys. Please set CLAUDE_API_KEY and OPENAI_API_KEY environment variables.');
    process.exit(1);
}
if (!DEEPGRAM_API_KEY || DEEPGRAM_API_KEY === "YOUR_DEEPGRAM_API_KEY_HERE") {
    console.warn('DEEPGRAM_API_KEY not set - voice/speech features will be disabled.');
}

// Initialize Deepgram client (optional - only if key is set)
const deepgramClient = DEEPGRAM_API_KEY ? createClient(DEEPGRAM_API_KEY) : null;

// Store interview data at server level for persistence across socket connections
const sessionData = new Map(); // Using Map to store session-specific data

// Streaming TTS service instance (will be initialized after OpenAI)
let streamingTTS;

// Initialize OpenAI client with longer timeout
console.log('Initializing OpenAI client with API key:', OPENAI_API_KEY ? `${OPENAI_API_KEY.substring(0, 10)}...` : 'MISSING API KEY');
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  timeout: 300000, // 5 minute timeout for API calls
  maxRetries: 3 // Add retries for transient errors
});

// Initialize streaming TTS service with OpenAI client
streamingTTS = new StreamingTTSService(openai);

// Initialize media queue now that OpenAI is available
if (admin && storage && GCS_BUCKET_NAME && openai) {
  const videoModule = require('./server/utils/video');
  initializeMediaQueue(admin, storage, GCS_BUCKET_NAME, openai, videoModule);
  console.log('Media queue initialized successfully with video module');
} else {
  console.warn('Media queue not initialized - missing components:');
  console.warn(`  - Firebase admin: ${admin ? 'available' : 'MISSING'}`);
  console.warn(`  - Google Cloud Storage: ${storage ? 'available' : 'MISSING'}`);
  console.warn(`  - GCS bucket name: ${GCS_BUCKET_NAME ? GCS_BUCKET_NAME : 'MISSING'}`);
  console.warn(`  - OpenAI client: ${openai ? 'available' : 'MISSING'}`);
}

// Verify OpenAI client is working by logging version
console.log('OpenAI client initialized successfully');

// Interview system prompts - separated into initial and follow-up versions
const INITIAL_INTERVIEW_PROMPT = `Here is a corpus of information about the user:

<user_corpus>
{{CONTEXT}}
</user_corpus>

Specifically referencing a key detail in the corpus, get the user to tell a specific story that reveals how they feel about artificial intelligence. Do not directly confront the user with their replacement by AI or ask how they feel about machines that can do their job.

Be concise. Less is more. Do not ask compound questions, where one clause is separated from another by a comma. Ask only one question.

Use your thinking trace to review what you know about the user and which detail is most likely to reveal their feelings about artificial intelligence.

Respond with only the question and nothing else.`;

const FOLLOWUP_INTERVIEW_PROMPT = `Here is a corpus of information about the user:

<user_corpus>
{{CONTEXT}}
</user_corpus>

This is the middle of a multi-turn conversation where you are attempting to learn more about the user. Given their resume and the conversation history, ask a followup question designed to get them to talk for as long as possible about their relationship with new technology.

IT IS EXTREMELY IMPORTANT THAT YOUR QUESTION FEELS LIKE A NATURAL FOLLOWUP TO THE PREVIOUS QUESTION AND DOES NOT FOLLOW THE SAME EXACT SYNTAX OR PATTERN.

Be concise. Less is more. Do not ask compound questions, where one clause is separated from another by a comma.

Do not ask abstract questions. Ask questions that elicit stories, facts, and details.

Use your thinking trace to keep track of what you know about the user and what you don't know, and what you believe will get them to talk for the longest, including planning phrasing that feels natural and conversational.

If you are unsure about what the user just said, or need more information, just ask. Know when to follow up and when to move on.

Respond with only the question and nothing else.`;

// Function to count words
function countWords(text) {
    if (!text || typeof text !== 'string') return 0;
    return text.trim().split(/\s+/).filter(Boolean).length;
}

// Assembles a transcript string from Deepgram word objects, inserting [pause] and
// [long pause] markers wherever the gap between adjacent words exceeds a threshold.
// This gives Claude visibility into meaningful silences — a pause before a word signals
// weight; clustered pauses signal a lull; a long pause after charged content signals
// emotional labor.
function assembleTranscriptWithPauses(words) {
    if (!words || words.length === 0) return '';

    const PAUSE_THRESHOLD = 1.5;       // seconds — meaningful conversational pause
    const LONG_PAUSE_THRESHOLD = 2.5;  // seconds — emotional or significant pause

    let transcript = words[0].punctuated_word || words[0].word || '';

    for (let i = 1; i < words.length; i++) {
        const gap = words[i].start - words[i - 1].end;

        if (gap >= LONG_PAUSE_THRESHOLD) {
            transcript += ' [long pause]';
        } else if (gap >= PAUSE_THRESHOLD) {
            transcript += ' [pause]';
        }

        transcript += ' ' + (words[i].punctuated_word || words[i].word || '');
    }

    return transcript;
}

// --- START Example Data ---
const EXAMPLE_RESUME = `Sarah Bennett
 📍 Nashville, TN | 📞 (555) 123-4567 | ✉️ sarah.bennett@email.com | 💼 LinkedIn.com/in/sarahbmarketing

Professional Summary
Strategic and passionate Marketing Manager with 15+ years of experience driving brand growth, customer engagement, and revenue through innovative campaigns and cross-functional leadership. Known for creative problem-solving, multitasking under pressure, and building high-performing teams. Adept at managing multiple projects and stakeholders, though currently seeking better balance between professional excellence and personal well-being.

Core Competencies
Strategic Marketing Planning

Team Leadership & Mentoring

Integrated Campaign Development

Budget Management

Digital Marketing & SEO

Brand Management

CRM & Email Marketing

Data Analysis & Reporting

Time Management (…working on it!)

Professional Experience
Marketing Manager
 BrightPoint Solutions, Nashville, TN
 2015 – Present
Lead a team of 7 in developing and executing integrated marketing strategies across digital and traditional platforms.

Increased qualified lead generation by 38% through targeted content strategy and marketing automation.

Collaborate cross-functionally with Sales, Product, and Customer Success teams to align messaging and goals.

Manage a $500K annual budget, optimizing spend for maximum ROI.

Spearheaded rebranding initiative that boosted customer retention by 22%.

Known as the "go-to" person for urgent tasks and last-minute fixes (…sometimes to a fault).

Recently juggling 60+ emails/day and multiple overlapping deadlines—actively working on sustainable systems to restore balance.

Senior Marketing Specialist
 UrbanTech Media, Atlanta, GA
 2010 – 2015
Developed B2B campaigns that increased website traffic by 45% and supported national account growth.

Oversaw trade show and event marketing, coordinating logistics, branding, and promotional materials.

Mentored junior team members, many of whom were promoted to managerial roles.

Often volunteered for after-hours tasks, demonstrating dedication—though now learning to set healthier boundaries.

Marketing Coordinator
 Vibe Communications, Charlotte, NC
 2005 – 2010
Created social media content calendars and managed vendor relationships.

Assisted in launching two award-winning campaigns for regional clients.

Supported senior marketers in data tracking and campaign analysis.

Education
B.A. in Communications & Marketing
 University of North Carolina, Chapel Hill
 Graduated 2005

Certifications & Skills
Google Ads Certified

HubSpot Inbound Marketing

Adobe Creative Suite

Project Management Tools: Asana, Trello, Slack

Volunteer Work
PTA Marketing Chair – Local Elementary School
 Social Media Manager – Women in Business Nashville Chapter

Personal Note
While I'm proud of my professional accomplishments, I'm currently exploring strategies to rebalance my workload and strengthen my mental well-being. I believe in doing great work without burning out—and I'm learning that productivity and peace can (and should) go hand in hand.
`;

const EXAMPLE_QA = [
    {
        question: "Your resume mentions you've spearheaded a rebranding initiative that boosted customer retention by 22%. Could you tell me the story behind that project?",
        answer: "That rebranding project was definitely a career highlight. The biggest challenge was that we were dealing with a 20-year-old brand that had strong recognition but was starting to feel outdated. Some executives were resistant to change, worried we'd lose brand equity. I had to build consensus by presenting market research showing how our competitors were evolving while we stayed static. I created a phased approach rather than a complete overnight change, which helped ease the transition. We started with refreshing our digital presence, then gradually rolled out new messaging, updated our visual identity, and finally launched a major campaign around our new positioning. The key was balancing between honoring our history while making the brand relevant for today's market. What made it successful was involving stakeholders from different departments early on, especially customer success teams who had direct feedback from clients. Seeing that 22% increase in retention validated all the late nights and heated discussions!"
    },
    {
        question: "Those late nights you mentioned - I noticed you also mentioned in your resume that you're seeking better balance between professional excellence and personal well-being. What's driving that search for balance right now?",
        answer: "It's become increasingly unsustainable. I'm currently juggling 60+ emails daily and multiple overlapping deadlines. I've always been known as the 'go-to person' for urgent tasks, which was initially flattering but has become overwhelming. After those long days managing crises and putting out fires, I come home completely drained. I barely have energy for my family, and I find myself answering emails at 11 PM instead of being present with my husband. To be honest, I also feel unsupported at home - the mental load of managing our household and schedules falls mostly on me, which compounds the work stress. My sleep is suffering, I've had some health issues flare up, and I recently missed my daughter's soccer tournament because of a last-minute work emergency. That was a wake-up call that something needs to change."
    },
    {
        question: "That sounds incredibly challenging, juggling both work demands and home responsibilities. What specific strategies have you started implementing to create more sustainable systems in both areas?",
        answer: "I'm still very much a work in progress with this, but I've started implementing some changes that are helping. First, I've created email filters and templates for common requests, which saves me at least an hour daily. I've also started blocking focused work time on my calendar where I'm actually turning off notifications completely. That was really hard at first—I kept worrying I was missing something urgent. The biggest change has been learning to delegate more effectively. I realized I was creating a bottleneck by wanting to approve everything from my team. Now I've established clearer guidelines for what decisions they can make independently, which has been liberating for all of us. I'm experimenting with a technique where I only check emails three times a day instead of constantly. And honestly, the hardest but most important thing I'm working on is setting boundaries at home too—creating dedicated family time where work devices stay in another room. My husband and I are having more conversations about sharing household responsibilities more evenly. Some days are better than others, but I'm starting to see that the world doesn't fall apart if I'm not immediately responsive 24/7."
    },
    {
        question: "I love that you're working on delegation - that's so important. Speaking of developing others, I see you've mentored several team members who advanced to managerial roles. Could you share how your own leadership approach has evolved as you've focused more on sustainability?",
        answer: "My leadership approach has done a complete 180 over the years. When I first became a manager, I thought leading meant having all the answers and being available 24/7. I unintentionally created a culture where my team felt they needed to match my unhealthy work habits. Now I realize that was more about my insecurity as a leader than actual effectiveness. Today, I'm much more focused on outcomes rather than hours worked. I've become explicit about not expecting email responses after hours or on weekends, and I model this by using email scheduling tools to send my own non-urgent messages during business hours, even if I'm working late. I've instituted 'Focus Fridays' where we block the afternoon for deep work without meetings. We've also created a more collaborative planning process where the team helps set realistic timelines for projects, building in buffer time for unexpected issues. One practice that's been particularly effective is what we call 'success sharing'—highlighting team members who found smart, efficient ways to achieve goals, not just those who put in the most hours. Has it affected our results? Actually, our performance metrics have improved. Our team's creative output is stronger, we're retaining talent better, and people seem more engaged. The biggest challenge has been managing upward—helping more traditional executives understand that sustainable pace leads to better long-term results than burnout-inducing sprints. I'm not perfect at this balance yet, but I'm committed to creating an environment where people can do their best work without sacrificing their wellbeing."
    },
    {
        question: "That's fascinating how better boundaries have actually improved results. Can you tell me about a specific mentoring relationship where you helped someone develop while also encouraging healthier work patterns?",
        answer: "There's one relationship that really stands out. When I was at UrbanTech, we hired this young woman named Kelsey right out of college. She was incredibly bright but also very quiet and hesitant to share her ideas in meetings. I noticed that in one-on-one settings, she had these brilliant creative concepts, but they never made it to the broader team. Instead of just telling her to speak up more—which rarely works—I started creating specific opportunities for her to present in smaller settings. I'd ask her to lead portions of internal meetings first, then gradually client-facing ones. We would prep together, and I'd give her feedback. What really changed things was when I asked her to lead a pitch for a smaller client. She knocked it out of the park, and that success gave her the confidence boost she needed. Within two years, she was managing her own team and accounts. But here's the thing - I also noticed she was adopting my old habits of working until 9 PM every night and never taking breaks. So I started deliberately scheduling our check-ins during normal hours, talking openly about how I was learning to prioritize and set boundaries, and asking about her interests outside of work. I made a point of acknowledging her accomplishments without tying them to the excessive hours. Watching her develop into a confident leader who also maintains healthy boundaries has been incredibly rewarding. She's now a marketing director at a great company in Atlanta, and we still check in regularly. She recently told me that the most valuable thing she learned from me wasn't the marketing strategies but the permission to be ambitious without sacrificing her wellbeing."
    },
    {
        question: "It's powerful how you're redefining success beyond just the marketing metrics. Can you tell me about a specific mentoring relationship where you helped someone develop while also encouraging healthier work patterns?",
        answer: "There's one relationship that really stands out. When I was at UrbanTech, we hired this young woman named Kelsey right out of college. She was incredibly bright but also very quiet and hesitant to share her ideas in meetings. I noticed that in one-on-one settings, she had these brilliant creative concepts, but they never made it to the broader team. Instead of just telling her to speak up more—which rarely works—I started creating specific opportunities for her to present in smaller settings. I'd ask her to lead portions of internal meetings first, then gradually client-facing ones. We would prep together, and I'd give her feedback. What really changed things was when I asked her to lead a pitch for a smaller client. She knocked it out of the park, and that success gave her the confidence boost she needed. Within two years, she was managing her own team and accounts. But here's the thing - I also noticed she was adopting my old habits of working until 9 PM every night and never taking breaks. So I started deliberately scheduling our check-ins during normal hours, talking openly about how I was learning to prioritize and set boundaries, and asking about her interests outside of work. I made a point of acknowledging her accomplishments without tying them to the excessive hours. Watching her develop into a confident leader who also maintains healthy boundaries has been incredibly rewarding. She's now a marketing director at a great company in Atlanta, and we still check in regularly. She recently told me that the most valuable thing she learned from me wasn't the marketing strategies but the permission to be ambitious without sacrificing her wellbeing."
    },
    {
        question: "It's powerful how you're redefining success beyond just the marketing metrics. Speaking of change, you've navigated significant shifts in marketing over your 15+ year career. What do you see as the next major transformation that marketers need to prepare for?",
        answer: "Everyone's talking about AI in marketing, but honestly, I think we're heading down a dangerous path. I've spent my career believing in the human element of marketing - the intuition, creativity, and emotional intelligence that no algorithm can replicate. This AI push feels like another tech fad that sacrifices what makes marketing special. At BrightPoint, I've been actively resisting the pressure to adopt these systems. I still maintain a physical idea board with sticky notes and magazine clippings for inspiration - my team laughs, but those tactile brainstorming sessions produce our best ideas. I've seen too many companies chase technology only to lose their soul in the process. Remember when everyone rushed to automate social media posts? That was a disaster for authentic engagement. I'm deeply concerned about what happens to creative professionals when companies replace them with chatbots. My best campaigns have always come from human connection - actually talking to customers face-to-face, not analyzing algorithmic patterns. Last month, our competitor released an AI-generated campaign that was technically flawless but completely soulless. I keep a file folder - yes, an actual manila folder - of these 'AI fails' to remind my team why human judgment matters. The marketers who will thrive are those who protect and champion what makes us human, not those who surrender to silicon overlords. I worry we're creating a world where marketing loses its heart. My assistant keeps trying to get me to use digital calendar apps, but my paper planner has never crashed or needed a software update."
    },
    {
        question: "That's an insightful perspective on AI. Have you found any ways that technology might actually help with the work-life balance challenges you mentioned earlier?",
        answer: "Not really, and I think that's another tech industry myth we need to stop perpetuating. Every 'time-saving' technology I've encountered has actually made my work-life balance worse, not better. Remember when email was supposed to make communication more efficient? Now we're all drowning in 24/7 messages. I've actively removed most apps from my phone because each notification was another intrusion into my personal time. My most successful strategy has been implementing 'analog Fridays' where our team uses no digital tools - just paper, conversations, and actual human connection. Those are consistently our most productive and creative days. The tech evangelists might mock me, but I still print important documents to review them properly - I catch errors on paper that I miss on screens. I've banned laptops from half our meetings because people were hiding behind screens instead of engaging. I have a strict no-devices rule at my dinner table, and my family reconnected in ways I never expected. Look, my colleague installed some AI email management system and spent three weekends troubleshooting it. Meanwhile, I developed a simple folder system and trained my assistant on how to prioritize messages. The real solutions to work-life balance are human ones: having honest conversations with my boss about workload, teaching my team clear communication, and actually talking to my husband about sharing household responsibilities. The most freeing decision I made was turning off my work email on my personal phone. Everyone panicked, but guess what? No emergencies went unaddressed. I keep a landline at home that only family has the number to. My kids joke that I'm stuck in the 90s, but I sleep better now than I have in years. Technology promises convenience but delivers dependency."
    },
    {
        question: "Looking back at your career journey and the challenges you've navigated, what do you wish you had known earlier that might help other marketing professionals avoid the burnout path?",
        answer: "I wish I had understood earlier that marketing effectiveness isn't about perfectionism or constant availability—it's about strategic focus and sustainable effort. I spent years trying to do everything perfectly, answering emails at midnight, and making myself available for every crisis. I thought that's what commitment looked like. But that approach led to diminishing returns and nearly burned me out multiple times. What I've learned is that marketing is a marathon, not a sprint. The most valuable thing I can offer as a marketer isn't my willingness to work 24/7—it's my clear thinking, creativity, and strategic perspective, all of which suffer when I'm exhausted. For emerging professionals, I'd say focus on developing systems that help you prioritize high-impact work instead of just being busy. Learn to distinguish between what feels urgent and what's truly important. Build relationships across departments so you understand business objectives beyond marketing metrics. And perhaps most importantly, establish boundaries early—it's much harder to pull back once you've set expectations of constant availability. The marketers who thrive long-term aren't necessarily the ones who work the most hours; they're the ones who consistently apply clear thinking to evolving challenges. If I had understood that my worth wasn't tied to constant availability, I would have structured my career differently from the beginning. Marketing will always be demanding, but sustainability matters. If I could go back, I'd tell my younger self that my career is a long game, and pacing matters as much as passion."
    }
];
const EXAMPLE_FIRST_NAME = "Sarah";
// --- END Example Data ---

// TTS functionality has been removed - audio streaming is no longer supported

// Function to log interview responses to Firebase
async function logResponseToFirebase(sessionId, data, persistentSessionId) { // persistentSessionId is the Report Document ID
  if (!db) {
    console.log('Firebase not available - skipping response logging');
    return;
  }
  if (!persistentSessionId) {
      console.error(`[${sessionId}] Cannot log response: persistentSessionId (Report Document ID) is missing.`);
      return;
  }
  
  try {
    // Reference the 'responses' subcollection within the specific report document
    const responseRef = db.collection('reports').doc(persistentSessionId).collection('responses').doc(); // Auto-generate ID for the response doc
    
    // Retrieve userName and userEmail from sessionData (still useful to have here for context)
    const sessionInfo = sessionData.get(sessionId);
    const userName = sessionInfo ? sessionInfo.userName : null;
    const userEmail = sessionInfo ? sessionInfo.userEmail : null;

    // Prepare the data to be stored in the subcollection document
    const responseData = {
      // socket_session_id might be less critical now, but keep for potential debugging
      socket_session_id: sessionId, 
      // persistent_session_id (report ID) and interview_id are implied by the parent doc, 
      // but storing them denormalized can sometimes simplify certain queries later.
      // Let's keep them for now.
      persistent_session_id: persistentSessionId, 
      interview_id: data.interviewId || null,
      question: data.question || null,
      answer: data.answer || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      thinking_trace: data.thinkingTrace || null,
      full_prompt: data.fullPrompt || null, 
      // User details might be redundant if always available in the parent report doc,
      // but keep for now.
      user_name: userName, 
      user_email: userEmail,
      word_timestamps: data.wordTimestamps || null // Add word timestamps
    };
    
    // Add audioGcsUrl if present
    if (data.audioGcsUrl) {
      responseData.audio_gcs_url = data.audioGcsUrl;
    }
    
    // Add response_id field for efficient lookups
    responseData.response_id = responseRef.id;
    
    // Add the document to the subcollection
    await responseRef.set(responseData);
    console.log(`Response logged to Firebase subcollection: reports/${persistentSessionId}/responses/${responseRef.id}`);
    
    return responseRef.id;
  } catch (error) {
    console.error(`Error logging response to Firebase subcollection (reports/${persistentSessionId}/responses):`, error);
    // Don't throw - logging failure shouldn't break the app flow
    return null;
  }
}

// Function to update template completion statistics
async function updateTemplateCompletionStats(interviewId) {
    if (!db) {
        console.log('Firebase not available - skipping template stats update');
        return;
    }
    
    try {
        // Get the interview document to check if it was created from a template
        const interviewDoc = await db.collection('interviews').doc(interviewId).get();
        
        if (!interviewDoc.exists) {
            console.log(`Interview ${interviewId} not found for template stats update`);
            return;
        }
        
        const interviewData = interviewDoc.data();
        const sourceTemplateId = interviewData.sourceTemplateId;
        
        // Check if this interview was created from a template
        if (sourceTemplateId) {
            // Update the template's completion statistics
            const templateRef = db.collection('templates').doc(sourceTemplateId);
            await templateRef.update({
                'usageStats.totalInterviewsCompleted': admin.firestore.FieldValue.increment(1),
                'usageStats.lastCompletedAt': admin.firestore.FieldValue.serverTimestamp()
            });
            
            console.log(`Updated completion stats for template ${sourceTemplateId} (interview ${interviewId} completed)`);
        }
        
        // Also check if this interview is the original interview for any templates
        const templatesSnapshot = await db.collection('templates')
            .where('originalInterviewId', '==', interviewId)
            .get();
        
        if (!templatesSnapshot.empty) {
            console.log(`Interview ${interviewId} is the original for ${templatesSnapshot.size} template(s), updating their stats`);
            
            // Update all templates that use this as their original interview
            const updatePromises = templatesSnapshot.docs.map(templateDoc => {
                const templateId = templateDoc.id;
                console.log(`Updating completion stats for template ${templateId} (original interview ${interviewId} completed)`);
                
                return db.collection('templates').doc(templateId).update({
                    'usageStats.totalInterviewsCompleted': admin.firestore.FieldValue.increment(1),
                    'usageStats.lastCompletedAt': admin.firestore.FieldValue.serverTimestamp()
                });
            });
            
            await Promise.all(updatePromises);
        }
        
    } catch (error) {
        console.error('Error updating template completion stats:', error);
        throw error; // Re-throw to be caught by the caller
    }
}

// Function to ensure necessary Firebase indexes exist
async function ensureFirebaseIndexes() {
  if (!db) {
    console.log('Firebase not available - skipping index creation');
    return;
  }
  
  try {
    console.log('Recommended indexes for the top-level \'reports\' collection:');
    console.log('1. Fields: persistent_session_id (ASC), start_timestamp (DESC) - For querying specific reports by persistent ID.');
    console.log('2. Fields: interview_id (ASC), start_timestamp (DESC) - For querying all reports related to a specific custom interview, newest first.');
    console.log('3. Fields: user_email (ASC), start_timestamp (DESC) - For querying reports by user, newest first.');
    console.log('4. Fields: status (ASC), start_timestamp (DESC) - For querying reports by their status (e.g., started, completed).');
    
    // Verify if the reports collection exists
    const reportsCollectionRef = db.collection('reports');
    const snapshotReports = await reportsCollectionRef.limit(1).get();
    
    if (snapshotReports.empty) {
      console.log('Top-level \'reports\' collection is empty or does not exist yet');
    } else {
      console.log('Top-level \'reports\' collection exists with data');
    }

    console.log('\nRecommended indexes for the \'responses\' subcollection (within each report document):');
    console.log('Example path: reports/{report_id}/responses');
    console.log('1. Fields: timestamp (ASC) - For ordering responses chronologically within a specific report.');
    
    // Note: Checking subcollection existence/content is more complex and generally not done in this manner.
    // We assume that if reports are being created, responses subcollections will be too.
    console.log('\nEnsure subcollection indexes are created as needed for querying responses within reports.');

    // Clean up old recommendations for the now-obsolete top-level 'responses' collection
    console.log('\nNote: The top-level \'responses\' collection is being phased out.');
    console.log('If you have existing data in a top-level \'responses\' collection, consider migrating it or ensuring queries are updated.');

  } catch (error) {
    console.error('Error checking Firebase indexes:', error);
  }
}

// Helper function to escape XML special characters
function escapeXml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe.replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

// --- NEW: Function to get responses with signed URLs ---
async function getResponsesWithSignedUrls(reportId, db, storageInstance, gcsBucketName) {
    if (!db) {
        console.error(`[getResponsesWithSignedUrls] Firebase DB not available for report ${reportId}`);
        throw new Error('Firebase service unavailable');
    }
    if (!storageInstance) {
        console.error(`[getResponsesWithSignedUrls] GCS Storage not available for report ${reportId}`);
        throw new Error('Storage service unavailable');
    }
    if (!reportId) {
        console.error(`[getResponsesWithSignedUrls] Missing report ID`);
        throw new Error('Missing report ID');
    }

    const responses = [];
    try {
        const responsesQuery = db.collection('reports').doc(reportId).collection('responses').orderBy('timestamp', 'asc');
        console.log(`[getResponsesWithSignedUrls] Querying path: reports/${reportId}/responses`);
        const snapshot = await responsesQuery.get();
        console.log(`[getResponsesWithSignedUrls] Query returned ${snapshot.size} documents`);
        
        // Log first few documents for debugging
        snapshot.docs.slice(0, 3).forEach((doc, index) => {
            const data = doc.data();
            console.log(`[getResponsesWithSignedUrls] Doc ${index} ID: ${doc.id}, has audio: ${!!(data.audio_gcs_url || data.audio_url)}, has video: ${!!(data.video_gcs_url || data.video_url)}`);
        });

        // Use Promise.all to handle async signed URL generation
        await Promise.all(snapshot.docs.map(async (doc) => {
            const data = doc.data();
            let signedAudioUrl = null;
            let signedVideoUrl = null;

            // Helper function to generate signed URL from GCS URI, storage path, or pass through existing HTTP URLs.
            const generateSignedUrl = async (mediaPath, type) => {
                try {
                    if (!mediaPath) {
                        return null;
                    }

                    if (/^https?:\/\//i.test(mediaPath)) {
                        return mediaPath;
                    }

                    const match = mediaPath.match(/^gs:\/\/([^\/]+)\/(.+)$/);
                    if (match) {
                        const bucketName = match[1];
                        const filePath = match[2];
                        
                        const options = {
                            version: 'v4',
                            action: 'read',
                            expires: Date.now() + 60 * 60 * 1000, // 1 hour
                        };
                        const bucketToUse = bucketName === gcsBucketName ? storageInstance.bucket(gcsBucketName) : storageInstance.bucket(bucketName);
                        const [url] = await bucketToUse.file(filePath).getSignedUrl(options);
                        return url;
                    }

                    const filePath = mediaPath.replace(/^\/+/, '');
                    const [url] = await storageInstance.bucket(gcsBucketName).file(filePath).getSignedUrl({
                        version: 'v4',
                        action: 'read',
                        expires: Date.now() + 60 * 60 * 1000,
                    });
                    return url;
                } catch (urlError) {
                    console.error(`[getResponsesWithSignedUrls] Error generating signed URL for ${type} ${mediaPath} in report ${reportId}:`, urlError);
                    return null;
                }
            };

            // Generate audio signed URL
            const audioPath = data.audio_gcs_url || data.audio_url;
            if (audioPath) {
                signedAudioUrl = await generateSignedUrl(audioPath, 'audio');
            }

            // Generate video signed URL
            const videoPath = data.video_gcs_url || data.video_url;
            if (videoPath) {
                signedVideoUrl = await generateSignedUrl(videoPath, 'video');
            }

            responses.push({
                id: doc.id,
                question: data.question || '',
                answer: data.answer || '',
                timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : null,
                audio_signed_url: signedAudioUrl,
                video_signed_url: signedVideoUrl,
                word_timestamps: data.word_timestamps || data.wordTimestamps || null // Include word timestamps
            });
        }));
        console.log(`[getResponsesWithSignedUrls] Fetched ${responses.length} responses for report ${reportId}`);
        return responses;
    } catch (error) {
        console.error(`[getResponsesWithSignedUrls] Error fetching responses for report ${reportId}:`, error);
        // Re-throw the error to be handled by the caller
        throw error; 
    }
}
// --- END NEW FUNCTION ---

// --- Text extraction moved to modular structure ---
// The extractTextFromFileBuffer function has been moved to server/utils/text-extraction.js
// and is imported at the top of this file. This is part of the incremental modularization
// of server.js to improve maintainability.

// --- Email Functions ---
function createReportEmailTemplate(reportContent, reportTitle, reportPermalink, userName, interviewLink = null) {
    // Create a clean text version for the text email
    let cleanText = reportContent
        .replace(/^#+\s+/gm, '') // Remove markdown headers
        .replace(/\*\*/g, '') // Remove bold markdown
        .replace(/\*/g, '') // Remove italic markdown
        .replace(/`/g, '') // Remove code markdown
        .replace(/<audio_clip[^>]*>(.*?)<\/audio_clip>/gi, '"$1"') // Convert audio clips to quotes
        .replace(/\n{3,}/g, '\n\n'); // Reduce multiple newlines
    
    // Convert report content to HTML-friendly format
    let htmlContent = reportContent
        // First, escape HTML entities but preserve our markdown syntax
        .replace(/&/g, '&amp;')
        // Convert audio_clip tags to temporary markers before escaping
        .replace(/<audio_clip\s+id="([^"]*)">(.*?)<\/audio_clip>/gi, '§§AUDIO_CLIP_START§§$1§§AUDIO_CLIP_MIDDLE§§$2§§AUDIO_CLIP_END§§')
        // Now escape angle brackets
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // Convert markdown to HTML
        // Convert ### headers to h3
        .replace(/###\s*(.*?)(?=\n|$)/g, '<h3>$1</h3>')
        // Convert ## headers to h2
        .replace(/##\s*(.*?)(?=\n|$)/g, '<h2>$1</h2>')
        // Convert # headers to h1
        .replace(/#\s*(.*?)(?=\n|$)/g, '<h1>$1</h1>')
        // Convert **bold** to <strong>
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        // Convert *italic* to <em>
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        // Convert audio_clip markers back to HTML
        .replace(/§§AUDIO_CLIP_START§§([^§]*)§§AUDIO_CLIP_MIDDLE§§([^§]*)§§AUDIO_CLIP_END§§/g, '<div class="quote-block">"$2"</div>')
        // Convert newlines to <br> tags
        .replace(/\n/g, '<br>')
        // Clean up excessive line breaks
        .replace(/(<br>\s*){3,}/g, '<br><br>');

    const emailTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${reportTitle}</title>
    <!--[if !mso]><!-->
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <!--<![endif]-->
    <style type="text/css">
        body {
            font-family: 'Arial', sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            background-color: #f8f9fa;
            padding: 20px;
        }
        .email-container {
            background-color: white;
            border-radius: 10px;
            padding: 30px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
            border-bottom: 2px solid #e9ecef;
            padding-bottom: 20px;
        }
        .logo {
            max-width: 150px;
            height: auto;
            margin-bottom: 15px;
        }
        .title {
            color: #2c5aa0;
            font-size: 26px;
            margin: 0;
            font-weight: bold;
        }
        .subtitle {
            color: #6c757d;
            font-size: 16px;
            margin-top: 5px;
        }
        .content {
            margin: 25px 0;
            font-size: 15px;
            line-height: 1.7;
        }
        .content h1 {
            color: #2c5aa0 !important;
            margin-top: 40px !important;
            margin-bottom: 25px !important;
            font-size: 28px !important;
        }
        .content h2 {
            color: #2c5aa0 !important;
            margin-top: 35px !important;
            margin-bottom: 20px !important;
            font-size: 24px !important;
        }
        .content h3 {
            color: #2c5aa0 !important;
            margin-top: 30px !important;
            margin-bottom: 15px !important;
            font-size: 18px !important;
        }
        /* Quote block styling for interview quotes */
        .quote-block {
            margin: 20px 0 !important;
            padding: 15px 20px !important;
            background-color: #f8f9fa !important;
            border-left: 4px solid #2c5aa0 !important;
            font-style: italic !important;
            color: #495057 !important;
            line-height: 1.6 !important;
            border-radius: 0 5px 5px 0 !important;
        }
        .cta-section {
            background: linear-gradient(135deg, #2c5aa0 0%, #4a7bc8 100%);
            color: white;
            padding: 25px;
            border-radius: 8px;
            text-align: center;
            margin: 30px 0;
        }
        .cta-button {
            display: inline-block;
            background-color: white;
            color: #2c5aa0;
            padding: 12px 30px;
            text-decoration: none;
            border-radius: 25px;
            font-weight: bold;
            font-size: 16px;
            margin-top: 15px;
            transition: all 0.3s ease;
        }
        .cta-button:hover {
            background-color: #f8f9fa;
            transform: translateY(-2px);
        }
        .footer {
            text-align: center;
            font-size: 12px;
            color: #6c757d;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #e9ecef;
        }
        .audio-clip {
            background-color: #e3f2fd;
            border-left: 4px solid #2196f3;
            padding: 10px 15px;
            margin: 15px 0;
            border-radius: 0 5px 5px 0;
            font-style: italic;
        }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="header">
            <img src="cid:logo" alt="Say AI Logo" class="logo">
            <h1 class="title">${reportTitle || 'Your Report'}</h1>
        </div>

        <div class="subtitle" style="text-align: center; margin: 25px 0;">
            <p style="color: #6c757d; font-size: 18px; margin: 0 0 10px 0;">Hello ${userName || 'there'},</p>
            <p style="color: #495057; font-size: 16px; margin: 0;">Your interview summary is ready!</p>
        </div>

        <div class="report-content" style="margin: 30px 0;">
            <div class="content">
                ${htmlContent}
            </div>
        </div>

        <div class="cta-section" style="text-align: center;">
            <h3 style="margin-top: 0; color: white; font-size: 22px;">View Your Full Report</h3>
            <p style="margin-bottom: 25px; opacity: 0.9; font-size: 16px;">Read your complete report with audio clips from the interview.</p>
            <a href="${reportPermalink}" class="cta-button" style="font-size: 18px; padding: 16px 40px;">Read the Full Story</a>
        </div>
        ${interviewLink ? `
        <div style="text-align: center; margin: 25px 0; padding-top: 20px; border-top: 1px solid #e9ecef;">
            <p style="color: #6c757d; font-size: 14px; margin: 0 0 10px 0;">Want to record your own?</p>
            <a href="${interviewLink}" style="color: #2c5aa0; font-size: 14px;">Start an interview</a>
        </div>
        ` : ''}

        <div class="footer">
            <p>Made with <a href="https://sayinterview.com" style="color: #2c5aa0;">Say</a></p>
        </div>
    </div>
</body>
</html>`;

    return {
        html: emailTemplate,
        text: cleanText
    };
}

function createSharingNotificationTemplate(sharedByEmail, interviewTitle, interviewDescription, shareLink, recipientHasAccount) {
    const subject = `${sharedByEmail} shared an interview with you: ${interviewTitle}`;
    
    const accountMessage = recipientHasAccount 
        ? `You can view and manage this interview by logging into your account.`
        : `You'll need to create a free account to view this interview. It only takes a moment!`;
    
    const ctaText = recipientHasAccount ? 'View Interview' : 'Create Account & View Interview';
    
    const textContent = `Hi,

${sharedByEmail} has shared an interview with you on Say Research.

Interview: ${interviewTitle}
${interviewDescription ? `Description: ${interviewDescription}` : ''}

${accountMessage}

View the interview here: ${shareLink}

Best regards,
The Say Team`;

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Interview Shared With You</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .email-container {
            background-color: white;
            border-radius: 10px;
            padding: 30px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        h1 {
            color: #2c5aa0;
            font-size: 26px;
            margin-bottom: 10px;
            font-weight: bold;
        }
        .subtitle {
            color: #6c757d;
            font-size: 16px;
            margin-bottom: 25px;
        }
        .share-info {
            background-color: #f8f9fa;
            border-left: 4px solid #2c5aa0;
            padding: 20px;
            margin: 20px 0;
            border-radius: 0 8px 8px 0;
        }
        .share-info h2 {
            color: #1a1a1a;
            font-size: 20px;
            margin: 0 0 10px 0;
        }
        .share-info p {
            margin: 5px 0;
            color: #666;
        }
        .sharer {
            font-weight: 600;
            color: #2c5aa0;
        }
        .account-message {
            background-color: #e3f2fd;
            padding: 15px 20px;
            border-radius: 8px;
            margin: 20px 0;
            color: #2c5aa0;
        }
        .cta-button {
            display: inline-block;
            background-color: #2c5aa0;
            color: white !important;
            padding: 14px 32px;
            text-decoration: none;
            border-radius: 25px;
            font-weight: bold;
            font-size: 16px;
            margin: 25px 0;
            transition: background-color 0.3s ease;
        }
        .cta-button:hover {
            background-color: #1e417a;
        }
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            color: #666;
            font-size: 14px;
        }
        .footer p {
            margin: 5px 0;
        }
    </style>
</head>
<body>
    <div class="email-container">
        <h1>🎯 Interview Shared With You</h1>
        <p class="subtitle">You've been invited to collaborate on Say Research</p>
        
        <p>Hi there,</p>
        <p><span class="sharer">${sharedByEmail}</span> has shared an interview with you.</p>
        
        <div class="share-info">
            <h2>${interviewTitle}</h2>
            ${interviewDescription ? `<p>${interviewDescription}</p>` : ''}
        </div>
        
        <div class="account-message">
            ${recipientHasAccount 
                ? '✅ Good news! You already have an account. Just log in to access this interview.'
                : '🚀 Create your free account in seconds to view this interview and start collaborating!'}
        </div>
        
        <div style="text-align: center;">
            <a href="${shareLink}" class="cta-button">${ctaText}</a>
        </div>
        
        <div class="footer">
            <p><strong>Say Research</strong> - AI-powered interview platform</p>
            <p style="margin-top: 15px; font-size: 12px; color: #999;">
                You received this email because someone shared an interview with you.
                If you believe this was sent in error, please ignore this email.
            </p>
        </div>
    </div>
</body>
</html>`;

    return {
        subject,
        text: textContent,
        html: htmlContent
    };
}

async function sendSharingNotificationEmail(recipientEmail, sharedByEmail, interviewTitle, interviewDescription, interviewId, sharedByUserId = null) {
    if (!recipientEmail || !sharedByEmail || !interviewTitle || !interviewId) {
        console.warn('Missing required parameters for sharing notification email. Skipping email send.');
        return false;
    }

    try {
        // Get sharer's data for Gmail integration
        let userData = null;
        if (sharedByUserId && db) {
            try {
                const sharerDoc = await db.collection('users').doc(sharedByUserId).get();
                if (sharerDoc.exists) {
                    userData = sharerDoc.data();
                    userData.uid = sharedByUserId;
                }
            } catch (error) {
                console.warn('Error fetching sharer user data:', error);
            }
        }
        // Check if recipient has an account
        let recipientHasAccount = false;
        if (admin && admin.auth) {
            try {
                await admin.auth().getUserByEmail(recipientEmail);
                recipientHasAccount = true;
                console.log(`[sendSharingNotificationEmail] Recipient ${recipientEmail} has an account`);
            } catch (error) {
                if (error.code === 'auth/user-not-found') {
                    recipientHasAccount = false;
                    console.log(`[sendSharingNotificationEmail] Recipient ${recipientEmail} does not have an account`);
                } else {
                    console.error(`[sendSharingNotificationEmail] Error checking user account:`, error);
                }
            }
        }

        // Construct the share link (always direct to admin panel)
        const baseUrl = process.env.BASE_URL || 'https://prompter.example.com';
        const shareLink = recipientHasAccount
            ? `${baseUrl}/admin.html?shared_interview=${interviewId}`
            : `${baseUrl}/admin.html?signup=true&shared_interview=${interviewId}`;

        console.log(`[sendSharingNotificationEmail] Preparing to send sharing notification to ${recipientEmail}`);
        console.log(`[sendSharingNotificationEmail] Share link: ${shareLink}`);

        // Create the email template
        const emailTemplate = createSharingNotificationTemplate(
            sharedByEmail,
            interviewTitle,
            interviewDescription,
            shareLink,
            recipientHasAccount
        );

        // Prepare email data
        const emailData = {
            to: recipientEmail,
            subject: emailTemplate.subject,
            html: emailTemplate.html,
            text: emailTemplate.text,
            mailSettings: {
                bypassListManagement: {
                    enable: false
                }
            }
        };

        // Send the email using EmailService
        console.log(`[sendSharingNotificationEmail] Attempting to send email...`);
        const result = await EmailService.send({
            to: recipientEmail,
            subject: emailData.subject,
            html: emailData.html,
            text: emailData.text,
            user: userData
        });
        
        console.log(`[sendSharingNotificationEmail] ✅ Email sent successfully to ${recipientEmail} via ${result.service}`);
        return true;

    } catch (error) {
        console.error(`[sendSharingNotificationEmail] ❌ Failed to send sharing notification to ${recipientEmail}:`, error.message);
        return false;
    }
}

async function sendReportEmail(userEmail, userName, reportContent, reportTitle, reportId, interviewId, sessionId = null, adminUserId = null) {
    if (!userEmail || !reportContent) {
        console.warn('Missing required email parameters (userEmail or reportContent). Skipping email send.');
        return false;
    }

    try {
        // Get user data for Gmail integration
        let userData = null;
        if (adminUserId && db) {
            console.log(`[sendReportEmail] Fetching user data for adminUserId: ${adminUserId}`);
            try {
                const adminDoc = await db.collection('users').doc(adminUserId).get();
                if (adminDoc.exists) {
                    userData = adminDoc.data();
                    userData.uid = adminUserId;
                    console.log(`[sendReportEmail] User Gmail status:`, {
                        gmailConnected: userData.gmailConnected,
                        hasGmailTokens: !!userData.gmailTokens,
                        userEmail: userData.email
                    });
                } else {
                    console.log(`[sendReportEmail] No user document found for adminUserId: ${adminUserId}`);
                }
            } catch (error) {
                console.warn('Error fetching admin user data:', error);
            }
        } else {
            console.log(`[sendReportEmail] No adminUserId provided or db not available`, { adminUserId, dbAvailable: !!db });
        }
        let mainReportContent = reportContent;
        
        // Also remove the individual_summary_report tags if present
        const summaryMatch = mainReportContent.match(/<individual_summary_report>([\s\S]*?)<\/individual_summary_report>/);
        if (summaryMatch) {
            mainReportContent = summaryMatch[1].trim();
        }

        // Construct the permalink to the report
        const baseUrl = process.env.BASE_URL || 'http://prompter.example.com';
        // Include session_id for forwarding capability
        const reportPermalink = sessionId 
            ? `${baseUrl}/report.html?id=${reportId}&session_id=${sessionId}`
            : `${baseUrl}/report.html?id=${reportId}`;

        console.log(`[sendReportEmail] Preparing to send email to ${userEmail} for report ${reportId}`);
        console.log(`[sendReportEmail] Report permalink: ${reportPermalink}`);

        // Read the logo file
        let logoAttachment = null;
        const logoPath = path.join(__dirname, 'public', 'saylogo.png');
        
        if (fs.existsSync(logoPath)) {
            const logoContent = fs.readFileSync(logoPath);
            logoAttachment = {
                Name: 'logo',
                Content: logoContent.toString('base64'),
                ContentType: 'image/png',
                ContentID: 'cid:logo'
            };
        } else {
            console.warn('Logo file not found at:', logoPath);
        }

        // Create the interview link if interviewId is available
        const interviewLink = interviewId ? `${baseUrl}/?interview=${interviewId}` : null;

        // Create the email template
        const emailTemplate = createReportEmailTemplate(mainReportContent, reportTitle, reportPermalink, userName, interviewLink);

        // Prepare email data
        const emailData = {
            to: userEmail,
            subject: `${reportTitle || 'Your Story'}`,
            html: emailTemplate.html,
            text: `${userName ? `Dear ${userName},` : 'Hello,'}

Here's what emerged from your conversation.

${emailTemplate.text}

---

Read the full story (with audio): ${reportPermalink}
${interviewLink ? `\nWant to record your own? ${interviewLink}` : ''}

Made with Say - https://sayinterview.com`,
            mailSettings: {
                bypassListManagement: {
                    enable: false
                }
            },
            trackingSettings: {
                clickTracking: {
                    enable: true
                },
                openTracking: {
                    enable: true
                }
            }
        };

        // Add logo attachment if available
        if (logoAttachment) {
            emailData.attachments = [{
                content: logoAttachment.Content,
                filename: 'logo.png',
                type: logoAttachment.ContentType,
                disposition: 'inline',
                content_id: 'logo' // This should match the cid:logo in the HTML
            }];
        }

        // Send the email using EmailService
        console.log(`[sendReportEmail] Attempting to send email...`);
        
        // Add timeout to catch hanging issues
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Email send timeout after 30 seconds')), 30000)
        );
        
        try {
            const result = await Promise.race([
                EmailService.send({
                    to: userEmail,
                    subject: emailData.subject,
                    html: emailData.html,
                    text: emailData.text,
                    user: userData,
                    attachments: logoAttachment ? [{
                        content: logoAttachment.Content,
                        filename: 'logo.png',
                        type: 'image/png',
                        disposition: 'inline',
                        content_id: 'logo'
                    }] : undefined
                }),
                timeoutPromise
            ]);
            
            console.log(`[sendReportEmail] ✅ Email sent successfully to ${userEmail} via ${result.service}`);
            return true;
        } catch (sendError) {
            console.error(`[sendReportEmail] ❌ Email send error:`, sendError);
            throw sendError;
        }

    } catch (error) {
        console.error(`[sendReportEmail] ❌ Failed to send report email to ${userEmail}:`, error.message);
        return false;
    }
}
// --- End Email Functions ---

// Socket.IO connection handling
io.on('connection', (socket) => {
    // console.log('Client connected');
    let sessionId = socket.id;
    
    // Initialize session data if it doesn't exist
    if (!sessionData.has(sessionId)) {
        sessionData.set(sessionId, {
            interviewResponses: [],
            assistantQuestions: [],
            contextData: null,
            customPrompt: null,
            firstName: null,
            totalRecordingDuration: 0, // Ensure this is totalRecordingDuration
            lastActive: Date.now(), // Track when the session was last active
            deepgramSocket: null, // For Deepgram WebSocket connection
            currentTranscription: '',
            currentWordTimestamps: [],
            keepAliveInterval: null, // For Deepgram keepAlive
            isGracefullyClosingDeepgram: false // New flag
        });
    } else {
        // Update last active timestamp for existing session
        const sessionInfo = sessionData.get(sessionId);
        if (sessionInfo) {
            sessionInfo.lastActive = Date.now();
        }
    }

    // Log connection event for debugging
    console.log(`Socket connected: ${sessionId} (total active: ${sessionData.size})`);

    // Handle disconnection - but don't remove session data immediately to allow reconnection
    socket.on('disconnect', (reason) => {
        console.log(`Socket disconnected: ${sessionId}, reason: ${reason}`);
        
        // Mark session as potentially inactive, but don't remove it
        const sessionInfo = sessionData.get(sessionId);
        if (sessionInfo) {
            sessionInfo.disconnectedAt = Date.now();
        }
    });

    // Handle errors
    socket.on('error', (error) => {
        console.error(`Socket error for ${sessionId}:`, error);
    });
    
    // Handle heartbeat to keep connection alive
    socket.on('heartbeat', () => {
        // Update last active timestamp
        const sessionInfo = sessionData.get(sessionId);
        if (sessionInfo) {
            sessionInfo.lastActive = Date.now();
        }
        // Send pong back to client
        socket.emit('heartbeat');
        console.log(`[Socket Heartbeat] Received from ${sessionId}, sent pong back`);
    });

    socket.on('startInterview', async (data) => {
        // Validate socket data
        const validation = validateAndSanitizeSocketEvent('startInterview', data, socket);
        if (!validation.isValid) return;
        data = validation.data;
        // Check usage limits before starting interview
        if (pricingService && data.userId) {
            try {
                console.log(`[${sessionId}] Checking usage limits for user ${data.userId}`);
                const canComplete = await pricingService.canCompleteInterview(data.userId);
                console.log(`[${sessionId}] Usage check result: ${canComplete}`);
                
                if (!canComplete) {
                    console.log(`[${sessionId}] User ${data.userId} has reached interview limit`);
                    
                    // Get current subscription data for debugging
                    const userData = await pricingService.getUserSubscription(data.userId);
                    console.log(`[${sessionId}] Current user subscription data:`, userData);
                    
                    socket.emit('usageLimitReached', {
                        message: 'You have reached your interview limit. Purchase additional interviews to continue.',
                        upgradeRequired: true
                    });
                    return;
                }
                
                // Store userId in session for later usage tracking
                sessionData.get(sessionId).userId = data.userId;
                console.log(`[${sessionId}] Usage check passed for user ${data.userId}`);
            } catch (error) {
                console.error(`[${sessionId}] Error checking usage limits:`, error);
                // Continue with interview if usage check fails (fail open)
            }
        } else if (!data.userId) {
            console.warn(`[${sessionId}] No userId provided for usage tracking`);
        }

        // Check if data is an object with resume and prompt properties
        if (typeof data === 'object' && data.resume !== undefined) {
            console.log(`[${sessionId}] Received data object:`, {
                resumeType: typeof data.resume,
                resumeValue: data.resume,
                resumeLength: data.resume ? data.resume.length : 0,
                dataKeys: Object.keys(data)
            });
            // Store the uploaded content as contextData rather than just 'resume'
            let baseContext = data.resume;
            let namePrefix = "";
            let emailPrefix = "";

            // Capture and prepend userName if provided
            if (data.userName) {
                sessionData.get(sessionId).userName = data.userName; 
                namePrefix = `Name: ${data.userName}\n`;
            }
            // Capture and prepend userEmail if provided
            if (data.userEmail) {
                sessionData.get(sessionId).userEmail = data.userEmail;
                emailPrefix = `Email: ${data.userEmail}\n`;
            }
            // Capture adminEmail if provided (indicates admin taking their own interview)
            if (data.adminEmail) {
                sessionData.get(sessionId).adminEmail = data.adminEmail;
                console.log(`[${sessionId}] Admin email detected: ${data.adminEmail}`);
            }
            
            // Track campaign email if provided
            if (data.campaignEmailId) {
                sessionData.get(sessionId).campaignEmailId = data.campaignEmailId;
                console.log(`[${sessionId}] Campaign email ID detected: ${data.campaignEmailId}`);
                
                // Update campaign email tracking - mark interview as started
                try {
                    await db.collection('campaign_emails').doc(data.campaignEmailId).update({
                        interviewStartedAt: admin.firestore.FieldValue.serverTimestamp(),
                        lastActivity: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.log(`[${sessionId}] Updated campaign email tracking for interview start`);
                } catch (error) {
                    console.error(`[${sessionId}] Error updating campaign email tracking:`, error);
                }
            }

            // Store UTM parameters if provided
            if (data.utmParams && Object.keys(data.utmParams).length > 0) {
                sessionData.get(sessionId).utmParams = data.utmParams;
                console.log(`[${sessionId}] UTM parameters detected:`, data.utmParams);
            }

            // Initialize contextData - will be built upon
            sessionData.get(sessionId).contextData = ``; 
            
            // Handle uploaded file if present
            if (data.uploadedFile) {
                console.log(`[${sessionId}] Processing uploaded file:`, data.uploadedFile);
                sessionData.get(sessionId).uploadedFile = data.uploadedFile;
            }
            
            let userProvidedContext = `${namePrefix}${emailPrefix}${namePrefix || emailPrefix ? '\n' : ''}${baseContext}`; // Store user context separately for now
            console.log(`[${sessionId}] Building userProvidedContext:`, {
                namePrefix,
                emailPrefix,
                baseContext,
                baseContextType: typeof baseContext,
                baseContextLength: baseContext ? baseContext.length : 0,
                resultingContext: userProvidedContext
            });

            // Process interview ID if available
            let interviewIdStr = null;
            if (data.interviewId) {
                interviewIdStr = String(data.interviewId).trim();
                console.log(`Processing interview ID: "${interviewIdStr}"`);
                // Store interview ID immediately in session data so it's available for report creation
                sessionData.get(sessionId).interviewId = interviewIdStr;
                console.log(`[${sessionId}] Interview ID stored in session data: ${interviewIdStr}`);
            }

            // Check if there's an interview ID to fetch custom prompts
            if (interviewIdStr && db) {
                try {
                    if (!interviewIdStr) {
                        console.error(`Invalid interview ID format: "${data.interviewId}"`);
                        socket.emit('error', 'Invalid interview ID format');
                        return;
                    }
                    
                    console.log(`\n======= FIREBASE DEBUG =======`);
                    console.log(`Firebase interaction starting`);
                    console.log(`InterviewId (raw): "${data.interviewId}"`);
                    console.log(`InterviewId (processed): "${interviewIdStr}"`);
                    console.log(`Socket ID: ${sessionId}`);
                    console.log(`DB Connection: ${typeof db}`);
                    console.log(`DB Collection method available: ${typeof db.collection === 'function'}`);
                    console.log(`Attempting to query: interviews/${interviewIdStr}`);
                    
                    // Track timing
                    const startTime = Date.now();
                    
                    // Use the sanitized interview ID string
                    const interviewDoc = await db.collection('interviews').doc(interviewIdStr).get();
                    
                    const endTime = Date.now();
                    console.log(`Firebase query completed in ${endTime - startTime}ms`);
                    console.log(`Interview exists: ${interviewDoc.exists ? 'YES' : 'NO'}`);
                    
                    if (interviewDoc.exists) {
                        const interviewData = interviewDoc.data();
                        console.log(`Interview title: "${interviewData.title || 'UNTITLED'}"`);
                        console.log(`Interview data dump:`);
                        console.log(JSON.stringify({
                            id: interviewData.id,
                            title: interviewData.title,
                            initialPromptLength: interviewData.initialPrompt ? interviewData.initialPrompt.length : 0,
                            followupPromptLength: interviewData.followupPrompt ? interviewData.followupPrompt.length : 0,
                            reportPromptLength: interviewData.reportPrompt ? interviewData.reportPrompt.length : 0,
                            createdAt: interviewData.createdAt ? interviewData.createdAt.toDate().toISOString() : null
                        }, null, 2));
                        
                        // Verify and log the prompt content to debug format issues
                        console.log("\n--- Initial Prompt Content Check ---");
                        if (interviewData.initialPrompt) {
                            console.log(`Initial prompt type: ${typeof interviewData.initialPrompt}`);
                            console.log(`Initial prompt length: ${interviewData.initialPrompt.length}`);
                            console.log(`Initial prompt first 100 chars: ${interviewData.initialPrompt.substring(0, 100)}...`);
                            console.log(`Initial prompt contains {{CONTEXT}}: ${interviewData.initialPrompt.includes('{{CONTEXT}}')}`);
                            console.log(`Initial prompt contains {{RESUME}}: ${interviewData.initialPrompt.includes('{{RESUME}}')}`);
                        } else {
                            console.log("Initial prompt is null or undefined");
                        }
                        
                        console.log("\n--- Followup Prompt Content Check ---");
                        if (interviewData.followupPrompt) {
                            console.log(`Followup prompt type: ${typeof interviewData.followupPrompt}`);
                            console.log(`Followup prompt length: ${interviewData.followupPrompt.length}`);
                            console.log(`Followup prompt first 100 chars: ${interviewData.followupPrompt.substring(0, 100)}...`);
                            console.log(`Followup prompt contains {{CONTEXT}}: ${interviewData.followupPrompt.includes('{{CONTEXT}}')}`);
                            console.log(`Followup prompt contains {{RESUME}}: ${interviewData.followupPrompt.includes('{{RESUME}}')}`);
                        } else {
                            console.log("Followup prompt is null or undefined");
                        }
                        
                        console.log("--- End Prompt Content Check ---");
                        console.log(`======= END FIREBASE DEBUG =======\n`);
                        
                        // Store the custom prompts
                        // If a custom prompt was provided via URL parameter, use it instead of the template's initial prompt
                        if (data.prompt) {
                            sessionData.get(sessionId).customPrompt = data.prompt;
                            console.log(`[${sessionId}] Using custom first question from URL parameter instead of template initial prompt`);
                        } else {
                            sessionData.get(sessionId).customPrompt = interviewData.initialPrompt;
                        }
                        sessionData.get(sessionId).followupPrompt = interviewData.followupPrompt;
                        sessionData.get(sessionId).reportPrompt = interviewData.reportPrompt;
                        // reportFrom removed - no longer needed
                        sessionData.get(sessionId).adminReportPrompt = interviewData.adminReportPrompt;
                        sessionData.get(sessionId).userNote = interviewData.userNote || null;
                        
                        // Store new fields for improved interview flow
                        sessionData.get(sessionId).interviewTitle = interviewData.title;
                        sessionData.get(sessionId).interviewDescription = interviewData.description;
                        sessionData.get(sessionId).interviewPurpose = interviewData.purpose;
                        sessionData.get(sessionId).requiredInformation = interviewData.requiredInformation || [];
                        
                        // Store interview settings from template
                        // Override client-sent settings with template settings when template exists
                        if (interviewData.enableMemoryService !== undefined) {
                            sessionData.get(sessionId).enableMemoryService = interviewData.enableMemoryService;
                            console.log(`[${sessionId}] Memory service setting loaded from template: ${interviewData.enableMemoryService} (overriding client value: ${data.enableMemoryService})`);
                        }
                        if (interviewData.enableWebSearch !== undefined) {
                            sessionData.get(sessionId).enableWebSearch = interviewData.enableWebSearch;
                            console.log(`[${sessionId}] Web search setting loaded from template: ${interviewData.enableWebSearch} (overriding client value: ${data.enableWebSearch})`);
                        }
                        if (interviewData.enableThinking !== undefined) {
                            sessionData.get(sessionId).enableThinking = interviewData.enableThinking;
                            console.log(`[${sessionId}] Thinking setting loaded from template: ${interviewData.enableThinking} (overriding client value: ${data.enableThinking})`);
                        }
                        if (interviewData.followupModel) {
                            sessionData.get(sessionId).followupModel = interviewData.followupModel;
                            console.log(`[${sessionId}] Follow-up model loaded from template: ${interviewData.followupModel} (overriding client value: ${data.followupModel})`);
                        }
                        // Only use template value if client didn't provide a specific preference
                        if (interviewData.enableVideoRecording !== undefined && data.enableVideoRecording === undefined) {
                            sessionData.get(sessionId).enableVideoRecording = interviewData.enableVideoRecording;
                            console.log(`[${sessionId}] Video recording setting loaded from template: ${interviewData.enableVideoRecording} (client didn't specify)`);
                        } else if (data.enableVideoRecording !== undefined) {
                            console.log(`[${sessionId}] Video recording setting from client: ${data.enableVideoRecording} (overriding template value: ${interviewData.enableVideoRecording})`);
                        }
        
                        // --- START: Process Admin Context Files ---
                        let adminContextText = '';
                        if (interviewData.contextFiles && Array.isArray(interviewData.contextFiles) && interviewData.contextFiles.length > 0) {
                            console.log(`[${sessionId}] Found ${interviewData.contextFiles.length} admin context files to process.`);
                            const fileProcessingPromises = interviewData.contextFiles.map(async (fileData) => {
                                if (!fileData || !fileData.path) {
                                    console.warn(`[${sessionId}] Skipping invalid file data entry:`, fileData);
                                    return null;
                                }
                                const filePath = fileData.path;
                                const fileName = fileData.name || path.basename(filePath);
                                const fileType = fileData.type || path.extname(filePath); // Use stored type or infer from extension

                                // Check if content is stored directly (text-only files)
                                if (fileData.content) {
                                    console.log(`[${sessionId}] Using inline text content for ${fileName}, length: ${fileData.content.length}`);
                                    return { fileName, text: fileData.content };
                                }

                                try {
                                    console.log(`[${sessionId}] Downloading context file from GCS: ${filePath}`);
                                    const downloadResponse = await storage.bucket(GCS_BUCKET_NAME).file(filePath).download();
                                    const buffer = downloadResponse[0];
                                    console.log(`[${sessionId}] Downloaded ${fileName}, size: ${buffer.length} bytes. Extracting text...`);
                                    const extractedText = await extractTextFromFileBuffer(buffer, fileType, fileName);
                                    return { fileName, text: extractedText }; // Return object with name and text
                                } catch (error) {
                                    console.error(`[${sessionId}] Failed to process context file ${fileName} (${filePath}):`, error);
                                    // Return error info instead of null to indicate failure
                                    return { fileName, error: `Failed to process: ${error.message}` }; 
                                }
                            });

                            const results = await Promise.allSettled(fileProcessingPromises);
                            console.log(`[${sessionId}] Finished processing admin context files.`);
                            
                            results.forEach((result, index) => {
                                if (result.status === 'fulfilled' && result.value) {
                                    const { fileName, text, error } = result.value;
                                    if (error) {
                                        // Append error message to context if processing failed but download succeeded
                                        adminContextText += `\n\n--- Document: ${fileName} ---\n[Error processing this document: ${error}]\n\n`;
                                    } else if (text !== null && text !== undefined) {
                                        // Append successfully extracted text
                                        adminContextText += `\n\n--- Document: ${fileName} ---\n${text}\n\n`;
                                    } else {
                                        // Handle cases where extraction returned null (e.g., unsupported type)
                                        adminContextText += `\n\n--- Document: ${fileName} ---\n[Unsupported file type or no text extracted]\n\n`;
                                    }
                                } else if (result.status === 'rejected') {
                                    // Handle failures in the promise itself (e.g., download error)
                                    const fileName = interviewData.contextFiles[index]?.name || `File ${index + 1}`;
                                    console.error(`[${sessionId}] Promise rejected for ${fileName}:`, result.reason);
                                    adminContextText += `\n\n--- Document: ${fileName} ---\n[Error loading this document: ${result.reason}]\n\n`;
                                }
                            });
                            adminContextText = adminContextText.trim(); // Remove leading/trailing whitespace
                        } else {
                            console.log(`[${sessionId}] No admin context files found or associated with this interview.`);
                        }
                        // --- END: Process Admin Context Files ---

                        // Combine Admin context (if any) and User context
                        if (adminContextText) {
                          sessionData.get(sessionId).contextData = `--- Admin Provided Context ---\n${adminContextText}\n\n--- End Admin Provided Context ---\n\n${userProvidedContext}`;
                        } else {
                          sessionData.get(sessionId).contextData = userProvidedContext; 
                        }
                        console.log(`[${sessionId}] Final contextData set. Length: ${sessionData.get(sessionId).contextData.length}`);
                        
                        // Check for previous interviews by email if email is provided
                        // TEMPORARILY DISABLED: Memory feature using Haiku to summarize previous interviews
                        console.log(`[${sessionId}] Memory feature (Haiku summarization of previous interviews) is temporarily disabled`);
                        if (false && data.userEmail && db) {
                            try {
                                console.log(`[${sessionId}] Checking for previous interviews by email: ${data.userEmail}`);
                                
                                // Query reports collection for this email
                                // First, let's check if any reports exist for this email at all
                                const allReportsCheck = await db.collection('reports')
                                    .where('user_email', '==', data.userEmail)
                                    .where('interview_id', '==', data.interviewId)  // Only check THIS interview template
                                    .limit(10)
                                    .get();
                                
                                console.log(`[${sessionId}] Total reports found for ${data.userEmail} on interview ${data.interviewId}: ${allReportsCheck.size}`);
                                if (!allReportsCheck.empty) {
                                    allReportsCheck.forEach(doc => {
                                        const data = doc.data();
                                        console.log(`[${sessionId}] Report ${doc.id}: status='${data.status}', has end_timestamp=${!!data.end_timestamp}`);
                                    });
                                }
                                
                                // Now try the full query
                                let previousReportsSnapshot;
                                try {
                                    previousReportsSnapshot = await db.collection('reports')
                                        .where('user_email', '==', data.userEmail)
                                        .where('interview_id', '==', data.interviewId)  // Only get previous attempts at THIS interview
                                        .orderBy('start_timestamp', 'desc')  // Use start_timestamp since all interviews have it
                                        .limit(50)  // Increased limit to capture more interview history
                                        .get();
                                } catch (queryError) {
                                    console.error(`[${sessionId}] Query error (likely missing index):`, queryError.message);
                                    
                                    // Fallback: Try simpler query without orderBy
                                    console.log(`[${sessionId}] Falling back to simpler query without orderBy`);
                                    const simpleQuery = await db.collection('reports')
                                        .where('user_email', '==', data.userEmail)
                                        .where('interview_id', '==', data.interviewId)  // Only get previous attempts at THIS interview
                                        .limit(50)  // Increased limit to capture more interview history
                                        .get();
                                    
                                    // Manually sort by end_timestamp if we have results
                                    if (!simpleQuery.empty) {
                                        const docs = [];
                                        simpleQuery.forEach(doc => docs.push(doc));
                                        docs.sort((a, b) => {
                                            const aTime = a.data().start_timestamp?.toDate?.() || a.data().end_timestamp?.toDate?.() || new Date(0);
                                            const bTime = b.data().start_timestamp?.toDate?.() || b.data().end_timestamp?.toDate?.() || new Date(0);
                                            return bTime - aTime; // Descending order
                                        });
                                        previousReportsSnapshot = { 
                                            empty: false, 
                                            size: docs.length,
                                            forEach: (callback) => docs.forEach(callback)
                                        };
                                    } else {
                                        previousReportsSnapshot = simpleQuery;
                                    }
                                }
                                
                                if (!previousReportsSnapshot.empty) {
                                    console.log(`[${sessionId}] Found ${previousReportsSnapshot.size} previous interviews for ${data.userEmail}`);
                                    
                                    // Collect all interview data for summarization
                                    const interviewsData = [];
                                    
                                    // Process each report document (handle both real snapshot and custom object)
                                    const docsArray = previousReportsSnapshot.docs || [];
                                    // If it's our custom object, we need to collect docs differently
                                    if (!previousReportsSnapshot.docs && previousReportsSnapshot.forEach) {
                                        previousReportsSnapshot.forEach(doc => docsArray.push(doc));
                                    }
                                    
                                    for (const doc of docsArray) {
                                        const reportData = doc.data();
                                        const interviewDate = (reportData.end_timestamp || reportData.start_timestamp)?.toDate?.().toLocaleDateString() || 'Unknown date';
                                        const interviewTitle = reportData.report_title || 'Untitled Interview';
                                        const status = reportData.status || 'unknown';
                                        
                                        const interviewInfo = {
                                            title: interviewTitle,
                                            date: interviewDate,
                                            status: status,
                                            content: ''
                                        };
                                        
                                        // Include content based on status
                                        if (reportData.report_content && (status === 'completed' || status === 'regenerated')) {
                                            interviewInfo.content = reportData.report_content;
                                        } else {
                                            // For incomplete interviews, fetch responses from subcollection
                                            try {
                                                console.log(`[${sessionId}] Report ${doc.id} status='${status}' - fetching responses subcollection...`);
                                                let responsesSnapshot;
                                                
                                                try {
                                                    // Try with orderBy first
                                                    responsesSnapshot = await db.collection('reports').doc(doc.id).collection('responses').orderBy('timestamp').get();
                                                } catch (orderError) {
                                                    console.log(`[${sessionId}] OrderBy failed, trying without ordering:`, orderError.message);
                                                    // Fallback without orderBy
                                                    responsesSnapshot = await db.collection('reports').doc(doc.id).collection('responses').get();
                                                }
                                                
                                                if (!responsesSnapshot.empty) {
                                                    console.log(`[${sessionId}] Found ${responsesSnapshot.size} responses for report ${doc.id}`);
                                                    interviewInfo.content = `Incomplete interview with ${responsesSnapshot.size} responses:\n\n`;
                                                    
                                                    // Sort responses if we couldn't use orderBy
                                                    const responses = [];
                                                    responsesSnapshot.forEach(doc => responses.push({id: doc.id, data: doc.data()}));
                                                    responses.sort((a, b) => {
                                                        const aTime = a.data.timestamp?.toDate?.() || new Date(0);
                                                        const bTime = b.data.timestamp?.toDate?.() || new Date(0);
                                                        return aTime - bTime;
                                                    });
                                                    
                                                    responses.forEach((resp) => {
                                                        const response = resp.data;
                                                        interviewInfo.content += `Q: ${response.question || 'Unknown question'}\n`;
                                                        interviewInfo.content += `A: ${response.answer || 'No answer recorded'}\n`;
                                                        if (response.timestamp) {
                                                            interviewInfo.content += `Time: ${response.timestamp.toDate().toLocaleString()}\n`;
                                                        }
                                                        interviewInfo.content += '\n';
                                                    });
                                                } else {
                                                    console.log(`[${sessionId}] No responses found for report ${doc.id}`);
                                                }
                                            } catch (err) {
                                                console.error(`[${sessionId}] Error fetching responses subcollection for report ${doc.id}:`, err.message);
                                            }
                                        }
                                        
                                        interviewsData.push(interviewInfo);
                                    }
                                    
                                    // Generate summary using Claude
                                    try {
                                        console.log(`[${sessionId}] Generating summary of ${interviewsData.length} previous interviews...`);
                                        
                                        // Log content summary for debugging
                                        interviewsData.forEach((interview, idx) => {
                                            const hasContent = interview.content && interview.content.length > 0;
                                            console.log(`[${sessionId}] Interview ${idx + 1}: ${interview.title} - ${hasContent ? `has content (${interview.content.length} chars)` : 'NO CONTENT'}`);
                                        });
                                        
                                        const summaryPrompt = `You are reviewing previous interview history for ${data.userEmail}. 
Please create a concise summary (2-3 paragraphs) that captures:
1. Key themes and topics covered across all interviews
2. Important information learned about the person
3. Any patterns or progression you notice
4. Areas that might be worth exploring further

Previous interviews:
${interviewsData.map((interview, idx) => 
    `Interview ${idx + 1}: ${interview.title} (${interview.date}, ${interview.status})
${interview.content || 'No content available'}`
).join('\n\n---\n\n')}`;

                                        const summaryResponse = await fetch("https://api.anthropic.com/v1/messages", {
                                            method: "POST",
                                            headers: {
                                                "Content-Type": "application/json",
                                                "x-api-key": CLAUDE_API_KEY,
                                                "anthropic-version": "2023-06-01"
                                            },
                                            body: JSON.stringify({
                                                model: "claude-sonnet-4-6",
                                                max_tokens: 500,
                                                messages: [{
                                                    role: "user",
                                                    content: summaryPrompt
                                                }],
                                                temperature: 0.3
                                            })
                                        });
                                        
                                        if (summaryResponse.ok) {
                                            const summaryData = await summaryResponse.json();
                                            const summary = summaryData.content[0].text;
                                            
                                            // Add summary to context
                                            const previousInterviewsSummary = `\n\n--- PREVIOUS INTERVIEW HISTORY ---\n${data.userEmail} has participated in ${previousReportsSnapshot.size} previous interview(s).\n\nSummary:\n${summary}\n--- END PREVIOUS INTERVIEW HISTORY ---\n`;
                                            
                                            sessionData.get(sessionId).contextData += previousInterviewsSummary;
                                            sessionData.get(sessionId).hasPreviousInterviews = true;
                                            sessionData.get(sessionId).previousInterviewsCount = previousReportsSnapshot.size;
                                            
                                            console.log(`[${sessionId}] Successfully generated and added interview history summary`);
                                        } else {
                                            throw new Error(`Summary generation failed: ${summaryResponse.status}`);
                                        }
                                    } catch (summaryError) {
                                        console.error(`[${sessionId}] Error generating summary:`, summaryError);
                                        
                                        // Fallback: Add basic info without summary
                                        const basicSummary = `\n\n--- PREVIOUS INTERVIEW HISTORY ---\n${data.userEmail} has participated in ${previousReportsSnapshot.size} previous interview(s). Unable to generate detailed summary.\n--- END PREVIOUS INTERVIEW HISTORY ---\n`;
                                        sessionData.get(sessionId).contextData += basicSummary;
                                        sessionData.get(sessionId).hasPreviousInterviews = true;
                                        sessionData.get(sessionId).previousInterviewsCount = previousReportsSnapshot.size;
                                    }
                                } else {
                                    console.log(`[${sessionId}] No previous interviews found for ${data.userEmail}`);
                                    sessionData.get(sessionId).hasPreviousInterviews = false;
                                }
                            } catch (error) {
                                console.error(`[${sessionId}] Error fetching previous interviews:`, error);
                                // Continue without previous interview context
                            }
                        }
                        
                        // Store interview metadata
                        sessionData.get(sessionId).interviewTitle = interviewData.title;
                        sessionData.get(sessionId).interviewDescription = interviewData.description;
                        
                        // Also store page headers/subheaders if needed
                        sessionData.get(sessionId).indexHeader = interviewData.indexHeader;
                        sessionData.get(sessionId).indexSubheader = interviewData.indexSubheader;
                        sessionData.get(sessionId).reportHeader = interviewData.reportHeader;
                        sessionData.get(sessionId).reportSubheader = interviewData.reportSubheader;
                        sessionData.get(sessionId).introHeadline = interviewData.introHeadline; // Added introHeadline
                    } else {
                        console.warn(`Interview not found for ID: ${data.interviewId}, using default prompts`);
                        // Store custom prompt if provided directly
                        sessionData.get(sessionId).customPrompt = data.prompt || null;
                    }
                } catch (error) {
                    console.error('Error fetching interview prompts:', error);
                    // Store custom prompt if provided directly as fallback
                    sessionData.get(sessionId).customPrompt = data.prompt || null;
                }
            } else {
                // Store custom prompt if provided directly (legacy support)
                sessionData.get(sessionId).customPrompt = data.prompt || null;
            }
            
            // Capture firstName and isJobSeeking
            if (data.firstName) sessionData.get(sessionId).firstName = data.firstName;
            // if (data.userName) sessionData.get(sessionId).userName = data.userName; // Already handled above
        } else {
            // Backward compatibility: assume data is just the resume
            let baseContext = data; // data is the resume text
            let namePrefix = "";
            let emailPrefix = "";

            // Attempt to get userName even in backward compatibility if present
            if (data && data.userName) {
                 sessionData.get(sessionId).userName = data.userName;
                 namePrefix = `Name: ${data.userName}\n`;
            }
            // Attempt to get userEmail even in backward compatibility if present
            if (data && data.userEmail) {
                sessionData.get(sessionId).userEmail = data.userEmail;
                emailPrefix = `Email: ${data.userEmail}\n`;
            }

            // Reconstruct baseContext if it was an object initially
            let actualResumeText = data;
            if (typeof data === 'object' && data.resume) { 
                actualResumeText = data.resume;
            }
            
            // For backward compatibility, set contextData directly if no interviewId/admin context applies
            sessionData.get(sessionId).contextData = `${namePrefix}${emailPrefix}${namePrefix || emailPrefix ? '\n' : ''}${actualResumeText}`; 
            sessionData.get(sessionId).customPrompt = null;
            
            // Check for previous interviews by email if email is provided (non-template case)
            if (sessionData.get(sessionId).userEmail && db) {
                try {
                    console.log(`[${sessionId}] Checking for previous interviews by email: ${sessionData.get(sessionId).userEmail}`);
                    
                    // Query reports collection for this email
                    // First, let's check if any reports exist for this email at all
                    const allReportsCheck = await db.collection('reports')
                        .where('user_email', '==', sessionData.get(sessionId).userEmail)
                        .limit(10)
                        .get();
                    
                    console.log(`[${sessionId}] Total reports found for ${sessionData.get(sessionId).userEmail}: ${allReportsCheck.size}`);
                    if (!allReportsCheck.empty) {
                        allReportsCheck.forEach(doc => {
                            const data = doc.data();
                            console.log(`[${sessionId}] Report ${doc.id}: status='${data.status}', has end_timestamp=${!!data.end_timestamp}`);
                        });
                    }
                    
                    // Now try the full query
                    let previousReportsSnapshot;
                    try {
                        previousReportsSnapshot = await db.collection('reports')
                            .where('user_email', '==', sessionData.get(sessionId).userEmail)
                            .orderBy('start_timestamp', 'desc')  // Use start_timestamp since all interviews have it
                            .limit(5)
                            .get();
                    } catch (queryError) {
                        console.error(`[${sessionId}] Query error (likely missing index):`, queryError.message);
                        
                        // Fallback: Try simpler query without orderBy
                        console.log(`[${sessionId}] Falling back to simpler query without orderBy`);
                        const simpleQuery = await db.collection('reports')
                            .where('user_email', '==', sessionData.get(sessionId).userEmail)
                            .limit(5)
                            .get();
                        
                        // Manually sort by end_timestamp if we have results
                        if (!simpleQuery.empty) {
                            const docs = [];
                            simpleQuery.forEach(doc => docs.push(doc));
                            docs.sort((a, b) => {
                                const aTime = a.data().start_timestamp?.toDate?.() || a.data().end_timestamp?.toDate?.() || new Date(0);
                                const bTime = b.data().start_timestamp?.toDate?.() || b.data().end_timestamp?.toDate?.() || new Date(0);
                                return bTime - aTime; // Descending order
                            });
                            previousReportsSnapshot = { 
                                empty: false, 
                                size: docs.length,
                                forEach: (callback) => docs.forEach(callback)
                            };
                        } else {
                            previousReportsSnapshot = simpleQuery;
                        }
                    }
                    
                    if (!previousReportsSnapshot.empty) {
                        console.log(`[${sessionId}] Found ${previousReportsSnapshot.size} previous interviews for ${sessionData.get(sessionId).userEmail}`);
                        
                        // Collect all interview data for summarization
                        const interviewsData = [];
                        
                        // Process each report document (handle both real snapshot and custom object)
                        const docsArray = previousReportsSnapshot.docs || [];
                        // If it's our custom object, we need to collect docs differently
                        if (!previousReportsSnapshot.docs && previousReportsSnapshot.forEach) {
                            previousReportsSnapshot.forEach(doc => docsArray.push(doc));
                        }
                        
                        for (const doc of docsArray) {
                            const reportData = doc.data();
                            const interviewDate = (reportData.end_timestamp || reportData.start_timestamp)?.toDate?.().toLocaleDateString() || 'Unknown date';
                            const interviewTitle = reportData.report_title || 'Untitled Interview';
                            const status = reportData.status || 'unknown';
                            
                            const interviewInfo = {
                                title: interviewTitle,
                                date: interviewDate,
                                status: status,
                                content: ''
                            };
                            
                            // Include content based on status
                            if (reportData.report_content && (status === 'completed' || status === 'regenerated')) {
                                interviewInfo.content = reportData.report_content;
                            } else {
                                // For incomplete interviews, fetch responses from subcollection
                                try {
                                    console.log(`[${sessionId}] Report ${doc.id} status='${status}' - fetching responses subcollection...`);
                                    let responsesSnapshot;
                                    
                                    try {
                                        // Try with orderBy first
                                        responsesSnapshot = await db.collection('reports').doc(doc.id).collection('responses').orderBy('timestamp').get();
                                    } catch (orderError) {
                                        console.log(`[${sessionId}] OrderBy failed, trying without ordering:`, orderError.message);
                                        // Fallback without orderBy
                                        responsesSnapshot = await db.collection('reports').doc(doc.id).collection('responses').get();
                                    }
                                    
                                    if (!responsesSnapshot.empty) {
                                        console.log(`[${sessionId}] Found ${responsesSnapshot.size} responses for report ${doc.id}`);
                                        interviewInfo.content = `Incomplete interview with ${responsesSnapshot.size} responses:\n\n`;
                                        
                                        // Sort responses if we couldn't use orderBy
                                        const responses = [];
                                        responsesSnapshot.forEach(doc => responses.push({id: doc.id, data: doc.data()}));
                                        responses.sort((a, b) => {
                                            const aTime = a.data.timestamp?.toDate?.() || new Date(0);
                                            const bTime = b.data.timestamp?.toDate?.() || new Date(0);
                                            return aTime - bTime;
                                        });
                                        
                                        responses.forEach((resp) => {
                                            const response = resp.data;
                                            interviewInfo.content += `Q: ${response.question || 'Unknown question'}\n`;
                                            interviewInfo.content += `A: ${response.answer || 'No answer recorded'}\n`;
                                            if (response.timestamp) {
                                                interviewInfo.content += `Time: ${response.timestamp.toDate().toLocaleString()}\n`;
                                            }
                                            interviewInfo.content += '\n';
                                        });
                                    } else {
                                        console.log(`[${sessionId}] No responses found for report ${doc.id}`);
                                    }
                                } catch (err) {
                                    console.error(`[${sessionId}] Error fetching responses subcollection for report ${doc.id}:`, err.message);
                                }
                            }
                            
                            interviewsData.push(interviewInfo);
                        }
                        
                        // Generate summary using Claude
                        try {
                            console.log(`[${sessionId}] Generating summary of ${interviewsData.length} previous interviews...`);
                            
                            // Log content summary for debugging
                            interviewsData.forEach((interview, idx) => {
                                const hasContent = interview.content && interview.content.length > 0;
                                console.log(`[${sessionId}] Interview ${idx + 1}: ${interview.title} - ${hasContent ? `has content (${interview.content.length} chars)` : 'NO CONTENT'}`);
                            });
                            
                            const summaryPrompt = `You are reviewing previous interview history for ${sessionData.get(sessionId).userEmail}. 
Please create a concise summary (2-3 paragraphs) that captures:
1. Key themes and topics covered across all interviews
2. Important information learned about the person
3. Any patterns or progression you notice
4. Areas that might be worth exploring further

Previous interviews:
${interviewsData.map((interview, idx) => 
    `Interview ${idx + 1}: ${interview.title} (${interview.date}, ${interview.status})
${interview.content || 'No content available'}`
).join('\n\n---\n\n')}`;

                            const summaryResponse = await fetch("https://api.anthropic.com/v1/messages", {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                    "x-api-key": CLAUDE_API_KEY,
                                    "anthropic-version": "2023-06-01"
                                },
                                body: JSON.stringify({
                                    model: "claude-sonnet-4-6",
                                    max_tokens: 500,
                                    messages: [{
                                        role: "user",
                                        content: summaryPrompt
                                    }],
                                    temperature: 0.3
                                })
                            });
                            
                            if (summaryResponse.ok) {
                                const summaryData = await summaryResponse.json();
                                const summary = summaryData.content[0].text;
                                
                                // Add summary to context
                                const previousInterviewsSummary = `\n\n--- PREVIOUS INTERVIEW HISTORY ---\n${sessionData.get(sessionId).userEmail} has participated in ${previousReportsSnapshot.size} previous interview(s).\n\nSummary:\n${summary}\n--- END PREVIOUS INTERVIEW HISTORY ---\n`;
                                
                                sessionData.get(sessionId).contextData += previousInterviewsSummary;
                                sessionData.get(sessionId).hasPreviousInterviews = true;
                                sessionData.get(sessionId).previousInterviewsCount = previousReportsSnapshot.size;
                                
                                console.log(`[${sessionId}] Successfully generated and added interview history summary`);
                            } else {
                                throw new Error(`Summary generation failed: ${summaryResponse.status}`);
                            }
                        } catch (summaryError) {
                            console.error(`[${sessionId}] Error generating summary:`, summaryError);
                            
                            // Fallback: Add basic info without summary
                            const basicSummary = `\n\n--- PREVIOUS INTERVIEW HISTORY ---\n${sessionData.get(sessionId).userEmail} has participated in ${previousReportsSnapshot.size} previous interview(s). Unable to generate detailed summary.\n--- END PREVIOUS INTERVIEW HISTORY ---\n`;
                            sessionData.get(sessionId).contextData += basicSummary;
                            sessionData.get(sessionId).hasPreviousInterviews = true;
                            sessionData.get(sessionId).previousInterviewsCount = previousReportsSnapshot.size;
                        }
                    } else {
                        console.log(`[${sessionId}] No previous interviews found for ${sessionData.get(sessionId).userEmail}`);
                        sessionData.get(sessionId).hasPreviousInterviews = false;
                    }
                } catch (error) {
                    console.error(`[${sessionId}] Error fetching previous interviews:`, error);
                    // Continue without previous interview context
                }
            }
        }
        
        sessionData.get(sessionId).interviewResponses = [];
        sessionData.get(sessionId).assistantQuestions = []; // Reset assistant questions
        sessionData.get(sessionId).firstQuestionThinking = null; // Initialize storage for first question thinking
        sessionData.get(sessionId).totalRecordingDuration = 0; // Reset recording duration
        sessionData.get(sessionId).enableWebSearch = data.enableWebSearch !== undefined ? data.enableWebSearch : true; // STORE web search flag, default true
        sessionData.get(sessionId).enableThinking = data.enableThinking !== undefined ? data.enableThinking : true; // STORE thinking flag, default true
        sessionData.get(sessionId).enableMemoryService = data.enableMemoryService !== undefined ? data.enableMemoryService : true; // STORE memory service flag, default true
        sessionData.get(sessionId).followupModel = data.followupModel || 'claude-sonnet-4-6'; // STORE followup model, default to Claude Sonnet 4
        sessionData.get(sessionId).enableVideoRecording = data.enableVideoRecording !== undefined ? data.enableVideoRecording : false; // STORE video recording flag, default false
        if (data.storyId) sessionData.get(sessionId).storyId = data.storyId; // Story mode session ID
        if (data.mode) sessionData.get(sessionId).mode = data.mode;

        // DEBUG: Log what we're actually storing
        console.log('=== DEBUGGING SESSION SETTINGS ===');
        console.log('enableWebSearch from client:', data.enableWebSearch);
        console.log('enableThinking from client:', data.enableThinking);
        console.log('enableMemoryService from client:', data.enableMemoryService);
        console.log('followupModel from client:', data.followupModel);
        console.log('enableVideoRecording from client:', data.enableVideoRecording);
        console.log('enableWebSearch stored:', sessionData.get(sessionId).enableWebSearch);
        console.log('enableThinking stored:', sessionData.get(sessionId).enableThinking);
        console.log('enableMemoryService stored:', sessionData.get(sessionId).enableMemoryService);
        console.log('followupModel stored:', sessionData.get(sessionId).followupModel);
        console.log('enableVideoRecording stored:', sessionData.get(sessionId).enableVideoRecording);
        console.log('=== END SESSION SETTINGS DEBUG ===');
        
        // Generate and store a persistent session ID
        const persistentSessionId = uuidv4();
        sessionData.get(sessionId).persistentSessionId = persistentSessionId;
        console.log(`[${sessionId}] Generated Persistent Session ID (used as Report Document ID): ${persistentSessionId}`);
        
        // --- START: Create initial report document in Firestore ---
        if (db) {
            try {
                const reportDocRef = db.collection('reports').doc(persistentSessionId);
                const initialReportData = {
                    persistent_session_id: persistentSessionId,
                    socket_session_id: sessionId,
                    interview_id: sessionData.get(sessionId).interviewId || null, // Store interview ID if available
                    user_name: sessionData.get(sessionId).userName || null,
                    user_email: sessionData.get(sessionId).userEmail || null,
                    start_timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    status: 'started', // Indicate the report is in progress
                    total_recording_duration: 0, // Ensure this field is for recording duration
                    report_title: sessionData.get(sessionId).reportHeader || sessionData.get(sessionId).interviewTitle || null, // Use headers or title if available
                    report_subtitle: sessionData.get(sessionId).reportSubheader || sessionData.get(sessionId).interviewDescription || null, // Use subheaders or description if available
                    utm_params: sessionData.get(sessionId).utmParams || null, // Store UTM tracking parameters
                    story_id: sessionData.get(sessionId).storyId || null // Story mode association (null for regular interviews)
                };
                await reportDocRef.set(initialReportData);
                console.log(`[${sessionId}] Initial report document created in Firestore with ID: ${persistentSessionId}`);
            } catch (error) {
                console.error(`[${sessionId}] Error creating initial report document in Firestore:`, error);
                // Proceed even if report creation fails initially, maybe log differently later?
            }
        } else {
            console.warn(`[${sessionId}] Firebase not available, skipping initial report document creation.`);
        }
        // --- END: Create initial report document in Firestore ---
        
        // Debug: Log the session data right before calling generateNextQuestion
        const sessionDebug = sessionData.get(sessionId);
        console.log('\n======= SESSION DATA DEBUG =======');
        console.log('Session ID:', sessionId);
        console.log('Interview ID (raw):', data.interviewId || 'Not provided');
        // Check if interviewIdStr is defined in this scope
        console.log('Interview ID (processed):', (typeof interviewIdStr !== 'undefined' ? interviewIdStr : 'Not available in this scope'));
        console.log('Context Data Length:', sessionDebug.contextData ? sessionDebug.contextData.length : 0);
        console.log('Custom prompt stored:', sessionDebug.customPrompt ? 'YES' : 'NO');
        console.log('Custom prompt length:', sessionDebug.customPrompt ? sessionDebug.customPrompt.length : 0);
        console.log('Follow-up prompt stored:', sessionDebug.followupPrompt ? 'YES' : 'NO');
        console.log('Session data keys:', Object.keys(sessionDebug));
        console.log('======= END SESSION DATA DEBUG =======\n');
        
        // Store the interview ID for potential recovery
        if (typeof interviewIdStr !== 'undefined' && interviewIdStr) {
            sessionData.get(sessionId).interviewId = interviewIdStr;
        } else if (data.interviewId) {
            // Fallback to using the raw interviewId from data
            sessionData.get(sessionId).interviewId = String(data.interviewId).trim();
            console.log('Using raw interviewId for recovery:', data.interviewId);
        }
        
        await generateNextQuestion();
    });

    socket.on('retryLastQuestion', async () => {
        console.log(`[${sessionId}] Retry last question requested`);
        
        const sessionInfo = sessionData.get(sessionId);
        if (!sessionInfo) {
            console.error(`[${sessionId}] Session data missing for retry`);
            socket.emit('error', 'Session expired. Please refresh the page.');
            return;
        }
        
        // Check if we have a valid interview state
        if (!sessionInfo.interviewResponses || !sessionInfo.assistantQuestions) {
            console.error(`[${sessionId}] Invalid interview state for retry`);
            socket.emit('error', 'Cannot retry - interview state invalid.');
            return;
        }
        
        console.log(`[${sessionId}] Retrying question generation with same context`);
        console.log(`[${sessionId}] Current responses: ${sessionInfo.interviewResponses.length}, questions: ${sessionInfo.assistantQuestions.length}`);
        
        // Call generateNextQuestion without adding a new response
        // This will use the existing context and regenerate the last question
        await generateNextQuestion();
    });

    socket.on('stopInterview', async () => {
        // Store the sessionId in a cookie to retrieve it on the report page
        socket.emit('storeSessionId', sessionId);

        // Get session info to pass the persistent session ID as report ID
        const sessionInfo = sessionData.get(sessionId);
        const reportId = sessionInfo?.persistentSessionId;
        const interviewId = sessionInfo?.interviewId;

        // ── Story mode: skip Prompter report generation and redirect to story.html ──
        const isStoryMode = interviewId === 'story-template-v1';
        if (isStoryMode) {
            const storyId = sessionInfo?.storyId || null;

            // Save transcript to Firestore story document
            if (storyId && db) {
                try {
                    const questions = (sessionInfo?.assistantQuestions || []).map(q => typeof q === 'string' ? q : (q.text || q.question || JSON.stringify(q)));
                    const responses = sessionInfo?.interviewResponses || [];
                    const transcript = [];
                    const maxLen = Math.max(questions.length, responses.length);
                    for (let i = 0; i < maxLen; i++) {
                        if (questions[i]) transcript.push({ role: 'interviewer', text: questions[i] });
                        if (responses[i]) transcript.push({ role: 'user', text: responses[i] });
                    }
                    await db.collection('stories').doc(storyId).update({
                        status: 'review',
                        transcript,
                        completedAt: admin.firestore.FieldValue.serverTimestamp(),
                        interviewReportId: sessionInfo?.persistentSessionId || null,
                    });
                    console.log(`[${sessionId}] Story transcript saved to Firestore for storyId: ${storyId}`);
                } catch (err) {
                    console.error(`[${sessionId}] Failed to save story transcript:`, err.message);
                }
            }

            const redirectUrl = '/story-notes.html' + (storyId ? '?storyId=' + encodeURIComponent(storyId) : '');
            socket.emit('redirectToReport', { storyMode: true, redirectUrl });
            // Clean up Deepgram if active
            if (sessionInfo?.deepgramSocket) {
                sessionInfo.deepgramSocket.finish();
                sessionInfo.deepgramSocket = null;
                if (sessionInfo.keepAliveInterval) {
                    clearInterval(sessionInfo.keepAliveInterval);
                    sessionInfo.keepAliveInterval = null;
                }
            }
            return;
        }
        
        // For testing: if no responses, add minimal test data
        if (sessionInfo && (!sessionInfo.interviewResponses || sessionInfo.interviewResponses.length === 0)) {
            console.log(`[${sessionId}] WARNING: No interview responses found, adding test data for development`);
            sessionInfo.interviewResponses = ["This is a test response for development purposes. I'm interested in AI and machine learning."];
            sessionInfo.assistantQuestions = [{text: "Tell me about your interests in technology and AI."}];
            sessionInfo.contextData = "Test user with interests in AI and technology.";
            sessionInfo.firstName = sessionInfo.firstName || "Test User";
            
            // Ensure we have a persistentSessionId for test data
            if (!sessionInfo.persistentSessionId) {
                sessionInfo.persistentSessionId = `test-report-${Date.now()}`;
                console.log(`[${sessionId}] Generated test persistentSessionId: ${sessionInfo.persistentSessionId}`);
            }
        }
        
        // DON'T redirect immediately - wait for report generation to complete
        
        // Generate both user and admin reports in parallel (non-blocking)
        if (sessionInfo && sessionInfo.persistentSessionId) {
            console.log(`[${sessionId}] Starting generation of both user and admin reports`);
            
            // Mark that report generation is in progress
            sessionInfo.reportGenerationInProgress = true;
            sessionInfo.reportGenerationStartTime = Date.now();
            
            // Generate both reports in parallel without blocking the redirect
            const reportPromises = [
                generateReport(null, sessionId).catch(err => {
                    console.error(`[${sessionId}] Error generating user report:`, err);
                    console.error(`[${sessionId}] Error details:`, err.message || err);
                    console.error(`[${sessionId}] Stack trace:`, err.stack);
                    
                    // Notify connected sockets about the error
                    if (sessionInfo.reportListeners) {
                        sessionInfo.reportListeners.forEach(listenerSocket => {
                            if (listenerSocket.connected) {
                                listenerSocket.emit('reportGenerationError', {
                                    message: 'Failed to generate user report',
                                    code: 'USER_REPORT_GENERATION_FAILED',
                                    details: err.message
                                });
                            }
                        });
                    }
                    return null;
                }),
                generateAdminReport(sessionId, sessionInfo.persistentSessionId).catch(err => {
                    console.error(`[${sessionId}] Error generating admin report:`, err);
                    console.error(`[${sessionId}] Error details:`, err.message || err);
                    console.error(`[${sessionId}] Stack trace:`, err.stack);
                    return null;
                })
            ];
            
            // Wait for reports to complete before redirecting
            Promise.all(reportPromises).then(([userReport, adminReport]) => {
                console.log(`[${sessionId}] Report generation complete. User report: ${userReport ? 'success' : 'failed'}, Admin report: ${adminReport ? 'success' : 'failed'}`);
                
                // Mark generation as complete
                if (sessionInfo) {
                    sessionInfo.reportGenerationInProgress = false;
                    sessionInfo.reportGenerationCompleted = true;
                    
                    // Clean up report listeners
                    if (sessionInfo.reportListeners) {
                        sessionInfo.reportListeners.clear();
                        delete sessionInfo.reportListeners;
                    }
                }
                
                // NOW redirect to the report page
                socket.emit('redirectToReport', { 
                    reportId: reportId,
                    interviewId: interviewId 
                });
            }).catch(err => {
                console.error(`[${sessionId}] Error in report generation:`, err);
                
                // Mark generation as complete even on error
                if (sessionInfo) {
                    sessionInfo.reportGenerationInProgress = false;
                    sessionInfo.reportGenerationError = true;
                }
                
                // Send error to client
                socket.emit('reportGenerationError', {
                    message: 'Failed to generate report. Please try again.',
                    code: 'REPORT_GENERATION_FAILED'
                });
            });
        }
        
        // Clean up Deepgram connection if any
        if (sessionInfo && sessionInfo.deepgramSocket) {
            console.log(`[${sessionId}] Closing Deepgram socket due to stopInterview.`);
            sessionInfo.deepgramSocket.finish();
            sessionInfo.deepgramSocket = null;
            if (sessionInfo.keepAliveInterval) {
                clearInterval(sessionInfo.keepAliveInterval);
                sessionInfo.keepAliveInterval = null;
            }
        }
    });

    socket.on('endStory', async () => {
        const sessionInfo = sessionData.get(sessionId);
        const storyId = sessionInfo?.storyId;

        // Deepgram teardown
        if (sessionInfo?.deepgramSocket) {
            console.log(`[${sessionId}] endStory: Closing Deepgram socket.`);
            sessionInfo.deepgramSocket.finish();
            sessionInfo.deepgramSocket = null;
            if (sessionInfo.keepAliveInterval) {
                clearInterval(sessionInfo.keepAliveInterval);
                sessionInfo.keepAliveInterval = null;
            }
        }

        // Save transcript and set status to 'analyzing'
        if (storyId && db) {
            try {
                const questions = (sessionInfo?.assistantQuestions || []).map(q =>
                    typeof q === 'string' ? q : (q.text || q.question || JSON.stringify(q))
                );
                const responses = sessionInfo?.interviewResponses || [];
                const transcript = [];
                const maxLen = Math.max(questions.length, responses.length);
                for (let i = 0; i < maxLen; i++) {
                    if (questions[i]) transcript.push({ role: 'interviewer', text: questions[i] });
                    if (responses[i]) transcript.push({ role: 'user', text: responses[i] });
                }
                await db.collection('stories').doc(storyId).update({
                    status: 'analyzing',
                    transcript,
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                    interviewReportId: sessionInfo?.persistentSessionId || null,
                });
                console.log(`[${sessionId}] endStory: Transcript saved for storyId: ${storyId}`);
            } catch (err) {
                console.error(`[${sessionId}] endStory: Failed to save transcript:`, err.message);
            }
        }

        // Redirect immediately — story-notes.html polls Firestore while analysis runs
        socket.emit('redirectToReport', {
            storyMode: true,
            redirectUrl: '/story-notes.html' + (storyId ? '?storyId=' + encodeURIComponent(storyId) : '')
        });

        // Analysis runs in background after redirect
        try {
            const storyAnalysis = require('./server/utils/storyAnalysis');
            storyAnalysis.generateStoryAnalysis(sessionId, storyId, sessionInfo, db, admin)
                .catch(err => console.error(`[${sessionId}] endStory analysis error:`, err.message));
        } catch (err) {
            console.error(`[${sessionId}] endStory: Could not load storyAnalysis module:`, err.message);
        }
    });

    socket.on('startFinalTelling', async ({ storyId } = {}) => {
        if (!storyId) {
            socket.emit('finalTellingError', { message: 'Missing storyId' });
            return;
        }

        const finalReportId = uuidv4();
        const finalResponseDocId = uuidv4();

        sessionData.set(sessionId, {
            persistentSessionId: finalReportId,
            storyId,
            mode: 'final_telling',
            finalResponseDocId,
            currentTranscription: '',
            currentWordTimestamps: [],
            interviewResponses: [],
            assistantQuestions: [],
            totalRecordingDuration: 0,
            enableWebSearch: false,
            enableThinking: false,
            enableMemoryService: false,
            interviewId: null,
        });

        let interviewId = null;

        if (db) {
            try {
                const storyDoc = await db.collection('stories').doc(storyId).get();
                if (storyDoc.exists) {
                    const interviewReportId = storyDoc.data().interviewReportId;
                    if (interviewReportId) {
                        const reportDoc = await db.collection('reports').doc(interviewReportId).get();
                        if (reportDoc.exists) interviewId = reportDoc.data().interview_id || null;
                    }
                }
            } catch (err) {
                console.error(`[${sessionId}] startFinalTelling: DB lookup error:`, err.message);
            }

            try {
                await db.collection('reports').doc(finalReportId).set({
                    persistent_session_id: finalReportId,
                    socket_session_id: sessionId,
                    interview_id: interviewId,
                    story_id: storyId,
                    report_type: 'final_telling',
                    status: 'recording',
                    start_timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    total_recording_duration: 0,
                });
                await db.collection('reports').doc(finalReportId)
                    .collection('responses').doc(finalResponseDocId).set({
                        response_id: finalResponseDocId,
                        persistent_session_id: finalReportId,
                        interview_id: interviewId,
                        story_id: storyId,
                        question: 'Final Telling',
                        answer: null,
                        word_timestamps: null,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    });
            } catch (err) {
                console.error(`[${sessionId}] startFinalTelling: Firestore write error:`, err.message);
            }
        }

        sessionData.get(sessionId).interviewId = interviewId;
        console.log(`[${sessionId}] startFinalTelling ready: reportId=${finalReportId}, interviewId=${interviewId}`);
        socket.emit('finalTellingReady', { reportId: finalReportId, responseDocId: finalResponseDocId, interviewId });
    });

    socket.on('stopFinalTelling', async () => {
        const sessionInfo = sessionData.get(sessionId);
        if (!sessionInfo || sessionInfo.mode !== 'final_telling') return;

        const { storyId, persistentSessionId: finalReportId, finalResponseDocId } = sessionInfo;
        const wordTimestamps = sessionInfo.currentWordTimestamps || [];
        const rawTranscription = (sessionInfo.currentTranscription || '').trim();
        const finalTranscript = wordTimestamps.length > 0
            ? assembleTranscriptWithPauses(wordTimestamps)
            : rawTranscription;

        if (db) {
            try {
                if (finalTranscript || wordTimestamps.length > 0) {
                    await db.collection('reports').doc(finalReportId)
                        .collection('responses').doc(finalResponseDocId)
                        .update({ answer: finalTranscript, word_timestamps: wordTimestamps });
                }
                await db.collection('reports').doc(finalReportId).update({ status: 'awaiting_upload' });
                if (storyId) {
                    await db.collection('stories').doc(storyId).update({
                        finalReportId,
                        status: 'final_recorded',
                        finalRecordedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                }
                console.log(`[${sessionId}] stopFinalTelling: Firestore updated for storyId=${storyId}`);
            } catch (err) {
                console.error(`[${sessionId}] stopFinalTelling: Firestore update error:`, err.message);
            }
        }

        socket.emit('finalTellingEnded', { reportId: finalReportId });
    });

    // New event for when client is ready at the report page
    socket.on('requestReport', async (previousSessionId) => {
        // Use the provided session ID or fallback to current socket ID
        const reportSessionId = previousSessionId || sessionId;
        // Log the received session ID
        console.log(`Received requestReport event for session ID: ${reportSessionId} (previousSessionId was: ${previousSessionId})`);
        
        // Retrieve the session data
        if (sessionData.has(reportSessionId)) {
            const sessionInfo = sessionData.get(reportSessionId);
            // Update last active timestamp
            sessionInfo.lastActive = Date.now();
            
            // Check if report generation is already in progress
            if (sessionInfo.reportGenerationInProgress) {
                console.log(`Report generation already in progress for session ${reportSessionId}, adding socket to listeners...`);
                
                // Add this socket to the report generation listeners
                if (!sessionInfo.reportListeners) {
                    sessionInfo.reportListeners = new Set();
                }
                sessionInfo.reportListeners.add(socket);
                console.log(`Added socket ${socket.id} to report listeners for session ${reportSessionId}`);
                
                // Emit event to show shape overlay while waiting
                socket.emit('showGenerationInProgress', {
                    message: 'Your report is being generated',
                    subtitle: 'Please wait while we complete your report...'
                });
                
                // If thinking has already started, emit that event too
                if (sessionInfo.reportThinkingStarted) {
                    console.log(`Report thinking already started for session ${reportSessionId}, emitting reportThinkingStarted to new socket`);
                    socket.emit('reportThinkingStarted');
                    
                    // If we have accumulated thinking trace, send it to catch up
                    if (sessionInfo.accumulatedThinkingTrace) {
                        console.log(`Sending accumulated thinking trace (${sessionInfo.accumulatedThinkingTrace.length} chars) to new socket`);
                        socket.emit('reportThinkingUpdate', sessionInfo.accumulatedThinkingTrace);
                    }
                }
                
                // Clean up listener on disconnect
                socket.on('disconnect', () => {
                    if (sessionInfo.reportListeners) {
                        sessionInfo.reportListeners.delete(socket);
                        console.log(`Removed disconnected socket ${socket.id} from report listeners`);
                    }
                });
                
                // Wait for report generation to complete (with timeout)
                const maxWaitTime = 60000; // 60 seconds timeout
                const checkInterval = 1000; // Check every second
                let waitedTime = 0;
                
                const waitForReport = setInterval(async () => {
                    waitedTime += checkInterval;
                    
                    // Check if generation completed, failed, or timed out
                    if (!sessionInfo.reportGenerationInProgress || sessionInfo.reportGenerationError || waitedTime >= maxWaitTime) {
                        clearInterval(waitForReport);
                        
                        if (sessionInfo.reportGenerationError) {
                            console.error(`Report generation failed for session ${reportSessionId}`);
                            socket.emit('error', 'Report generation encountered an issue. Please try refreshing the page.');
                            return;
                        }
                        
                        if (waitedTime >= maxWaitTime) {
                            console.error(`Report generation timed out for session ${reportSessionId}`);
                            socket.emit('error', 'Report generation is taking longer than expected. Please try refreshing the page.');
                            return;
                        }
                        
                        // Try to fetch the report from Firestore
                        if (sessionInfo.persistentSessionId && db) {
                            try {
                                const reportDoc = await db.collection('reports').doc(sessionInfo.persistentSessionId).get();
                                if (reportDoc.exists) {
                                    const reportData = reportDoc.data();
                                    if (reportData.report_content) {
                                        console.log(`Report found in Firestore for session ${reportSessionId}, emitting content`);
                                        socket.emit('reportComplete', {
                                            reportContent: reportData.report_content,
                                            reportTitle: reportData.report_title || 'Your Report',
                                            reportSubtitle: reportData.report_subtitle || 'Your personalized assessment'
                                        });
                                        socket.emit('reportGeneratedWithId', { reportId: sessionInfo.persistentSessionId });
                                        return;
                                    }
                                }
                            } catch (error) {
                                console.error(`Error fetching report after generation for session ${reportSessionId}:`, error);
                            }
                        }
                        
                        // If we get here, report generation may have failed
                        console.error(`Report generation may have failed for session ${reportSessionId}`);
                        socket.emit('error', 'Report generation encountered an issue. Please try refreshing the page.');
                    }
                }, checkInterval);
                
                return;
            }
            
            // Check if report already exists in Firestore before generating
            if (sessionInfo.persistentSessionId && db) {
                try {
                    const reportDoc = await db.collection('reports').doc(sessionInfo.persistentSessionId).get();
                    if (reportDoc.exists) {
                        const reportData = reportDoc.data();
                        if (reportData.report_content) {
                            console.log(`Report already exists for session ${reportSessionId}, emitting existing content instead of regenerating`);
                            // Emit the existing report content without regenerating or sending email
                            socket.emit('reportComplete', {
                                reportContent: reportData.report_content,
                                reportTitle: reportData.report_title || 'Your Report',
                                reportSubtitle: reportData.report_subtitle || 'Your personalized assessment'
                            });
                            socket.emit('reportGeneratedWithId', { reportId: sessionInfo.persistentSessionId });
                            return;
                        }
                    }
                } catch (error) {
                    console.error(`Error checking existing report for session ${reportSessionId}:`, error);
                    // Fall through to generate new report if check fails
                }
            }
            
            // Only generate report if it doesn't exist yet and isn't being generated
            console.log(`No existing report found for session ${reportSessionId}, generating new report`);
            sessionInfo.reportGenerationInProgress = true;
            sessionInfo.reportGenerationStartTime = Date.now();
            
            generateReport(null, reportSessionId).then(() => {
                sessionInfo.reportGenerationInProgress = false;
                sessionInfo.reportGenerationCompleted = true;
                
                // Clean up report listeners
                if (sessionInfo.reportListeners) {
                    sessionInfo.reportListeners.clear();
                    delete sessionInfo.reportListeners;
                }
            }).catch(err => {
                console.error(`Error generating report for session ${reportSessionId}:`, err);
                sessionInfo.reportGenerationInProgress = false;
                sessionInfo.reportGenerationError = true;
            });
        } else {
            console.error('Session data not found for ID:', reportSessionId);
            socket.emit('error', 'Interview data not found for report generation. Your session may have expired.');
        }
    });

    // NEW: Event handler for regenerating report with streaming UI
    socket.on('regenerateReportWithStreaming', async (data) => {
        // Validate socket data
        const validation = validateAndSanitizeSocketEvent('regenerateReportWithStreaming', data, socket);
        if (!validation.isValid) return;
        data = validation.data;
        
        // Apply rate limiting for report regeneration
        if (!socketRateLimiter.checkLimit(socket.id, 'regenerateReport', socketLimits.regenerateReport.limit, socketLimits.regenerateReport.windowMs)) {
            socket.emit('error', 'Too many report regeneration requests. Please wait before trying again.');
            return;
        }
        
        const { reportId, interviewId } = data || {};
        console.log(`[${socket.id}] Received regenerateReportWithStreaming for reportId: ${reportId}, interviewId: ${interviewId}`);
        
        if (!reportId) {
            console.error(`[${socket.id}] No reportId provided for regenerateReportWithStreaming`);
            socket.emit('error', 'Report ID is required for regeneration.');
            return;
        }

        try {
            // Fetch the existing report document from Firestore to get session data
            if (!db) {
                throw new Error('Database not available for report regeneration');
            }

            console.log(`[${socket.id}] Fetching report document: ${reportId}`);
            const reportDoc = await db.collection('reports').doc(reportId).get();
            
            if (!reportDoc.exists) {
                throw new Error(`Report ${reportId} not found in database`);
            }

            const reportData = reportDoc.data();
            console.log(`[${socket.id}] Report data loaded, interview_id: ${reportData.interview_id}`);

            // Fetch the interview specification to get custom prompts
            const actualInterviewId = interviewId || reportData.interview_id;
            let interviewSpec = null;
            
            if (actualInterviewId) {
                console.log(`[${socket.id}] Fetching interview specification: ${actualInterviewId}`);
                const interviewDoc = await db.collection('interviews').doc(actualInterviewId).get();
                
                if (interviewDoc.exists) {
                    interviewSpec = interviewDoc.data();
                    console.log(`[${socket.id}] Interview spec loaded: ${interviewSpec.title}, custom reportPrompt available: ${!!interviewSpec.reportPrompt}`);
                } else {
                    console.warn(`[${socket.id}] Interview specification ${actualInterviewId} not found, using defaults`);
                }
            } else {
                console.warn(`[${socket.id}] No interview ID available for custom prompts, using defaults`);
            }

            // Fetch existing session data from the report
            const sessionInfo = {
                resume: reportData.resume || 'No resume data available',
                responses: [],
                questions: [],
                firstName: reportData.firstName || reportData.userName || 'User',
                reportTitle: reportData.report_title || 'Report',
                reportSubtitle: reportData.report_subtitle || 'Your personalized assessment',
                customReportPrompt: interviewSpec?.reportPrompt || null, // Use custom prompt if available
                persistentSessionId: reportId,
                userName: reportData.userName || reportData.firstName || 'User',
                userEmail: reportData.userEmail || reportData.user_email || 'user@example.com',
                totalWordCount: 0,
                interviewId: actualInterviewId
            };

            // Fetch Q&A pairs from the responses subcollection
            console.log(`[${socket.id}] Fetching responses for report: ${reportId}`);
            const responsesSnapshot = await db.collection('reports').doc(reportId).collection('responses')
                .orderBy('timestamp', 'asc').get();

            responsesSnapshot.forEach(doc => {
                const responseData = doc.data();
                sessionInfo.responses.push(responseData.answer || '');
                sessionInfo.questions.push(responseData.question || '');
                sessionInfo.totalWordCount += (responseData.answer || '').split(' ').length;
            });

            console.log(`[${socket.id}] Session data prepared with ${sessionInfo.responses.length} responses, using ${sessionInfo.customReportPrompt ? 'CUSTOM' : 'DEFAULT'} prompt`);

            // Store session data for generateReport to use
            sessionData.set(socket.id, {
                contextData: sessionInfo.resume,
                responses: sessionInfo.responses,
                questions: sessionInfo.questions,
                firstName: sessionInfo.firstName,
                reportPrompt: sessionInfo.customReportPrompt, // This needs to match what generateReport expects
                reportHeader: sessionInfo.reportTitle,
                reportSubheader: sessionInfo.reportSubtitle,
                persistentSessionId: sessionInfo.persistentSessionId,
                userName: sessionInfo.userName,
                userEmail: sessionInfo.userEmail,
                totalRecordingDuration: sessionInfo.totalWordCount,
                interviewId: sessionInfo.interviewId,
                lastActive: Date.now()
            });

            // Call generateReport with the session ID (this will use streaming)
            await generateReport(null, socket.id);

        } catch (error) {
            console.error(`[${socket.id}] Error in regenerateReportWithStreaming:`, error);
            socket.emit('error', `Failed to regenerate report: ${error.message}`);
        }
    });

    // --- Helper function to process final transcription and continue interview flow ---
    async function processFinalTranscriptionAndContinue(currentSessionId, sessionInfoToProcess, contextSource) {
        const transcriptionProcessStartTime = Date.now();
        console.log(`[${currentSessionId}] 🎤 TRANSCRIPTION PROCESSING - Starting at ${new Date().toISOString()} (via ${contextSource})`);
        
        const finalWordTimestamps = sessionInfoToProcess.currentWordTimestamps;
        // Build transcript from word timestamps when available so that [pause] and
        // [long pause] markers are included for Claude to read. Fall back to the
        // plain concatenated string if no word-level data exists.
        const finalTranscript = finalWordTimestamps && finalWordTimestamps.length > 0
            ? assembleTranscriptWithPauses(finalWordTimestamps)
            : sessionInfoToProcess.currentTranscription.trim();

        // console.log(`[${currentSessionId}] Final combined transcript from Deepgram (via ${contextSource}): "${finalTranscript}"`);
        // console.log(`[${currentSessionId}] Final combined word timestamps count (via ${contextSource}): ${finalWordTimestamps.length}`);
        
        // Use the 'socket' object from the io.on('connection', (socket) => { ... }) scope
        socket.emit('finalTranscriptionResult', { 
            transcript: finalTranscript, 
            wordTimestamps: finalWordTimestamps 
        });

        if (finalTranscript) {
            sessionInfoToProcess.interviewResponses.push(finalTranscript);

            const currentWordCount = countWords(finalTranscript);
            sessionInfoToProcess.totalRecordingDuration = (sessionInfoToProcess.totalRecordingDuration || 0) + currentWordCount;
            // console.log(`[${currentSessionId}] Current response words: ${currentWordCount}, Total session words: ${sessionInfoToProcess.totalRecordingDuration}`);

            const lastQuestionObj = sessionInfoToProcess.assistantQuestions.length > 0 
                ? sessionInfoToProcess.assistantQuestions[sessionInfoToProcess.assistantQuestions.length - 1] 
                : null;
                
            const lastQuestion = lastQuestionObj ? lastQuestionObj.text : null;
            const thinkingTrace = lastQuestionObj ? lastQuestionObj.thinkingBlock : null;
            
            // MODIFICATION START: Get responseDocId and emit 'transcriptionLogged'
            const firebaseLogStartTime = Date.now();
            console.log(`[${currentSessionId}] 🔥 FIREBASE LOGGING - Starting response log at ${new Date().toISOString()}`);
            
            const responseDocId = await logResponseToFirebase(currentSessionId, { // Added await and capture ID
                interviewId: sessionInfoToProcess.interviewId || null,
                question: lastQuestion,
                answer: finalTranscript,
                thinkingTrace: thinkingTrace,
                fullPrompt: sessionInfoToProcess.lastFullPrompt || null,
                audioGcsUrl: null, 
                wordTimestamps: finalWordTimestamps 
            }, sessionInfoToProcess.persistentSessionId);
            
            const firebaseLogDuration = Date.now() - firebaseLogStartTime;
            console.log(`[${currentSessionId}] 🔥 FIREBASE LOGGING - Response logged in ${firebaseLogDuration}ms`);

            if (responseDocId) {
                socket.emit('transcriptionLogged', { 
                    responseDocId: responseDocId,
                    persistentSessionId: sessionInfoToProcess.persistentSessionId 
                });
                console.log(`[${currentSessionId}] Emitted 'transcriptionLogged' with responseDocId: ${responseDocId}`);
            } else {
                console.warn(`[${currentSessionId}] Did not get responseDocId from logResponseToFirebase. Cannot emit 'transcriptionLogged'.`);
            }
            // MODIFICATION END

            // Save to memory service if user email and interview ID are available
            // TEMPORARILY DISABLED - Memory service causing 25+ second delays
            if (false && sessionInfoToProcess.userEmail && sessionInfoToProcess.interviewId) {
                const memoryStartTime = Date.now();
                console.log(`[${currentSessionId}] 🧠 MEMORY SERVICE - Starting memory save operation at ${new Date().toISOString()}`);
                
                // Check if this is an admin user
                let isAdmin = false;
                if (sessionInfoToProcess.adminEmail && sessionInfoToProcess.userEmail) {
                    // If adminEmail was provided and matches userEmail, this is an admin taking their own interview
                    isAdmin = sessionInfoToProcess.adminEmail === sessionInfoToProcess.userEmail;
                    console.log(`[${currentSessionId}] Admin detection: userEmail=${sessionInfoToProcess.userEmail}, adminEmail=${sessionInfoToProcess.adminEmail}, isAdmin=${isAdmin}`);
                } else {
                    console.log(`[${currentSessionId}] Admin detection: No admin email provided, treating as guest user`);
                }
                
                // Create Q&A pair for this response
                const qaPair = {
                    question: lastQuestion,
                    answer: finalTranscript,
                    timestamp: new Date().toISOString()
                };
                
                // Add to memory only for this specific Q&A (not all previous ones)
                // Make this NON-BLOCKING to avoid delaying the interview flow
                // Only add to memory if memory service is enabled for this interview
                if (sessionInfoToProcess.enableMemoryService) {
                    const memoryAddStartTime = Date.now();
                    
                    // Validate required fields before making memory service call
                    const isValidForMemory = (
                        sessionInfoToProcess.userEmail && 
                        typeof sessionInfoToProcess.userEmail === 'string' &&
                        sessionInfoToProcess.interviewId && 
                        typeof sessionInfoToProcess.interviewId === 'string' &&
                        sessionInfoToProcess.persistentSessionId && 
                        typeof sessionInfoToProcess.persistentSessionId === 'string' &&
                        lastQuestion && 
                        typeof lastQuestion === 'string' &&
                        finalTranscript && 
                        typeof finalTranscript === 'string'
                    );
                    
                    if (!isValidForMemory) {
                        console.warn(`[${currentSessionId}] 🧠 MEMORY SERVICE - Invalid data for memory service. Skipping memory save.`, {
                            userEmail: sessionInfoToProcess.userEmail,
                            interviewId: sessionInfoToProcess.interviewId,
                            persistentSessionId: sessionInfoToProcess.persistentSessionId,
                            hasLastQuestion: !!lastQuestion,
                            hasFinalTranscript: !!finalTranscript
                        });
                    } else {
                        memoryService.addInterviewMemory({
                            userEmail: sessionInfoToProcess.userEmail,
                            interviewId: sessionInfoToProcess.interviewId,
                            sessionId: sessionInfoToProcess.persistentSessionId,
                            isAdmin: isAdmin,
                            qaPairs: [qaPair],
                            metadata: {
                                sessionSocketId: currentSessionId,
                                responseDocId: responseDocId
                            }
                        }).then(() => {
                            const memoryAddDuration = Date.now() - memoryAddStartTime;
                            const totalMemoryDuration = Date.now() - memoryStartTime;
                            console.log(`[${currentSessionId}] 🧠 MEMORY SERVICE - Memory save completed in ${memoryAddDuration}ms (total: ${totalMemoryDuration}ms) for user ${sessionInfoToProcess.userEmail}`);
                        }).catch((memoryError) => {
                            const memoryErrorDuration = Date.now() - memoryStartTime;
                            console.error(`[${currentSessionId}] 🧠 MEMORY SERVICE - Error saving interview memory after ${memoryErrorDuration}ms:`, memoryError);
                            
                            // Log additional context for debugging
                            console.error(`[${currentSessionId}] 🧠 MEMORY SERVICE - Context for error:`, {
                                userEmail: sessionInfoToProcess.userEmail,
                                interviewId: sessionInfoToProcess.interviewId,
                                sessionId: sessionInfoToProcess.persistentSessionId,
                                isAdmin: isAdmin,
                                qaPairKeys: Object.keys(qaPair),
                                questionLength: qaPair.question ? qaPair.question.length : 0,
                                answerLength: qaPair.answer ? qaPair.answer.length : 0
                            });
                            
                            // Continue without saving memory - don't break the interview flow
                        });
                    }
                } else {
                    console.log(`[${currentSessionId}] 🧠 MEMORY SERVICE - Disabled for this interview, skipping memory save`);
                }
            }

            socket.emit('updateProgress', { wordCount: sessionInfoToProcess.totalRecordingDuration }); // Use totalRecordingDuration instead of totalWordCount

            // generateNextQuestion is also in the scope of io.on('connection', (socket) => { ... })
            // and uses the 'socket' variable from that scope.
            if (sessionInfoToProcess.mode === 'final_telling') {
                console.log(`[${currentSessionId}] Final telling mode — skipping generateNextQuestion.`);
            } else {
                await generateNextQuestion(finalTranscript);
            }
        } else {
            console.warn(`[${currentSessionId}] No final transcript from Deepgram to process (via ${contextSource}).`);
            if (sessionInfoToProcess.mode === 'final_telling') {
                console.log(`[${currentSessionId}] Final telling mode — skipping generateNextQuestion (empty transcript).`);
            } else {
                await generateNextQuestion(null);
            }
        }
        
        // Reset for next turn
        sessionInfoToProcess.currentTranscription = '';
        sessionInfoToProcess.currentWordTimestamps = [];
        
        const totalTranscriptionProcessDuration = Date.now() - transcriptionProcessStartTime;
        console.log(`[${currentSessionId}] 🎤 TRANSCRIPTION PROCESSING - Total process completed in ${totalTranscriptionProcessDuration}ms (via ${contextSource})`);
    }
    // --- End Helper function ---

    // VOICE RESPONSE HANDLER (Updated)
    // --- DEEPGRAM REAL-TIME TRANSCRIPTION HANDLERS --- // This comment is slightly misplaced but illustrates the start of the new section
    socket.on('startDeepgramStream', async () => {
        const sessionInfo = sessionData.get(sessionId);
        if (!sessionInfo) {
            console.error(`[${sessionId}] Error: Session data not found for startDeepgramStream.`);
            socket.emit('deepgramError', { message: 'Session not found for Deepgram stream.' });
            return;
        }

        // console.log(`[${sessionId}] Received startDeepgramStream. Initializing Deepgram connection.`);
        
        // Send immediate acknowledgment that we're processing the request
        socket.emit('deepgramStreamInitializing');
        
        // Clean up any existing Deepgram socket for this session
        if (sessionInfo.deepgramSocket) {
            console.warn(`[${sessionId}] Existing Deepgram socket found. Closing before creating a new one.`);
            sessionInfo.deepgramSocket.finish();
            if (sessionInfo.keepAliveInterval) {
                clearInterval(sessionInfo.keepAliveInterval);
            }
        }

        sessionInfo.currentTranscription = '';
        sessionInfo.currentWordTimestamps = [];
        
        if (!deepgramClient) {
            console.error(`[${sessionId}] Deepgram client not initialized - DEEPGRAM_API_KEY may be missing`);
            socket.emit('deepgramError', { message: 'Speech transcription is not configured on this server.' });
            return;
        }
        try {
            const dgSocketInstance = deepgramClient.listen.live({ // Updated method
                punctuate: true,
                interim_results: true,
                language: 'en-US',
                model: 'nova-3',
                smart_format: true,
                utterance_end_ms: 1000, // Optional: to get faster final transcripts after pauses
                vad_events: true, // Optional: for voice activity detection events
                diarize: false, // Keep false for single speaker
                numerals: true,
                // encoding: 'linear16', // Allow Deepgram to auto-detect
                // sample_rate: 16000,   // Allow Deepgram to auto-detect
                // channels: 1,            // Allow Deepgram to auto-detect
                endpointing: 300, // ms of silence to detect end of speech
                word_timestamps: true // Ensure word timestamps are requested
            });

            sessionInfo.deepgramSocket = dgSocketInstance;

            dgSocketInstance.on(LiveTranscriptionEvents.Open, () => {
                // console.log(`[${sessionId}] Deepgram WebSocket opened.`);
                socket.emit('deepgramStreamOpened'); // Inform client

                // Start keepAlive
                if (sessionInfo.keepAliveInterval) clearInterval(sessionInfo.keepAliveInterval);
                sessionInfo.keepAliveInterval = setInterval(() => {
                    // console.log(`[${sessionId}] Deepgram: sending keepalive`);
                    dgSocketInstance.keepAlive();
                }, 10 * 1000);
            });

            // Add throttling for interim transcripts to prevent socket overload
            let lastInterimEmitTime = 0;
            const INTERIM_THROTTLE_MS = 100; // Only emit interim transcripts every 100ms
            
            dgSocketInstance.addListener('message', (message) => {
                const data = JSON.parse(message.toString());
                // console.log(`[${sessionId}] Deepgram message: type=${data.type}, is_final=${data.is_final}`);
                if (data.type === 'Results') {
                    const transcript = data.channel.alternatives[0].transcript;
                    if (transcript && transcript.length > 0) {
                        if (data.is_final) {
                            // console.log(`[${sessionId}] Deepgram Final Transcript: "${transcript}"`);
                            sessionInfo.currentTranscription += transcript + ' ';
                            if (data.channel.alternatives[0].words) {
                                sessionInfo.currentWordTimestamps.push(...data.channel.alternatives[0].words);
                            }
                             // Emit final segment for UI update if desired, or wait for full final
                            socket.emit('finalSegment', { transcript: transcript, words: data.channel.alternatives[0].words });
                        } else {
                            // Throttle interim transcripts to reduce socket traffic
                            const now = Date.now();
                            if (now - lastInterimEmitTime >= INTERIM_THROTTLE_MS) {
                                lastInterimEmitTime = now;
                                // console.log(`[${sessionId}] Deepgram Interim Transcript: "${transcript}"`);
                                socket.emit('interimTranscript', transcript);
                            }
                        }
                    }
                } else if (data.type === 'UtteranceEnd') {
                    console.log(`[${sessionId}] Deepgram UtteranceEnd received.`);
                    // This indicates a pause in speech. The server might decide to finalize
                    // the current transcription segment here if needed, or wait for stopDeepgramStream.
                } else if (data.type === 'Metadata') {
                    console.log(`[${sessionId}] Deepgram Metadata:`, data);
                } else if (data.type === 'SpeechStarted') {
                     // console.log(`[${sessionId}] Deepgram SpeechStarted`);
                } else if (data.type === 'Error') {
                    console.error(`[${sessionId}] Deepgram Error event:`, data);
                    socket.emit('deepgramError', { message: data.description || 'Deepgram transcription error.' });
                }
            });

            dgSocketInstance.on(LiveTranscriptionEvents.Transcript, (data) => {
                // console.log(`[${sessionId}] Deepgram Transcript received: is_final=${data.is_final}, transcript_length=${data.channel?.alternatives[0]?.transcript?.length}`);
                // console.log(`[${sessionId}] RAW DEEPGRAM TRANSCRIPT EVENT DATA:`, JSON.stringify(data));
                const transcript = data.channel?.alternatives[0]?.transcript;
                const words = data.channel?.alternatives[0]?.words;

                // console.log(`[${sessionId}] Extracted transcript: "${transcript}", is_final: ${data.is_final}, word_count: ${words ? words.length : 0}`);

                if (transcript && transcript.length > 0) {
                    if (data.is_final) {
                        // // console.log(`[${sessionId}] Deepgram Final Transcript: "${transcript}"`);
                        sessionInfo.currentTranscription += transcript + ' '; // Append space for concatenation
                        if (data.channel?.alternatives[0]?.words) {
                            sessionInfo.currentWordTimestamps.push(...data.channel.alternatives[0].words);
                        }
                        socket.emit('finalSegment', { transcript: transcript, words: data.channel?.alternatives[0]?.words });
                    } else {
                        // Apply same throttling for interim transcripts here too
                        const now = Date.now();
                        if (now - lastInterimEmitTime >= INTERIM_THROTTLE_MS) {
                            lastInterimEmitTime = now;
                            // console.log(`[${sessionId}] Deepgram Interim Transcript: "${transcript}"`);
                            socket.emit('interimTranscript', transcript);
                        }
                    }
                }
            });

            dgSocketInstance.on(LiveTranscriptionEvents.Error, (error) => {
                console.error(`[${sessionId}] Deepgram WebSocket error:`, error);
                socket.emit('deepgramError', { message: (typeof error === 'string' ? error : error.message) || 'Deepgram connection error.' });
                if (sessionInfo.deepgramSocket) {
                    sessionInfo.deepgramSocket.finish(); // Attempt to close on error
                    sessionInfo.deepgramSocket = null;
                }
                if (sessionInfo.keepAliveInterval) {
                    clearInterval(sessionInfo.keepAliveInterval);
                    sessionInfo.keepAliveInterval = null;
                }
            });

            dgSocketInstance.on(LiveTranscriptionEvents.Close, async (event) => { // Made async
                const currentSessionInfo = sessionData.get(sessionId); // Get fresh session info
                if (!currentSessionInfo) {
                    console.error(`[${sessionId}] Session info not found in Deepgram Close event.`);
                    return;
                }

                // console.log(`[${sessionId}] Deepgram WebSocket closed (LiveTranscriptionEvents.Close). Code: ${event?.code}, Reason: ${event?.reason}`);
                
                if (currentSessionInfo.keepAliveInterval) {
                    clearInterval(currentSessionInfo.keepAliveInterval);
                    currentSessionInfo.keepAliveInterval = null;
                }

                // Check if this closure was initiated by our stopDeepgramStream logic
                if (currentSessionInfo.isGracefullyClosingDeepgram) {
                    // console.log(`[${sessionId}] Deepgram stream closed gracefully after 'finish()' call. Processing final transcription.`);
                    currentSessionInfo.isGracefullyClosingDeepgram = false; // Reset flag
                    await processFinalTranscriptionAndContinue(sessionId, currentSessionInfo, "graceful_close_event");
                } else {
                    // This is an unexpected close
                    console.warn(`[${sessionId}] Deepgram stream closed unexpectedly. NOT processing transcript - letting user continue recording.`);
                    
                    // Don't process the transcript for unexpected closures
                    // The user should be able to continue recording and manually stop when ready
                    // await processFinalTranscriptionAndContinue(sessionId, currentSessionInfo, "unexpected_close_event");
                    
                    // Just notify client of unexpected closure for UI update
                    socket.emit('deepgramStreamClosed'); 
                }
                
                // Ensure the socket reference in sessionInfo is nullified if it was this specific instance.
                // This primarily handles the case where an unexpected close happens and stopDeepgramStream wasn't called.
                if (currentSessionInfo.deepgramSocket) { // If it's still holding a reference after all the above
                    console.log(`[${sessionId}] Deepgram Close event: Nullifying sessionInfo.deepgramSocket as it was still set.`);
                    currentSessionInfo.deepgramSocket = null;
                }
            });

            // Add other listeners as needed from the example (Warning, Metadata)
            dgSocketInstance.on(LiveTranscriptionEvents.Warning, (warning) => {
                console.warn(`[${sessionId}] Deepgram Warning:`, warning);
            });

            dgSocketInstance.on(LiveTranscriptionEvents.Metadata, (metadata) => {
                // console.log(`[${sessionId}] Deepgram Metadata:`, metadata);
                // Example: socket.emit('deepgramMetadata', metadata);
            });

            dgSocketInstance.on(LiveTranscriptionEvents.UtteranceEnd, (data) => {
                console.log(`[${sessionId}] Deepgram UtteranceEnd received.`);
            });
             dgSocketInstance.on(LiveTranscriptionEvents.SpeechStarted, (data) => {
                // console.log(`[${sessionId}] Deepgram SpeechStarted received.`);
            });

        } catch (err) {
            console.error(`[${sessionId}] Error initializing Deepgram live transcription:`, err);
            socket.emit('deepgramError', { message: 'Failed to initialize Deepgram stream.' });
        }
    });

    socket.on('audioChunkToServer', (chunk) => {
        // Apply rate limiting for audio chunks
        // Safari sends chunks every 250ms (4/sec = 240/min), others send every 1000ms (1/sec = 60/min)
        // Set limit to 300 per minute to accommodate Safari users with some headroom
        if (!socketRateLimiter.checkLimit(socket.id, 'audioChunk', 300, 60000)) { // 300 chunks per minute
            socket.emit('error', 'Too many audio chunks. Please slow down.');
            return;
        }
        
        const sessionInfo = sessionData.get(sessionId);
        if (sessionInfo && sessionInfo.deepgramSocket && sessionInfo.deepgramSocket.getReadyState() === 1) { // 1 is WebSocket.OPEN
            // Log first chunk details for debugging Safari issues
            if (!sessionInfo.hasLoggedFirstChunk) {
                sessionInfo.hasLoggedFirstChunk = true;
                // console.log(`[${sessionId}] First audio chunk received - size: ${chunk.byteLength} bytes, type: ${typeof chunk}`);
                
                // Try to detect audio format from first bytes if it's an ArrayBuffer
                if (chunk instanceof ArrayBuffer && chunk.byteLength > 4) {
                    const view = new DataView(chunk);
                    const first4Bytes = Array.from(new Uint8Array(chunk, 0, 4));
                    // console.log(`[${sessionId}] First 4 bytes: ${first4Bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                }
            }
            
            sessionInfo.deepgramSocket.send(chunk);
        } else if (sessionInfo && sessionInfo.deepgramSocket && sessionInfo.deepgramSocket.getReadyState() !== 1) {
            console.warn(`[${sessionId}] Deepgram socket not OPEN (state: ${sessionInfo.deepgramSocket.getReadyState()}). Cannot send audio chunk.`);
        } else {
            console.warn(`[${sessionId}] Deepgram socket not ready or not available for sending audio chunk.`);
        }
    });

    socket.on('stopDeepgramStream', async () => {
        const sessionInfo = sessionData.get(sessionId);
        if (!sessionInfo) {
            console.error(`[${sessionId}] Error: Session data not found for stopDeepgramStream.`);
            return;
        }
        console.log(`[${sessionId}] Received stopDeepgramStream.`);

        if (sessionInfo.deepgramSocket) {
            // console.log(`[${sessionId}] Telling Deepgram to finalize transcription and close stream.`);
            
            sessionInfo.isGracefullyClosingDeepgram = true; // Set flag
            
            const dgSocketToClose = sessionInfo.deepgramSocket; // Keep a reference to the actual socket object
            
            // Nullify the session's reference to the socket *before* calling finish.
            // This helps the 'Close' event handler identify that this closure is intentional.
            sessionInfo.deepgramSocket = null; 
            // The keepAliveInterval is now cleared in the 'LiveTranscriptionEvents.Close' handler.

            // Add a small delay to ensure any final audio chunks are processed
            // before calling finish() to prevent audio clipping
            setTimeout(() => {
                console.log(`[${sessionId}] Calling finish() on Deepgram socket after buffer delay.`);
                dgSocketToClose.finish(); // Signal Deepgram to finalize and close this specific socket instance.
            }, 500); // Increased from 300ms to 500ms to ensure final words are captured
            
            // The actual processing of the final transcript will now happen in the 'LiveTranscriptionEvents.Close' handler.
            // console.log(`[${sessionId}] Scheduled finish() call for Deepgram socket. Waiting for 'Close' event to process final transcript.`);
        } else {
            console.warn(`[${sessionId}] stopDeepgramStream called, but no active Deepgram socket was found in session data.`);
            // If there's no socket, there's nothing to stop.
            // Process any potentially accumulated transcript as a fallback.
            // This assumes that if deepgramSocket is null here, it means either it never started or closed abruptly before.
            console.log(`[${sessionId}] No active Deepgram socket; processing any existing transcript data as fallback.`);
            await processFinalTranscriptionAndContinue(sessionId, sessionInfo, "no_active_socket_fallback_in_stopStream");
        }
        
        // Remove all the transcript processing logic that was here, as it's now in processFinalTranscriptionAndContinue
        // and triggered by the Close event or the fallback above.
    });
    // --- END DEEPGRAM HANDLERS ---

    // --- START New listener to prepare example session from index.html ---
    socket.on('requestExampleReportGeneration', () => {
        const exampleSessionId = socket.id; // Use socket ID as temporary session ID
        console.log(`Preparing example report session for ID: ${exampleSessionId}`);
        try {
            // Prepare example data structures
            const exampleResponses = EXAMPLE_QA.map(item => item.answer);
            // Ensure questions match the expected structure stored in sessionData
            const exampleQuestions = EXAMPLE_QA.map(item => ({
                text: item.question,
                thinkingBlock: null // No thinking block for example questions
            }));

            // Store the example data in sessionData using the socket ID
            sessionData.set(exampleSessionId, {
                interviewResponses: exampleResponses,
                assistantQuestions: exampleQuestions,
                contextData: EXAMPLE_RESUME,
                customPrompt: null, // Not applicable for example
                firstName: EXAMPLE_FIRST_NAME,
                totalRecordingDuration: 0 // Not applicable for example
            });

            console.log(`Example session ${exampleSessionId} created. Instructing client to redirect.`);
            // Emit event back ONLY to the requesting client with the session ID
            socket.emit('initiateExampleReportRedirect', exampleSessionId);
        } catch (error) {
            console.error('Error preparing example report session:', error);
            // Inform the client if something went wrong
            socket.emit('error', 'Failed to prepare the example report data.');
        }
    });
    // --- END New listener ---

    // Track the last assistant response for the conversation history
    // let lastAssistantResponse = ''; // This might not be needed anymore if we don't store complex objects

    // New event handler for text responses (KEEPING FOR NOW - might be useful for debugging or future text input)
    socket.on('textResponse', async (textData) => {
        // Validate socket data
        const validation = validateAndSanitizeSocketEvent('textResponse', textData, socket);
        if (!validation.isValid) return;
        textData = validation.data;
        
        console.warn('Received unexpected textResponse event:', textData);
        const sessionInfo = sessionData.get(sessionId);
        if (!sessionInfo) {
            console.error('Session data not found for textResponse');
            socket.emit('error', 'Session expired or invalid.');
            return;
        }

        try {
            // Store the text response
            sessionInfo.interviewResponses.push(textData);

            // Update word count
            const currentWordCount = countWords(textData);
            sessionInfo.totalRecordingDuration = (sessionInfo.totalRecordingDuration || 0) + currentWordCount;
            // console.log(`Text response words: ${currentWordCount}, Total session words: ${sessionInfo.totalRecordingDuration}`);
            
            // Log response to Firebase
            const lastQuestionObj = sessionInfo.assistantQuestions.length > 0 
                ? sessionInfo.assistantQuestions[sessionInfo.assistantQuestions.length - 1] 
                : null;
                
            const lastQuestion = lastQuestionObj ? lastQuestionObj.text : null;
            const thinkingTrace = lastQuestionObj ? lastQuestionObj.thinkingBlock : null;
            
            await logResponseToFirebase(sessionId, {
                interviewId: sessionInfo.interviewId || null,
                question: lastQuestion,
                answer: textData,
                thinkingTrace: thinkingTrace,
                fullPrompt: sessionInfo.lastFullPrompt || null, // Include the full prompt
                wordTimestamps: null // No word timestamps for text responses
            }, sessionInfo.persistentSessionId); // Pass persistent ID
            
            socket.emit('updateProgress', { wordCount: sessionInfo.totalRecordingDuration });

            // Generate next question based on the text response
            await generateNextQuestion(textData);
        } catch (error) {
            console.error('Text response error:', error);
            socket.emit('error', 'Failed to process text response');
        }
    });

    async function generateNextQuestion(previousResponse = null) {
        // Apply rate limiting
        if (!socketRateLimiter.checkLimit(socket.id, 'generateNextQuestion', socketLimits.generateNextQuestion.limit, socketLimits.generateNextQuestion.windowMs)) {
            socket.emit('error', 'Too many question generation requests. Please wait before trying again.');
            return;
        }
        const questionGenerationStartTime = Date.now();
        console.log(`[${sessionId}] 🎯 QUESTION GENERATION - Starting at ${new Date().toISOString()}`);
        
        const sessionInfo = sessionData.get(sessionId);
        if (!sessionInfo) {
            console.error('Session data missing in generateNextQuestion');
            socket.emit('error', 'Session data lost. Cannot continue interview.');
            return;
        }

        // Update last active timestamp
        sessionInfo.lastActive = Date.now();

        // Emergency fallback: If no custom prompt but we have an interviewId param, try to fetch again
        // This handles race conditions or cases where the ID format wasn't as expected
        if ((!sessionInfo.customPrompt || !sessionInfo.followupPrompt) && sessionInfo.interviewId && db) {
            try {
                console.log("\n=== EMERGENCY PROMPT RECOVERY ===");
                console.log(`No custom prompts found but interviewId exists: ${sessionInfo.interviewId}`);
                
                // Sanitize the interview ID to prevent errors
                const safeInterviewId = String(sessionInfo.interviewId).trim();
                if (!safeInterviewId) {
                    console.log("Invalid interview ID format for recovery");
                    console.log("=== END EMERGENCY RECOVERY ===\n");
                    // Do not return here, let it fall through to normal logic which might use defaults
                } else {
                    console.log("Attempting direct fetch from database with ID:", safeInterviewId);
                    
                    const recoveryDoc = await db.collection('interviews').doc(safeInterviewId).get();
                    
                    if (recoveryDoc.exists) {
                        const recoveryData = recoveryDoc.data();
                        console.log(`Recovery successful! Found interview: ${recoveryData.title}`);
                        
                        if (recoveryData.initialPrompt && !sessionInfo.customPrompt) {
                            console.log("Restoring missing initial prompt");
                            sessionInfo.customPrompt = recoveryData.initialPrompt;
                        }
                        
                        if (recoveryData.followupPrompt && !sessionInfo.followupPrompt) {
                            console.log("Restoring missing followup prompt");
                            sessionInfo.followupPrompt = recoveryData.followupPrompt;
                        }
                        
                        if (recoveryData.enableMemoryService !== undefined) {
                            console.log("Restoring memory service setting:", recoveryData.enableMemoryService);
                            sessionInfo.enableMemoryService = recoveryData.enableMemoryService;
                        } else {
                            // For old interviews that don't have enableMemoryService field, default to true
                            console.log("Old interview detected - setting enableMemoryService to true by default");
                            sessionInfo.enableMemoryService = true;
                        }
                        
                        if (recoveryData.enableWebSearch !== undefined) {
                            console.log("Restoring web search setting:", recoveryData.enableWebSearch);
                            sessionInfo.enableWebSearch = recoveryData.enableWebSearch;
                        }
                        
                        if (recoveryData.enableThinking !== undefined) {
                            console.log("Restoring thinking setting:", recoveryData.enableThinking);
                            sessionInfo.enableThinking = recoveryData.enableThinking;
                        }
                        
                        if (recoveryData.followupModel) {
                            console.log("Restoring follow-up model:", recoveryData.followupModel);
                            sessionInfo.followupModel = recoveryData.followupModel;
                        }
                    } else {
                        console.log("Recovery failed - interview not found in direct query");
                    }
                }
                console.log("=== END EMERGENCY RECOVERY ===\n");
            } catch (recoveryError) {
                console.error("Error during emergency prompt recovery:", recoveryError);
                console.log("=== END EMERGENCY RECOVERY ===\n");
            }
        }

        const isFollowUp = sessionInfo.interviewResponses.length > 0;

        // Handle the first question if a custom prompt (which is the question itself) exists
        if (!isFollowUp && sessionInfo.customPrompt) {
            let firstQuestionText = sessionInfo.customPrompt;

            // Substitute {{NAME}} placeholder with the user's name if available
            if (sessionInfo.userName && firstQuestionText.includes('{{NAME}}')) {
                firstQuestionText = firstQuestionText.replace(/\{\{NAME\}\}/gi, sessionInfo.userName);
                console.log(`[${sessionId}] Substituted {{NAME}} placeholder with: ${sessionInfo.userName}`);
            }

            console.log("\n==== STATIC FIRST QUESTION (FROM CUSTOM PROMPT) ====");
            console.log("Using customPrompt directly as the first question:", firstQuestionText);
            console.log("Custom prompt type:", typeof firstQuestionText, "Length:", firstQuestionText ? firstQuestionText.length : 0);
            console.log("===================================================\n");

            // Validate that customPrompt is a non-empty string
            if (typeof firstQuestionText !== 'string' || firstQuestionText.trim() === '') {
                console.error('Custom prompt is invalid or empty. Falling back to dynamic generation.');
                // Fall through to the original logic below if customPrompt is bad
            } else {
                socket.emit('thinkingStarted'); // Emit for UI consistency
                
                const assistantQuestionObject = {
                    text: firstQuestionText,
                    thinkingBlock: null // No Claude thinking block for a static question
                };
                sessionInfo.assistantQuestions.push(assistantQuestionObject);

                socket.emit('thinkingComplete'); // Thinking is "done"
                
                // TTS removed - questions are displayed as text only

                socket.emit('responseComplete', firstQuestionText);

                // Don't log the first question here - it will be logged when the user answers it
                // This prevents duplicate entries with null answers
                
                sessionInfo.firstQuestionThinking = null; 
                sessionInfo.lastFullPrompt = "Static question from custom prompt: " + firstQuestionText; // For logging history
                
                // If there's an uploaded image, store it in a way that follow-up questions can access it
                if (sessionInfo.uploadedFile && sessionInfo.uploadedFile.isImage) {
                    console.log(`[${sessionId}] Static first question with uploaded image. Image will be available for follow-up questions.`);
                    // The image is already stored in sessionInfo.uploadedFile and will be used in follow-up questions
                }

                return; // Done with the first question
            }
        }

        try {
            const messages = [];
            const { interviewResponses, assistantQuestions, contextData, customPrompt, firstQuestionThinking } = sessionInfo;

            console.log("\n==== GENERATE NEXT QUESTION (DYNAMIC OR FOLLOW-UP) ====");
            console.log("Is Follow-Up:", isFollowUp);
            console.log("Interview Responses Length:", interviewResponses.length);
            console.log("Assistant Questions Length:", assistantQuestions.length);
            // Custom prompt here could be null, or an old-style prompt-for-a-question if !isFollowUp and the static block was skipped.
            console.log("Custom Prompt Provided (for dynamic use if applicable):", customPrompt ? "Yes" : "No");
            console.log("=========================================================\n");

            // Fetch memory context if available and enabled
            let memoryContext = null;
            // TEMPORARILY DISABLED - Memory service causing 25+ second delays
            if (false && sessionInfo.userEmail && sessionInfo.interviewId && sessionInfo.enableMemoryService) {
                const memoryRetrievalStartTime = Date.now();
                console.log(`[generateNextQuestion - ${sessionId}] 🧠 MEMORY RETRIEVAL - Starting memory context fetch at ${new Date().toISOString()}`);
                
                try {
                    // Build current context from the conversation so far
                    let currentConversationContext = contextData || '';
                    if (previousResponse) {
                        currentConversationContext += `\nLatest response: ${previousResponse}`;
                    }
                    
                    // Determine if the current user is an admin for this session
                    const isAdminTakingInterview = (sessionInfo.adminEmail === sessionInfo.userEmail);
                    console.log(`[generateNextQuestion - ${sessionId}] isAdminTakingInterview: ${isAdminTakingInterview} (AdminEmail: ${sessionInfo.adminEmail}, UserEmail: ${sessionInfo.userEmail})`);

                    const memoryFetchStartTime = Date.now();
                    memoryContext = await memoryService.getContextualMemories(
                        sessionInfo.userEmail,
                        sessionInfo.interviewId,
                        currentConversationContext,
                        isAdminTakingInterview // Pass the flag
                    );
                    const memoryFetchDuration = Date.now() - memoryFetchStartTime;
                    const totalMemoryRetrievalDuration = Date.now() - memoryRetrievalStartTime;
                    
                    console.log(`[generateNextQuestion - ${sessionId}] 🧠 MEMORY RETRIEVAL - Memory context fetched in ${memoryFetchDuration}ms (total: ${totalMemoryRetrievalDuration}ms) for ${sessionInfo.userEmail}:`, {
                        hasHistory: memoryContext.hasHistory,
                        memoriesCount: memoryContext.memories.length,
                        previousSessions: memoryContext.graphContext?.previousSessions || 0
                    });
                } catch (memoryError) {
                    const memoryErrorDuration = Date.now() - memoryRetrievalStartTime;
                    console.error(`[generateNextQuestion - ${sessionId}] 🧠 MEMORY RETRIEVAL - Error fetching memory context after ${memoryErrorDuration}ms:`, memoryError);
                    // Continue without memory context
                }
            } else {
                console.log(`[generateNextQuestion - ${sessionId}] 🧠 MEMORY RETRIEVAL - TEMPORARILY DISABLED due to performance issues`);
            }

            console.log("\n==== PROMPT VALIDATION (DYNAMIC OR FOLLOW-UP) ====");
            if (customPrompt && !isFollowUp) { // This is if it fell through the static question logic
                console.log(`Custom initial prompt (to be used by Claude) content length: ${customPrompt.length} chars`);
                console.log(`Contains {{CONTEXT}}: ${customPrompt.includes('{{CONTEXT}}')}`);
                console.log(`Contains {{RESUME}}: ${customPrompt.includes('{{RESUME}}')}`);
            }
            if (sessionInfo.followupPrompt) {
                console.log(`Custom follow-up prompt set: ${sessionInfo.followupPrompt ? 'YES' : 'NO'}`);
                console.log(`Follow-up prompt content length: ${sessionInfo.followupPrompt.length} chars`);
                console.log(`Contains {{CONTEXT}}: ${sessionInfo.followupPrompt.includes('{{CONTEXT}}')}`);
                console.log(`Contains {{RESUME}}: ${sessionInfo.followupPrompt.includes('{{RESUME}}')}`);
            }

            // Use new architecture for prompt assembly
            let systemPromptContent;
            
            // Check if we have the new fields (indicates new architecture)
            const hasNewArchitecture = sessionInfo.interviewPurpose || sessionInfo.requiredInformation;
            
            if (hasNewArchitecture) {
                console.log("Using NEW architecture with core interviewing techniques");
                
                // Prepare memory context string if available
                let memoryContextString = '';
                if (memoryContext && memoryContext.hasHistory) {
                    if (memoryContext.graphContext?.previousSessions > 0) {
                        memoryContextString += `This user has completed ${memoryContext.graphContext.previousSessions} previous session(s) with this interview.\n\n`;
                    }
                    
                    if (memoryContext.memories.length > 0) {
                        memoryContextString += 'Relevant memories from past interactions:\n';
                        memoryContext.memories.forEach((memory, idx) => {
                            memoryContextString += `${idx + 1}. ${memory.memory}\n`;
                        });
                    }
                }
                
                // Use the new prompt assembly function
                systemPromptContent = assembleInterviewPrompt({
                    title: sessionInfo.interviewTitle,
                    description: sessionInfo.interviewDescription,
                    purpose: sessionInfo.interviewPurpose,
                    requiredInformation: sessionInfo.requiredInformation,
                    followupPrompt: sessionInfo.followupPrompt,  // This will now contain interview-specific guidance only
                    contextData: contextData,
                    memoryContext: memoryContextString,
                    isFollowUp: isFollowUp,
                    conversationHistory: null,  // Conversation history is added as separate messages
                    firstQuestion: !isFollowUp ? sessionInfo.customPrompt : null,
                    enableThinking: sessionInfo.enableThinking  // Pass thinking preference
                });
                
            } else {
                // Fallback to old architecture for backward compatibility
                console.log("Using OLD architecture for backward compatibility");
                
                let promptToUse;
                if (isFollowUp) {
                    promptToUse = sessionInfo.followupPrompt || FOLLOWUP_INTERVIEW_PROMPT;
                } else {
                    promptToUse = customPrompt || INITIAL_INTERVIEW_PROMPT;
                }
                
                // Prepare context with memory if available
                let enhancedContext = contextData || '';
                
                if (memoryContext && memoryContext.hasHistory) {
                    enhancedContext += '\n\n<previous_interview_context>\n';
                    
                    if (memoryContext.graphContext?.previousSessions > 0) {
                        enhancedContext += `This user has completed ${memoryContext.graphContext.previousSessions} previous session(s) with this interview.\n\n`;
                    }
                    
                    if (memoryContext.memories.length > 0) {
                        enhancedContext += 'Relevant memories from past interactions:\n';
                        memoryContext.memories.forEach((memory, idx) => {
                            enhancedContext += `${idx + 1}. ${memory.memory}\n`;
                        });
                    }
                    
                    enhancedContext += '</previous_interview_context>';
                }
                
                systemPromptContent = promptToUse.replace('{{CONTEXT}}', enhancedContext);
                
                // Note: We're keeping backward compatibility with {{RESUME}} for older prompts
                if (systemPromptContent.includes('{{RESUME}}')) {
                    systemPromptContent = systemPromptContent.replace('{{RESUME}}', enhancedContext);
                }
            }
            
            // Store the full prompt in the session data for logging
            sessionInfo.lastFullPrompt = systemPromptContent;
            
            console.log(`Prompt length: ${systemPromptContent.length} chars`);
            console.log(`Prompt preview (first 300 chars): ${systemPromptContent.substring(0, 300)}...`);
            
            // Check for previous interviews if this is the first question
            let previousInterviewData = null;
            let shouldGenerateContinuationQuestion = false;
            
            if (!isFollowUp && sessionInfo.userEmail && sessionInfo.interviewId) {
                previousInterviewData = await checkForPreviousInterviews({
                    userEmail: sessionInfo.userEmail,
                    interviewId: sessionInfo.interviewId,
                    db: db,
                    sessionId: sessionId
                });
                
                shouldGenerateContinuationQuestion = previousInterviewData !== null;
                
                if (shouldGenerateContinuationQuestion) {
                    console.log(`[${sessionId}] User has previous interviews for this template - will generate continuation question`);
                    
                    // Build enhanced memory context string that includes previous interview data
                    const enhancedMemoryString = buildMemoryContextString({
                        memoryContext: memoryContext,
                        previousInterviewData: previousInterviewData,
                        shouldGenerateContinuationQuestion: shouldGenerateContinuationQuestion
                    });
                    
                    // Update the system prompt with the enhanced memory context
                    if (hasNewArchitecture) {
                        // For new architecture, re-assemble the prompt with enhanced memory
                        systemPromptContent = assembleInterviewPrompt({
                            title: sessionInfo.interviewTitle,
                            description: sessionInfo.interviewDescription,
                            purpose: sessionInfo.interviewPurpose,
                            requiredInformation: sessionInfo.requiredInformation,
                            followupPrompt: sessionInfo.followupPrompt,
                            contextData: contextData,
                            memoryContext: enhancedMemoryString,
                            isFollowUp: isFollowUp,
                            conversationHistory: null,
                            firstQuestion: !isFollowUp ? sessionInfo.customPrompt : null
                        });
                    } else {
                        // For old architecture, append the enhanced memory context
                        systemPromptContent += '\n\n' + enhancedMemoryString;
                    }
                    
                    // Update the stored prompt
                    sessionInfo.lastFullPrompt = systemPromptContent;
                }
            }
            
            // Build conversation history: Alternate Assistant Question -> User Response
            const historyLength = Math.min(assistantQuestions.length, interviewResponses.length);
            
            // Build conversation messages using the utility function
            const conversationMessages = buildConversationHistory({
                assistantQuestions: assistantQuestions,
                interviewResponses: interviewResponses,
                isFollowUp: isFollowUp
            });
            
            // Add conversation messages to the messages array
            messages.push(...conversationMessages);
            
            // If this is a continuation question (first question but user has previous interviews),
            // we need to add an initial user message since there's no conversation history yet
            if (shouldGenerateContinuationQuestion && !isFollowUp && messages.length === 0) {
                messages.push({
                    role: "user",
                    content: "Based on my previous interview responses, what would you like to explore next?"
                });
            }
            
            // If we have an uploaded file (especially an image), we need to ensure it's in the messages
            // We need to include it in EVERY request, not just once
            if (sessionInfo.uploadedFile && sessionInfo.uploadedFile.isImage) {
                console.log(`[${sessionId}] Need to add uploaded file to messages. Current messages length:`, messages.length);
                
                if (sessionInfo.uploadedFile.isImage) {
                    try {
                        let base64Image;
                        
                        // Check if we already have the base64 cached
                        if (sessionInfo.cachedImageBase64) {
                            console.log(`[${sessionId}] Using cached image base64, size: ${sessionInfo.cachedImageBase64.length} chars`);
                            base64Image = sessionInfo.cachedImageBase64;
                        } else {
                            // Fetch image from URL
                            console.log(`[${sessionId}] Fetching image from GCS for the first time`);
                            const imageResponse = await fetch(sessionInfo.uploadedFile.url);
                            if (!imageResponse.ok) {
                                throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
                            }
                            
                            // Convert to buffer then base64
                            const imageBuffer = await imageResponse.buffer();
                            base64Image = imageBuffer.toString('base64');
                            
                            // Cache for future use
                            sessionInfo.cachedImageBase64 = base64Image;
                            console.log(`[${sessionId}] Fetched and cached image from GCS, size: ${base64Image.length} chars`);
                        }
                        
                        // For follow-up questions, we need to modify the first user message to include the image
                        if (messages.length > 0 && messages[0].role === 'assistant') {
                            // Find the first user message
                            let firstUserMessageIndex = messages.findIndex(msg => msg.role === 'user');
                            if (firstUserMessageIndex !== -1) {
                                console.log(`[${sessionId}] Modifying existing user message at index ${firstUserMessageIndex} to include image`);
                                const originalContent = messages[firstUserMessageIndex].content;
                                
                                // Check if content is already structured (with cache_control)
                                let textContent;
                                if (Array.isArray(originalContent)) {
                                    // Content is already an array, find the text item
                                    const textItem = originalContent.find(item => item.type === 'text');
                                    textContent = textItem ? textItem.text : '';
                                    console.log(`[${sessionId}] Original content was array, extracted text:`, textContent.substring(0, 100));
                                } else if (typeof originalContent === 'string') {
                                    // Content is a simple string
                                    textContent = originalContent;
                                    console.log(`[${sessionId}] Original content was string:`, textContent.substring(0, 100));
                                } else {
                                    console.error(`[${sessionId}] Unexpected content type:`, typeof originalContent);
                                    textContent = '';
                                }
                                
                                messages[firstUserMessageIndex].content = [
                                    {
                                        type: "text",
                                        text: textContent,
                                        cache_control: {"type": "ephemeral"}
                                    },
                                    {
                                        type: "image",
                                        source: {
                                            type: "base64",
                                            media_type: sessionInfo.uploadedFile.type,
                                            data: base64Image
                                        },
                                        cache_control: {"type": "ephemeral"}
                                    }
                                ];
                            }
                        } else if (messages.length === 0) {
                            // No messages yet, add as new message
                            console.log(`[${sessionId}] Adding image as new initial message`);
                            messages.push({
                                role: "user",
                                content: [
                                    {
                                        type: "text",
                                        text: contextData || "Please analyze this image and ask me questions about it."
                                    },
                                    {
                                        type: "image",
                                        source: {
                                            type: "base64",
                                            media_type: sessionInfo.uploadedFile.type,
                                            data: base64Image
                                        },
                                        cache_control: {"type": "ephemeral"}
                                    }
                                ]
                            });
                        }
                    } catch (error) {
                        console.error(`[${sessionId}] Error fetching image from URL:`, error);
                    }
                }
            } else if (!isFollowUp && messages.length === 0 && contextData) {
                // If no file but we have context, add it as initial message
                messages.push({
                    role: "user",
                    content: contextData
                });
            }

            const thinkingBudget = isFollowUp ? 1024 : 1024; // Minimum thinking budget is 1024 tokens

            // MOVED: Debug log will be shown after requestBody is created with correct settings

            socket.emit('thinkingStarted');

            // Add error handling for fetch request
            let fetchRetries = 0;
            const maxFetchRetries = 3;
            let fetchSuccess = false;

            // Variables to capture web search query
            let currentCapturingToolUseBlockIndex = -1;
            let currentSearchQueryJsonString = '';

            while (!fetchSuccess && fetchRetries < maxFetchRetries) {
                try {
                    // Reset for each attempt, especially if retry happens.
                    currentCapturingToolUseBlockIndex = -1;
                    currentSearchQueryJsonString = '';

                    // DEBUG: Log session settings being used
                    console.log('=== DEBUGGING GENERATE NEXT QUESTION ===');
                    console.log('sessionInfo.followupModel:', sessionInfo.followupModel);
                    console.log('sessionInfo.enableThinking:', sessionInfo.enableThinking);
                    console.log('sessionInfo.enableWebSearch:', sessionInfo.enableWebSearch);
                    console.log('=== END GENERATE QUESTION DEBUG ===');

                    const requestBody = {
                        model: sessionInfo.followupModel || "claude-sonnet-4-6", // Use template's followupModel; default to Sonnet for cost
                        max_tokens: 1500, // 1024 for thinking budget + buffer for question
                        messages: messages,
                        temperature: 1,
                        system: [
                            {
                                type: "text",
                                text: systemPromptContent,
                                cache_control: {"type": "ephemeral"}
                            }
                        ],
                        stream: true
                    };

                    // Add thinking configuration based on session settings
                    if (sessionInfo.enableThinking) {
                        requestBody.thinking = {
                            "type": "enabled",
                            "budget_tokens": thinkingBudget
                        };
                    }

                    if (isFollowUp) {
                        requestBody.tools = [
                            {
                                "name": "web_search",
                                "type": "web_search_20250305"
                            }
                        ];
                    }

                    // >>> MODIFIED: Conditionally add tools based on sessionInfo.enableWebSearch <<<
                    if (isFollowUp && sessionInfo.enableWebSearch) {
                        requestBody.tools = [
                            {
                                "name": "web_search",
                                "type": "web_search_20250305",
                                "max_uses": 1
                            }
                        ];
                        console.log(`[${sessionId}] Web search ENABLED for this follow-up question.`);
                    } else if (isFollowUp && !sessionInfo.enableWebSearch) {
                        console.log(`[${sessionId}] Web search DISABLED for this follow-up question.`);
                        // Ensure requestBody.tools is not set or is empty if web search is disabled
                        delete requestBody.tools; // Or set to undefined/empty array if API requires it
                    }
                    // If not a follow-up, tools are not added by this logic block.

                    // DEBUG: Log the actual request body being sent (with sanitized image data)
                    console.log("\n==== FULL PROMPT SENT TO CLAUDE (generateNextQuestion) ====");
                    const sanitizedRequestBody = JSON.parse(JSON.stringify(requestBody));
                    
                    // Sanitize image data in messages to avoid clogging logs
                    if (sanitizedRequestBody.messages) {
                        sanitizedRequestBody.messages.forEach(msg => {
                            if (Array.isArray(msg.content)) {
                                msg.content.forEach(item => {
                                    if (item.type === 'image' && item.source && item.source.data) {
                                        item.source.data = `[BASE64_IMAGE_DATA_${item.source.data.length}_CHARS]`;
                                    }
                                });
                            }
                        });
                    }
                    
                    console.log(JSON.stringify(sanitizedRequestBody, null, 2));
                    console.log("=======================================================\n");

                    const claudeApiStartTime = Date.now();
                    console.log(`[${sessionId}] 🤖 CLAUDE API - Starting request at ${new Date().toISOString()}`);
                    
                    const response = await fetch("https://api.anthropic.com/v1/messages", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "x-api-key": CLAUDE_API_KEY,
                            "anthropic-version": "2023-06-01"
                        },
                        body: JSON.stringify(requestBody),
                        // Add timeout for fetch request
                        timeout: 30000 // 30 second timeout
                    });

                    if (!response.ok) {
                        const errorData = await response.text();
                        console.error('Claude API error generating question:', errorData);
                        throw new Error('Failed to generate question from Claude API');
                    }

                    // If we get here, the fetch was successful
                    fetchSuccess = true;

                    // Rest of the streaming code
                    let completeResponse = '';
                    let thinkingText = ''; // Capture thinking text separately
                    let currentBlockType = null;
                    let capturedThinkingBlock = null; // To store the full thinking block object if needed
                    let streamBuffer = ''; // Buffer to handle partial lines across chunks

                    // Set up error handling for the stream
                    const handleStreamError = (err) => {
                        console.error('Stream error in generateNextQuestion:', err);
                        socket.emit('error', 'Connection error while generating question');
                        // throw err;
                    };

                    response.body.on('error', handleStreamError);

                    // Process the stream data
                    response.body.on('data', (chunk) => {
                        // Append chunk to buffer to handle partial lines
                        streamBuffer += chunk.toString();

                        // Split on newlines but keep the last partial line in buffer
                        const lines = streamBuffer.split('\n');
                        // Keep the last element (may be incomplete) in buffer for next chunk
                        streamBuffer = lines.pop() || '';

                        for (const line of lines) {
                            if (!line.trim() || !line.startsWith('data: ')) continue;
                            const dataMatch = line.match(/^data: (.+)$/);
                            if (!dataMatch) continue;
                            if (dataMatch[1] === '[DONE]') continue;

                            try {
                                // Check if the JSON is complete before parsing
                                let jsonStr = dataMatch[1];
                                
                                // Simplified validation - just check if it's likely a complete JSON object
                                const isLikelyComplete = (jsonStr) => {
                                    const trimmed = jsonStr.trim();
                                    return trimmed.startsWith('{') && trimmed.endsWith('}');
                                };
                                
                                if (!isLikelyComplete(jsonStr)) {
                                    console.warn('Received potentially incomplete JSON chunk in report generation, skipping parse:', 
                                        jsonStr.length > 100 ? jsonStr.substring(0, 100) + '...' : jsonStr);
                                    continue;
                                }
                                
                                const data = JSON.parse(jsonStr);

                                if (data.type === 'content_block_start') {
                                    currentBlockType = data.content_block.type;
                                    if (currentBlockType === 'text') {
                                        // Don't emit responseStarted here - wait for question tag
                                        // socket.emit('responseStarted');
                                    } else if (currentBlockType === 'thinking') {
                                        // Initialize the thinking block with proper structure
                                        capturedThinkingBlock = {
                                            type: "thinking",
                                            thinking: ""
                                        };
                                    } else if (currentBlockType === 'server_tool_use' && data.content_block.name === 'web_search') {
                                        currentCapturingToolUseBlockIndex = data.index;
                                        currentSearchQueryJsonString = ''; // Reset for this specific tool use block
                                        console.log(`[${sessionId}] Web search tool use STARTED. Block Index: ${data.index}, Tool Use ID: ${data.content_block.id}. Full content_block:`, JSON.stringify(data.content_block));
                                    }
                                } else if (data.type === 'content_block_delta') {
                                    if (data.delta.type === 'text_delta' && currentBlockType === 'text') {
                                        const textChunk = data.delta.text || '';
                                        completeResponse += textChunk;
                                        
                                        // Stream question content directly (no tags expected)
                                        // Emit responseStarted on first chunk
                                        if (!sessionInfo.responseStartedEmitted && textChunk.trim()) {
                                            socket.emit('responseStarted');
                                            sessionInfo.responseStartedEmitted = true;
                                        }
                                        
                                        // Stream the chunk directly
                                        if (textChunk) {
                                            socket.emit('responseChunk', textChunk);
                                        }
                                    } else if (data.delta.type === 'thinking_delta' && currentBlockType === 'thinking') {
                                        const thinkingChunk = data.delta.thinking || '';
                                        thinkingText += thinkingChunk;
                                        if (capturedThinkingBlock) {
                                            capturedThinkingBlock.thinking += thinkingChunk;
                                        }
                                        socket.emit('thinkingUpdate', thinkingChunk);
                                    } else if (data.delta.type === 'signature_delta' && currentBlockType === 'thinking') {
                                        // Capture signature from Claude's stream
                                        const signatureChunk = data.delta.signature || '';
                                        if (capturedThinkingBlock) {
                                            if (!capturedThinkingBlock.signature) {
                                                capturedThinkingBlock.signature = '';
                                            }
                                            capturedThinkingBlock.signature += signatureChunk;
                                        }
                                    } else if (data.index === currentCapturingToolUseBlockIndex && data.delta.type === 'input_json_delta') {
                                        // Log the entire delta object for more detailed inspection
                                        console.log(`[${sessionId}] Web search input_json_delta (Block Index: ${data.index}). Full delta object:`, JSON.stringify(data.delta));
                                        const jsonDeltaValue = data.delta.partial_json || ''; // CORRECTED: Was data.delta.value
                                        currentSearchQueryJsonString += jsonDeltaValue;
                                        console.log(`[${sessionId}] Appending to query string: "${jsonDeltaValue}". Current accumulated: "${currentSearchQueryJsonString}"`);
                                    }
                                } else if (data.type === 'content_block_stop') {
                                    if (data.index === currentCapturingToolUseBlockIndex) {
                                        console.log(`[${sessionId}] Web search tool use ENDED for block index: ${data.index}. Final accumulated JSON string: "${currentSearchQueryJsonString}"`);
                                        try {
                                            const parsedQuery = JSON.parse(currentSearchQueryJsonString);
                                            if (parsedQuery.query) {
                                                socket.emit('thinkingUpdate', `\n\n[Claude is searching the web for: "${parsedQuery.query}"]\n`);
                                                console.log(`[${sessionId}] Emitted web search query to thinkingUpdate: "${parsedQuery.query}"`);
                                            } else {
                                                console.warn(`[${sessionId}] Parsed search query JSON, but 'query' field was missing or empty. Full parsed object:`, JSON.stringify(parsedQuery));
                                            }
                                        } catch (parseError) {
                                            console.error(`[${sessionId}] Error parsing search query JSON: ${parseError}. JSON string was: "${currentSearchQueryJsonString}"`);
                                        }
                                        currentCapturingToolUseBlockIndex = -1; // Reset for next potential tool use
                                        currentSearchQueryJsonString = '';    // Reset
                                    }

                                    if (currentBlockType === 'thinking') {
                                        // Signal thinking part is done
                                        socket.emit('thinkingComplete');
                                        // Note: Signature has already been captured via signature_delta events
                                    }
                                    currentBlockType = null;
                                } else if (data.type === 'message_stop') {
                                    console.log('Message generation complete.');
                                }
                            } catch (e) {
                                console.error('Error parsing streaming data in generateNextQuestion:', e);
                                console.error('Problematic line:', line);
                                
                                // Additional error diagnostics
                                if (e instanceof SyntaxError) {
                                    const jsonStr = dataMatch[1];
                                    const errorPosition = e.message.match(/position (\d+)/);
                                    const position = errorPosition ? parseInt(errorPosition[1]) : -1;
                                    
                                    if (position > 0) {
                                        const contextStart = Math.max(0, position - 20);
                                        const contextEnd = Math.min(jsonStr.length, position + 20);
                                        
                                        console.error('JSON parse error context:');
                                        console.error('...' + jsonStr.substring(contextStart, position) + 
                                                    ' 👉 ' + jsonStr.substring(position, contextEnd) + '...');
                                    }
                                }
                            }
                        }
                    });

                    await new Promise((resolve, reject) => {
                        response.body.on('end', async () => { // Ensure this callback is async
                            const claudeApiDuration = Date.now() - claudeApiStartTime;
                            console.log(`[${sessionId}] 🤖 CLAUDE API - Response completed in ${claudeApiDuration}ms`);
                            console.log('Stream ended. Complete response:', completeResponse);
                            console.log('Captured thinking text length:', thinkingText.length);

                            // Retry if Claude returned an empty response
                            if (!completeResponse || completeResponse.trim() === '') {
                                console.warn(`[${sessionId}] Empty response received from Claude. Will retry...`);
                                return reject(new Error('Empty response from Claude'));
                            }

                            // Store the assistant's question with thinking block
                            const assistantQuestionObject = {
                                text: completeResponse,
                                thinkingBlock: capturedThinkingBlock
                            };
                            
                            sessionInfo.assistantQuestions.push(assistantQuestionObject);

                            // TTS removed - questions are displayed as text only

                            // Validate response before sending
                            console.log(`[${sessionId}] Raw response from Claude: "${completeResponse}"`);
                            
                            // Use the complete response as the question (no tags expected)
                            const extractedQuestion = completeResponse.trim();
                            
                            console.log(`[${sessionId}] Extracted question: "${extractedQuestion}"`);
                            
                            // Only emit if we have a valid response after extraction
                            if (extractedQuestion && extractedQuestion.length > 0) {
                                // Don't send the full response again if we already streamed it
                                if (sessionInfo.responseStartedEmitted) {
                                    // Just signal completion without re-sending the question
                                    socket.emit('responseComplete', '');
                                } else {
                                    // Fallback: if streaming didn't work, send the full response
                                    socket.emit('responseComplete', completeResponse);
                                }
                            } else {
                                console.error(`[${sessionId}] Empty response after extraction. Raw response was: "${completeResponse}"`);
                                socket.emit('error', 'Failed to generate a valid question. Please try again.');
                                return;
                            }

                            // Log the first question to Firebase if this is the first question
                            if (interviewResponses.length === 0) {
                                // Fix the linter error by not using await here
                                logResponseToFirebase(sessionId, {
                                    interviewId: sessionInfo.interviewId || null,
                                    question: completeResponse,
                                    answer: null, // No answer yet for the first question
                                    thinkingTrace: capturedThinkingBlock,
                                    fullPrompt: sessionInfo.lastFullPrompt || null, // Include the full prompt
                                    wordTimestamps: null // No word timestamps for AI questions
                                }, sessionInfo.persistentSessionId).catch(err => console.error('Error logging first question to Firebase:', err)); // Pass persistent ID
                            }

                            // Store first question thinking if applicable
                            if (interviewResponses.length === 0 && capturedThinkingBlock) {
                                sessionInfo.firstQuestionThinking = capturedThinkingBlock;
                            }
                            
                            // Clean up streaming state for next question
                            sessionInfo.responseStartedEmitted = false;
                            sessionInfo.streamingState = null;

                            const totalQuestionGenerationDuration = Date.now() - questionGenerationStartTime;
                            console.log(`[${sessionId}] 🎯 QUESTION GENERATION - Total process completed in ${totalQuestionGenerationDuration}ms`);

                            resolve();
                        });

                        response.body.on('error', (err) => {
                            reject(err);
                        });
                    });

                } catch (fetchError) {
                    fetchSuccess = false;
                    fetchRetries++;
                    console.error(`Fetch error (attempt ${fetchRetries}/${maxFetchRetries}):`, fetchError);

                    if (fetchRetries >= maxFetchRetries) {
                        // If we've exhausted all retries, propagate the error
                        throw fetchError;
                    }

                    // Exponential backoff before retrying
                    const backoffMs = Math.min(1000 * Math.pow(2, fetchRetries), 10000);
                    console.log(`Retrying in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                }
            }
        } catch (error) {
            console.error('Question generation error:', error);
            
            // Check if error is connection-related
            if (error.name === 'AbortError' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
                socket.emit('error', 'Connection timeout. Please check your internet connection and try again.');
            } else {
                socket.emit('error', 'Failed to generate next question: ' + error.message);
            }
        }
    }

    // --- START Modified generateReport function ---
    async function generateReport(data, reportSessionId = null) {
        console.log(`[${socket.id}] generateReport called with reportSessionId: ${reportSessionId}, data: ${data ? 'provided' : 'null'}`);
        
        // Apply rate limiting for report generation
        if (!socketRateLimiter.checkLimit(socket.id, 'generateReport', socketLimits.generateReport.limit, socketLimits.generateReport.windowMs)) {
            socket.emit('error', 'Too many report generation requests. Please wait before generating another report.');
            return;
        }
        
        try {
            let contextData, responses, questions, firstName, reportTitle, reportSubtitle, customReportPrompt, persistentSessionIdForReport, userName, userEmail, totalWordCount, interviewIdForReport, userNote;
            let qaPairs = []; // To store Q&A pairs with potential audio URLs
            let sessionInfo = null; // Will be set if we have a reportSessionId

            // Check if we received example data directly or need to fetch from session
            if (reportSessionId) {
                console.log(`[${socket.id}] Fetching session data for sessionId: ${reportSessionId}`);
                // Original logic: Fetch from session
                const reportSessionInfo = sessionData.get(reportSessionId);
                if (!reportSessionInfo) {
                    console.error(`[${socket.id}] Session data not found for ID: ${reportSessionId} in generateReport`);
                    socket.emit('error', 'Interview data not found for report generation.');
                    return;
                }
                console.log(`[${socket.id}] Found session data for ${reportSessionId}`);
                sessionInfo = reportSessionInfo; // Set sessionInfo for later use
                
                contextData = reportSessionInfo.contextData;
                // responsesFromSession = reportSessionInfo.interviewResponses || []; // We will fetch these with URLs now
                // questionsFromSession = reportSessionInfo.assistantQuestions || []; // We will fetch these with URLs now
                firstName = reportSessionInfo.firstName || "User";
                
                customReportPrompt = reportSessionInfo.reportPrompt;
                reportTitle = reportSessionInfo.reportHeader || reportSessionInfo.interviewTitle;
                reportSubtitle = reportSessionInfo.reportSubheader || reportSessionInfo.interviewDescription;
                
                persistentSessionIdForReport = reportSessionInfo.persistentSessionId;
                userName = reportSessionInfo.userName;
                userEmail = reportSessionInfo.userEmail;
                totalWordCount = reportSessionInfo.totalRecordingDuration;
                interviewIdForReport = reportSessionInfo.interviewId;
                userNote = reportSessionInfo.userNote || null;

                console.log(`[${socket.id}] Report data: title="${reportTitle}", persistentId="${persistentSessionIdForReport}"`);
                console.log(`[${socket.id}] Session info details:`, {
                    hasContextData: !!contextData,
                    contextDataLength: contextData ? contextData.length : 0,
                    userName,
                    userEmail,
                    totalRecordingDuration: totalWordCount,
                    interviewId: interviewIdForReport,
                    responsesCount: reportSessionInfo.interviewResponses?.length || 0,
                    questionsCount: reportSessionInfo.assistantQuestions?.length || 0
                });

                if (!persistentSessionIdForReport) {
                    console.error(`[${socket.id}] Persistent Session ID (Report Document ID) not found in sessionData. Cannot update report.`);
                    socket.emit('error', 'Critical error: Report ID missing for update.');
                    return;
                }

                // Fetch responses with signed URLs for actual session
                try {
                    console.log(`[${socket.id}] Fetching responses with signed URLs for report: ${persistentSessionIdForReport}`);
                    // Ensure GCS_BUCKET_NAME is available in this scope or passed appropriately
                    qaPairs = await getResponsesWithSignedUrls(persistentSessionIdForReport, db, storage, GCS_BUCKET_NAME);
                    console.log(`[${socket.id}] Successfully fetched ${qaPairs.length} Q&A pairs with signed URLs`);
                    if (qaPairs.length === 0) {
                        console.warn(`[${socket.id}] WARNING: No Q&A pairs found for report generation!`);
                    } else {
                        console.log(`[${socket.id}] First Q&A pair sample:`, {
                            question: qaPairs[0].question?.substring(0, 50) + '...',
                            answerLength: qaPairs[0].answer?.length || 0,
                            hasAudioUrl: !!qaPairs[0].audio_signed_url
                        });
                    }
                } catch (fetchError) {
                    console.error(`[${socket.id}] Error fetching responses with signed URLs for report ${persistentSessionIdForReport}:`, fetchError);
                    socket.emit('error', 'Failed to retrieve interview details for report generation.');
                    return;
                }

            } else if (data && typeof data === 'object') {
                // New logic: Use provided example data (This path won't update Firestore for now)
                contextData = data.resume || data.contextData; 
                // For example data, we map it to the qaPairs structure
                const exampleResponses = data.responses || [];
                const exampleQuestions = data.questions || [];
                const minLength = Math.min(exampleResponses.length, exampleQuestions.length);
                for (let i = 0; i < minLength; i++) {
                    qaPairs.push({
                        question: exampleQuestions[i]?.text || (typeof exampleQuestions[i] === 'string' ? exampleQuestions[i] : 'Unknown Question'),
                        answer: exampleResponses[i] || '',
                        audio_signed_url: null // No audio for example data
                    });
                }
                firstName = data.firstName || "Example User";
                customReportPrompt = data.reportPrompt;
                reportTitle = data.reportHeader;
                reportSubtitle = data.reportSubheader;
            } else {
                console.error('Invalid call to generateReport: Missing session ID or example data.');
                socket.emit('error', 'Internal server error during report generation.');
                return;
            }
            
            // Format the Q&A content into XML for Claude
            let qaXml = '';
            qaPairs.forEach(pair => {
                qaXml += `<qa_pair>\n`;
                qaXml += `  <question>${escapeXml(pair.question)}</question>\n`;
                if (pair.audio_signed_url) {
                    qaXml += `  <answer audio_response_id="${escapeXml(pair.id)}">${escapeXml(pair.answer)}</answer>\n`;
                } else {
                    qaXml += `  <answer>${escapeXml(pair.answer)}</answer>\n`;
                }
                qaXml += `</qa_pair>\n\n`;
            });
            
            console.log(`[${socket.id}] Generated Q&A XML length: ${qaXml.length} characters`);
            if (qaXml.length === 0) {
                console.error(`[${socket.id}] ERROR: No Q&A XML generated for report!`);
            }

            // Get admin information for personalized report
            // Build the report prompt using simple template replacement
            const reportPrompt = buildPersonalizedReportPrompt({
                customReportPrompt,
                contextData,
                qaXml,
                firstName
            });
            
            // Add report prompt to combined prompt
            let combinedPrompt = '';
            combinedPrompt += reportPrompt;
            
            // Use the combined prompt as the system prompt
            const systemPrompt = combinedPrompt;

            // Build messages with prompt caching
            const messages = [{
                role: "user",
                content: [
                    {
                        type: "text",
                        text: systemPrompt,
                        cache_control: {"type": "ephemeral"}
                    }
                ]
            }];

            console.log(`\n==== FULL PROMPT SENT TO ANTHROPIC (generateReport - ${reportSessionId ? `Session: ${reportSessionId}, ReportDocID: ${persistentSessionIdForReport}` : 'Example'}) ====`)
            console.log(JSON.stringify({
                model: "claude-sonnet-4-6",
                max_tokens: 15000,
                system: REPORT_GENERATION_SYSTEM_PROMPT,
                messages: messages,
                thinking: {
                    "type": "enabled",
                    "budget_tokens": 10000
                },
                stop_sequences: ["</final_report>"],
                stream: true
            }, null, 2));
            console.log("=======================================================\n");

            console.log(`[${socket.id}] Emitting reportThinkingStarted for ${reportSessionId || 'example'}`);
            
            // Mark that thinking has started in session info
            if (sessionInfo) {
                sessionInfo.reportThinkingStarted = true;
            }
            
            // Emit to the original socket
            socket.emit('reportThinkingStarted');
            
            // Also emit to any other sockets listening for this report
            if (sessionInfo && sessionInfo.reportListeners) {
                sessionInfo.reportListeners.forEach(listenerSocket => {
                    if (listenerSocket !== socket && listenerSocket.connected) {
                        console.log(`Emitting reportThinkingStarted to listener socket ${listenerSocket.id}`);
                        listenerSocket.emit('reportThinkingStarted');
                    }
                });
            }

            console.log(`[${socket.id}] Making Claude API call for report generation...`);
            const response = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": CLAUDE_API_KEY,
                    "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify({
                    model: "claude-sonnet-4-6",
                    max_tokens: 15000,
                    system: REPORT_GENERATION_SYSTEM_PROMPT,
                    messages: messages,
                    thinking: {
                        "type": "enabled",
                        "budget_tokens": 10000
                    },
                    stop_sequences: ["</final_report>"],
                    stream: true
                })
            });

            if (!response.ok) {
                const errorData = await response.text();
                console.error(`[${socket.id}] Claude API error generating report:`, errorData);
                throw new Error('Failed to generate report from Claude API');
            }

            console.log(`[${socket.id}] Claude API response received, starting to process stream...`);
            let completeReport = '';
            let currentBlockType = null;
            let isProcessingReportThinking = false;
            let reportStreamBuffer = ''; // Buffer to handle partial lines across chunks

            response.body.on('data', (chunk) => {
                // Append chunk to buffer to handle partial lines
                reportStreamBuffer += chunk.toString();

                // Split on newlines but keep the last partial line in buffer
                const lines = reportStreamBuffer.split('\n');
                // Keep the last element (may be incomplete) in buffer for next chunk
                reportStreamBuffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim() || !line.startsWith('data: ')) continue;
                    const dataMatch = line.match(/^data: (.+)$/);
                    if (!dataMatch) continue;
                    if (dataMatch[1] === '[DONE]') continue;

                    try {
                        let jsonStr = dataMatch[1];
                        
                        // Simplified validation - just check if it's likely a complete JSON object
                        const isLikelyComplete = (jsonStr) => {
                            const trimmed = jsonStr.trim();
                            return trimmed.startsWith('{') && trimmed.endsWith('}');
                        };
                        
                        if (!isLikelyComplete(jsonStr)) {
                            console.warn('Received potentially incomplete JSON chunk in report generation, skipping parse:', 
                                jsonStr.length > 100 ? jsonStr.substring(0, 100) + '...' : jsonStr);
                            continue;
                        }
                        
                        const data = JSON.parse(jsonStr);

                        if (data.type === 'content_block_start') {
                            currentBlockType = data.content_block.type;
                            console.log(`[${socket.id}] Report stream: content_block_start, type: ${currentBlockType}`);
                            if (currentBlockType === 'thinking') {
                                isProcessingReportThinking = true;
                            } else {
                                isProcessingReportThinking = false;
                            }
                        } else if (data.type === 'content_block_delta') {
                            if (data.delta.type === 'text_delta' && currentBlockType === 'text') {
                                const textChunk = data.delta.text || '';
                                console.log(`[${socket.id}] Report stream: text_delta, length: ${textChunk.length}`);
                                completeReport += textChunk;
                                socket.emit('reportContentUpdate', textChunk);
                                
                                // Also emit to any other sockets listening for this report
                                if (sessionInfo && sessionInfo.reportListeners) {
                                    sessionInfo.reportListeners.forEach(listenerSocket => {
                                        if (listenerSocket !== socket && listenerSocket.connected) {
                                            listenerSocket.emit('reportContentUpdate', textChunk);
                                        }
                                    });
                                }
                            } else if (data.delta.type === 'thinking_delta' && currentBlockType === 'thinking' && isProcessingReportThinking) {
                                let thinkingChunk = data.delta.thinking || '';
                                
                                if (thinkingChunk.includes('<final_report>') || thinkingChunk.includes('</final_report>')) {
                                    console.log(`[${socket.id}] WARNING: Found final_report tags in thinking content - filtering`);
                                    thinkingChunk = thinkingChunk.replace(/<\/?final_report>/g, '');
                                }
                                
                                if (thinkingChunk.trim()) {
                                    console.log(`[${socket.id}] Report stream: thinking_delta, length: ${thinkingChunk.length}`);
                                }
                                socket.emit('reportThinkingUpdate', thinkingChunk);
                                
                                // Accumulate thinking trace for late-joining sockets
                                if (sessionInfo) {
                                    if (!sessionInfo.accumulatedThinkingTrace) {
                                        sessionInfo.accumulatedThinkingTrace = '';
                                    }
                                    sessionInfo.accumulatedThinkingTrace += thinkingChunk;
                                }
                                
                                // Also emit to any other sockets listening for this report
                                if (sessionInfo && sessionInfo.reportListeners) {
                                    sessionInfo.reportListeners.forEach(listenerSocket => {
                                        if (listenerSocket !== socket && listenerSocket.connected) {
                                            listenerSocket.emit('reportThinkingUpdate', thinkingChunk);
                                        }
                                    });
                                }
                            }
                        } else if (data.type === 'content_block_stop') {
                            console.log(`[${socket.id}] Report stream: content_block_stop, type: ${currentBlockType}`);
                            if (currentBlockType === 'thinking') {
                                console.log(`[${socket.id}] Report stream: emitting reportThinkingComplete`);
                                socket.emit('reportThinkingComplete');
                                
                                // Also emit to any other sockets listening for this report
                                if (sessionInfo && sessionInfo.reportListeners) {
                                    sessionInfo.reportListeners.forEach(listenerSocket => {
                                        if (listenerSocket !== socket && listenerSocket.connected) {
                                            listenerSocket.emit('reportThinkingComplete');
                                        }
                                    });
                                }
                                isProcessingReportThinking = false;
                            }
                            currentBlockType = null;
                        } else if (data.type === 'message_stop') {
                            console.log(`[${socket.id}] Report stream: message_stop - Report generation complete`);
                        }
                    } catch (e) {
                        console.error('Error parsing report streaming data:', e);
                        console.error('Problematic line:', line);
                        
                        if (e instanceof SyntaxError) {
                            const jsonStr = dataMatch[1];
                            const errorPosition = e.message.match(/position (\d+)/);
                            const position = errorPosition ? parseInt(errorPosition[1]) : -1;
                            
                            if (position > 0) {
                                const contextStart = Math.max(0, position - 20);
                                const contextEnd = Math.min(jsonStr.length, position + 20);
                                
                                console.error('JSON parse error context:');
                                console.error('...' + jsonStr.substring(contextStart, position) + 
                                            ' 👉 ' + jsonStr.substring(position, contextEnd) + '...');
                            }
                        }
                    }
                }
            });

            await new Promise((resolve, reject) => {
                response.body.on('end', async () => { // Make this callback async
                    console.log('Report stream ended.');
                    socket.emit('reportThinkingComplete');
                    
                    // Also emit to any other sockets listening for this report
                    if (sessionInfo && sessionInfo.reportListeners) {
                        sessionInfo.reportListeners.forEach(listenerSocket => {
                            if (listenerSocket !== socket && listenerSocket.connected) {
                                listenerSocket.emit('reportThinkingComplete');
                            }
                        });
                    }

                    let processedReport = completeReport;
                    
                    // Try to extract from <individual_summary_report> first
                    let reportMatch = processedReport.match(/<individual_summary_report>([\s\S]*?)<\/individual_summary_report>/i);
                    if (reportMatch && reportMatch[1]) {
                        processedReport = reportMatch[1].trim();
                        console.log(`Extracted report from <individual_summary_report> tags, length: ${processedReport.length}`);
                    } else {
                        // Fall back to <final_report> tags
                        const finalReportMatch = processedReport.match(/<final_report>([\s\S]*?)<\/final_report>/i);
                        if (finalReportMatch && finalReportMatch[1]) {
                            processedReport = finalReportMatch[1].trim();
                            console.log(`Extracted report from <final_report> tags, length: ${processedReport.length}`);
                        } else {
                            console.warn('Could not find <individual_summary_report> or <final_report> tags. Sending full response.');
                        }
                    }

                    // Determine the final title to emit
                    // reportTitle is already populated from:
                    // reportTitle = reportSessionInfo.reportHeader || reportSessionInfo.interviewTitle;
                    let finalTitleForEmit;
                    if (reportSessionId && persistentSessionIdForReport) { // It's a "real" report
                        finalTitleForEmit = reportTitle || "Report";
                    } else { // It's an example or fallback
                        finalTitleForEmit = reportTitle || "PAIRR Example Report";
                    }

                    // Emit event with report ID and content if it's a session-based report
                    if (reportSessionId && persistentSessionIdForReport) {
                        console.log(`[generateReport] Emitting 'reportGeneratedWithId' for report ${persistentSessionIdForReport}`);
                        socket.emit('reportGeneratedWithId', {
                            reportId: persistentSessionIdForReport,
                            reportContent: processedReport,
                            reportTitle: finalTitleForEmit // Ensure title is included
                        });
                        
                        // Also emit to any other sockets listening for this report
                        if (sessionInfo && sessionInfo.reportListeners) {
                            sessionInfo.reportListeners.forEach(listenerSocket => {
                                if (listenerSocket !== socket && listenerSocket.connected) {
                                    listenerSocket.emit('reportGeneratedWithId', {
                                        reportId: persistentSessionIdForReport,
                                        reportContent: processedReport,
                                        reportTitle: finalTitleForEmit
                                    });
                                }
                            });
                        }
                    } else {
                        // Fallback for example reports or scenarios without a persistent ID to link
                        console.log(`[generateReport] Emitting 'reportComplete' (no persistent ID available or example report)`);
                        socket.emit('reportComplete', { // Emit an object
                            reportContent: processedReport,
                            reportTitle: finalTitleForEmit // Ensure title is included
                        });
                    }
                    
                    // --- START: Update existing report document in Firestore ---
                    if (reportSessionId && persistentSessionIdForReport && db) { // Only update if it's a real session and db is available
                        try {
                            const reportDocRef = db.collection('reports').doc(persistentSessionIdForReport);
                            const reportUpdateData = {
                                report_content: processedReport,
                                report_title: reportTitle, // Ensure title and subtitle are also updated/confirmed
                                report_subtitle: reportSubtitle,
                                user_name: userName, // Ensure user details are present
                                user_email: userEmail,
                                total_recording_duration: totalWordCount || 0, // Ensure word count is updated
                                interview_id: interviewIdForReport || null, // Ensure interview_id is updated/confirmed
                                user_note: userNote || null, // Admin's personal thank you note
                                status: 'completed', // Mark report as completed
                                end_timestamp: admin.firestore.FieldValue.serverTimestamp()
                            };

                            // Audio and video generation removed for user reports
                            // User reports are text-only as per requirements
                            
                            // Video generation also removed for user reports
                            // User reports are text-only 

                            await reportDocRef.update(reportUpdateData);
                            console.log(`Report document ${persistentSessionIdForReport} updated in Firestore with final content.`);
                            
                            // Track interview completion for billing/usage
                            const sessionInfo = sessionData.get(reportSessionId);
                            if (pricingService && sessionInfo && sessionInfo.userId) {
                                try {
                                    await pricingService.incrementInterviewUsage(sessionInfo.userId);
                                    console.log(`[${socket.id}] Interview usage incremented for user ${sessionInfo.userId}`);
                                } catch (usageError) {
                                    console.error(`[${socket.id}] Error incrementing interview usage:`, usageError);
                                    // Don't let usage tracking errors break the report generation
                                }
                            } else if (!sessionInfo?.userId) {
                                console.warn(`[${socket.id}] No userId found in session data for usage tracking`);
                            }
                            
                            // Update memory service to mark interview as completed (only if enabled)
                            if (memoryService && persistentSessionIdForReport && sessionInfo?.enableMemoryService) {
                                try {
                                    await memoryService.updateInterviewCompletion(persistentSessionIdForReport, processedReport);
                                    console.log(`[${socket.id}] Memory service updated for completed interview ${persistentSessionIdForReport}`);
                                } catch (memoryError) {
                                    console.error(`[${socket.id}] Error updating memory service for interview completion:`, memoryError);
                                    // Don't let memory service errors break the report generation
                                }
                            } else if (memoryService && persistentSessionIdForReport && !sessionInfo?.enableMemoryService) {
                                console.log(`[${socket.id}] Memory service disabled for interview ${persistentSessionIdForReport}, skipping completion update`);
                            }
                            
                            // Update template usage statistics if this interview was created from a template
                            if (interviewIdForReport) {
                                try {
                                    await updateTemplateCompletionStats(interviewIdForReport);
                                    console.log(`[${socket.id}] Template completion stats updated for interview ${interviewIdForReport}`);
                                } catch (templateError) {
                                    console.error(`[${socket.id}] Error updating template completion stats:`, templateError);
                                    // Don't let template tracking errors break the report generation
                                }
                            }
                        } catch (error) {
                            console.error(`Error updating report document ${persistentSessionIdForReport} in Firestore:`, error);
                        }
                    } else if (reportSessionId && !persistentSessionIdForReport) {
                        console.error(`Cannot update report for session ${reportSessionId}: persistentSessionIdForReport is missing.`);
                    } else if (reportSessionId && !db) {
                        console.warn(`Firebase not available, skipping report document update for ${persistentSessionIdForReport}.`);
                    }
                    // --- END: Update existing report document in Firestore ---
                    
                    // --- START: Send Report Email ---
                    console.log(`[generateReport] Email check - reportSessionId: ${reportSessionId}, persistentSessionId: ${persistentSessionIdForReport}`);
                    if (reportSessionId && persistentSessionIdForReport) { // Only send email for real sessions (not examples)
                        const sessionInfo = sessionData.get(reportSessionId);
                        console.log(`[generateReport] Session info:`, {
                            hasSessionInfo: !!sessionInfo,
                            userEmail: sessionInfo?.userEmail,
                            userName: sessionInfo?.userName,
                            firstName: sessionInfo?.firstName,
                            campaignEmailId: sessionInfo?.campaignEmailId
                        });
                        
                        // Update campaign tracking if this interview came from a campaign
                        if (sessionInfo && sessionInfo.campaignEmailId) {
                            try {
                                await db.collection('campaign_emails').doc(sessionInfo.campaignEmailId).update({
                                    interviewCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
                                    reportId: persistentSessionIdForReport,
                                    lastActivity: admin.firestore.FieldValue.serverTimestamp()
                                });
                                console.log(`[generateReport] Updated campaign email tracking for interview completion`);
                            } catch (error) {
                                console.error(`[generateReport] Error updating campaign email tracking:`, error);
                            }
                        }
                        
                        // Send email to the user who took the interview
                        if (sessionInfo && sessionInfo.userEmail) {
                            console.log(`[generateReport] ✅ Attempting to send report email to ${sessionInfo.userEmail} for report ${persistentSessionIdForReport}`);
                            
                            // Send email asynchronously (don't block the response)
                            // Get the session ID from the report document to include in email
                            let sessionIdForEmail = reportSessionId; // Use the socket session ID
                            
                            sendReportEmail(
                                sessionInfo.userEmail,
                                sessionInfo.userName || sessionInfo.firstName || 'User',
                                processedReport,
                                finalTitleForEmit,
                                persistentSessionIdForReport,
                                sessionInfo.interviewId,
                                sessionIdForEmail,
                                sessionInfo.userId // Pass the admin's userId
                            ).catch(emailError => {
                                console.error(`[generateReport] Email sending failed for report ${persistentSessionIdForReport}:`, emailError);
                                // Don't throw error here - email failure shouldn't break report generation
                            });
                        } else {
                            console.warn(`[generateReport] No user email found in session data for report ${persistentSessionIdForReport}. Skipping email send.`);
                        }
                        
                        // Send email to admin and shared users
                        if (interviewIdForReport && db) {
                            console.log(`[generateReport] Fetching interview data to send emails to admin and shared users`);
                            try {
                                const interviewDoc = await db.collection('interviews').doc(interviewIdForReport).get();
                                if (interviewDoc.exists) {
                                    const interviewData = interviewDoc.data();
                                    const emailsToSend = [];
                                    const emailSet = new Set(); // Track unique emails
                                    
                                    // Add admin email if they have one
                                    if (interviewData.createdBy) {
                                        const adminDoc = await db.collection('users').doc(interviewData.createdBy).get();
                                        if (adminDoc.exists && adminDoc.data().email) {
                                            const adminEmail = adminDoc.data().email;
                                            if (!emailSet.has(adminEmail)) {
                                                emailSet.add(adminEmail);
                                                emailsToSend.push({
                                                    email: adminEmail,
                                                    userId: interviewData.createdBy,
                                                    name: adminDoc.data().displayName || 'Admin'
                                                });
                                                console.log(`[generateReport] Added admin email: ${adminEmail}`);
                                            }
                                        }
                                    }
                                    
                                    // Add shared users' emails
                                    if (interviewData.sharedWith && Array.isArray(interviewData.sharedWith)) {
                                        for (const sharedEmail of interviewData.sharedWith) {
                                            if (!emailSet.has(sharedEmail)) {
                                                emailSet.add(sharedEmail);
                                                emailsToSend.push({
                                                    email: sharedEmail,
                                                    userId: null,
                                                    name: 'Shared User'
                                                });
                                                console.log(`[generateReport] Added shared user email: ${sharedEmail}`);
                                            }
                                        }
                                    }
                                    
                                    // Send emails to all recipients
                                    for (const recipient of emailsToSend) {
                                        // Don't send duplicate email to the user who just took the interview
                                        if (recipient.email !== sessionInfo.userEmail) {
                                            console.log(`[generateReport] Sending report email to ${recipient.email}`);
                                            sendReportEmail(
                                                recipient.email,
                                                recipient.name,
                                                processedReport,
                                                finalTitleForEmit,
                                                persistentSessionIdForReport,
                                                interviewIdForReport,
                                                sessionIdForEmail,
                                                recipient.userId
                                            ).catch(emailError => {
                                                console.error(`[generateReport] Email sending failed for ${recipient.email}:`, emailError);
                                            });
                                        }
                                    }
                                }
                            } catch (error) {
                                console.error(`[generateReport] Error fetching interview data for email notifications:`, error);
                            }
                        }
                    }
                    // --- END: Send Report Email ---
                    
                    resolve();
                });

                response.body.on('error', (err) => {
                    console.error('Report stream error:', err);
                    socket.emit('error', 'Connection error while generating report');
                    reject(err);
                });
            });
        } catch (error) {
            console.error('Report generation error:', error);
            socket.emit('error', 'Failed to generate report: ' + error.message);
        }
    }
    // --- END Modified generateReport function ---

    // --- START: Generate Admin Report Function ---
    async function generateAdminReport(reportSessionId, persistentSessionIdForReport) {
        console.log(`[${socket.id}] generateAdminReport called for reportSessionId: ${reportSessionId}, reportId: ${persistentSessionIdForReport}`);
        
        try {
            // Fetch session data
            const reportSessionInfo = sessionData.get(reportSessionId);
            if (!reportSessionInfo) {
                console.error(`[${socket.id}] Session data not found for generateAdminReport`);
                return null;
            }

            const contextData = reportSessionInfo.contextData;
            const customAdminReportPrompt = reportSessionInfo.adminReportPrompt;
            const userName = reportSessionInfo.userName;
            const userEmail = reportSessionInfo.userEmail;
            const interviewIdForReport = reportSessionInfo.interviewId;

            // Fetch responses with signed URLs
            let qaPairs = [];
            try {
                console.log(`[${socket.id}] Fetching responses for admin report: ${persistentSessionIdForReport}`);
                qaPairs = await getResponsesWithSignedUrls(persistentSessionIdForReport, db, storage, GCS_BUCKET_NAME);
                console.log(`[${socket.id}] Successfully fetched ${qaPairs.length} Q&A pairs for admin report`);
            } catch (fetchError) {
                console.error(`[${socket.id}] Error fetching responses for admin report:`, fetchError);
                return null;
            }

            // Format Q&A content into XML
            let qaXml = '';
            qaPairs.forEach(pair => {
                qaXml += `<qa_pair>\n`;
                qaXml += `  <question>${escapeXml(pair.question)}</question>\n`;
                if (pair.audio_signed_url) {
                    qaXml += `  <answer audio_response_id="${escapeXml(pair.id)}">${escapeXml(pair.answer)}</answer>\n`;
                } else {
                    qaXml += `  <answer>${escapeXml(pair.answer)}</answer>\n`;
                }
                qaXml += `</qa_pair>\n\n`;
            });

            // Prepare the system prompt
            const systemPrompt = customAdminReportPrompt ? 
                customAdminReportPrompt
                    .replace('{{CONTEXT}}', contextData || '')
                    .replace('{{QA_CONTENT}}', qaXml) 
                : 
                // Default admin prompt
                `You are an AI assistant creating an admin-only summary report. This is for the interview administrator and should be brutally honest and direct.

Context:
${contextData || 'Context not provided'}

Interview Q&A:
${qaXml}

Generate a highly concise, third-person summary that:
1. States who was interviewed and the core topic
2. Highlights the most important takeaway with 1-2 key direct quotes using <audio_clip id="THE_RESPONSE_ID">quote</audio_clip> format
3. Ends with the most actionable insight
4. Maximum 3-4 sentences total

Wrap your response in <admin_summary_report> tags.`;

            // Build messages with prompt caching
            const messages = [{
                role: "user",
                content: [
                    {
                        type: "text",
                        text: systemPrompt,
                        cache_control: {"type": "ephemeral"}
                    }
                ]
            }];

            console.log(`[${socket.id}] Making Claude API call for admin report generation...`);
            const response = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": CLAUDE_API_KEY,
                    "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify({
                    model: "claude-sonnet-4-6",
                    max_tokens: 8000,
                    messages: messages,
                    thinking: {
                        "type": "enabled",
                        "budget_tokens": 3000
                    }
                })
            });

            if (!response.ok) {
                const errorData = await response.text();
                console.error(`[${socket.id}] Claude API error generating admin report:`, errorData);
                throw new Error('Failed to generate admin report from Claude API');
            }

            const responseData = await response.json();
            let adminReportContent = responseData.content[0].text || '';

            // Extract content from admin_summary_report tags
            const adminReportMatch = adminReportContent.match(/<admin_summary_report>([\s\S]*?)<\/admin_summary_report>/i);
            if (adminReportMatch && adminReportMatch[1]) {
                adminReportContent = adminReportMatch[1].trim();
            }

            console.log(`[${socket.id}] Admin report generated successfully, length: ${adminReportContent.length}`);

            // Update Firestore with admin report
            if (db && persistentSessionIdForReport) {
                try {
                    const reportDocRef = db.collection('reports').doc(persistentSessionIdForReport);
                    await reportDocRef.update({
                        admin_report_content: adminReportContent,
                        admin_report_generated_at: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.log(`[${socket.id}] Admin report saved to Firestore for report ${persistentSessionIdForReport}`);

                    // Generate audio for admin report
                    try {
                        const audioGcsPath = await generateAndStoreReportAudio(
                            persistentSessionIdForReport + '_admin', // Add suffix to differentiate from user report
                            adminReportContent, 
                            qaPairs,
                            db, 
                            storage, 
                            GCS_BUCKET_NAME, 
                            openai
                        );
                        if (audioGcsPath) {
                            await reportDocRef.update({
                                admin_audio_gcs_url: audioGcsPath
                            });
                            console.log(`[${socket.id}] Admin report audio generated and saved: ${audioGcsPath}`);
                        }
                    } catch (audioError) {
                        console.error(`[${socket.id}] Error generating admin report audio:`, audioError);
                    }
                } catch (error) {
                    console.error(`[${socket.id}] Error saving admin report to Firestore:`, error);
                }
            }

            // Send admin report email to configured admin and all shared admins
            const adminEmails = [];
            const mainAdminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
            if (mainAdminEmail) {
                adminEmails.push(mainAdminEmail);
            }
            
            // Fetch interview to get sharedWith emails
            if (interviewIdForReport && db) {
                try {
                    const interviewDoc = await db.collection('interviews').doc(interviewIdForReport).get();
                    if (interviewDoc.exists) {
                        const interviewData = interviewDoc.data();
                        const sharedWithEmails = interviewData.sharedWith || [];
                        console.log(`[${socket.id}] Interview is shared with: ${sharedWithEmails.join(', ')}`);
                        adminEmails.push(...sharedWithEmails);
                    }
                } catch (error) {
                    console.error(`[${socket.id}] Error fetching interview for sharedWith emails:`, error);
                }
            }
            
            // Remove duplicates
            const uniqueAdminEmails = [...new Set(adminEmails)];
            
            // Send to all admin emails
            if (uniqueAdminEmails.length > 0 && userEmail) {
                console.log(`[${socket.id}] Sending admin report email to ${uniqueAdminEmails.length} recipients: ${uniqueAdminEmails.join(', ')}`);
                for (const adminEmail of uniqueAdminEmails) {
                    try {
                        await sendReportEmail(
                            adminEmail,
                            'Admin',
                            adminReportContent,
                            `Admin Report: ${reportSessionInfo.reportHeader || reportSessionInfo.interviewTitle || 'Interview'}`,
                            persistentSessionIdForReport,
                            interviewIdForReport,
                            reportSessionId, // Include session ID for admin reports too
                            reportSessionInfo.userId // Pass the admin's userId
                        );
                        console.log(`[${socket.id}] Admin report email sent successfully to ${adminEmail}`);
                    } catch (emailError) {
                        console.error(`[${socket.id}] Failed to send admin report email to ${adminEmail}:`, emailError);
                        // Don't fail the whole function if email fails
                    }
                }
            } else if (uniqueAdminEmails.length === 0) {
                console.warn(`[${socket.id}] No admin emails configured or shared. Skipping admin report email.`);
            }

            return adminReportContent;
        } catch (error) {
            console.error(`[${socket.id}] Error generating admin report:`, error);
            return null;
        }
    }
    // --- END: Generate Admin Report Function ---

    // Handler for client requesting state after simple reconnection
    socket.on('requestCurrentState', () => {
        const sessionInfo = sessionData.get(sessionId);
        if (sessionInfo) {
            const lastQuestion = sessionInfo.assistantQuestions && sessionInfo.assistantQuestions.length > 0 
                ? sessionInfo.assistantQuestions[sessionInfo.assistantQuestions.length - 1]?.text 
                : null;
            
            console.log(`[${sessionId}] Sending current state: thinking=${sessionInfo.thinking || false}, questionCount=${sessionInfo.assistantQuestions?.length || 0}`);
            
            socket.emit('currentState', {
                lastQuestion: lastQuestion,
                recordingTime: sessionInfo.totalRecordingDuration || 0,
                thinking: sessionInfo.thinking || false,
                questionCount: sessionInfo.assistantQuestions?.length || 0
            });
        } else {
             console.log(`[${sessionId}] No state to send for requestCurrentState.`);
        }
    });
    
    // Handler for client requesting session restore after page refresh
    socket.on('restoreSessionRequest', (oldSessionId) => {
        const newSessionId = socket.id; // The ID of the *current* connection
        console.log(`[${newSessionId}] Received restoreSessionRequest for old session ID: ${oldSessionId}`);
    
        if (sessionData.has(oldSessionId)) {
            const oldData = sessionData.get(oldSessionId);
            console.log(`[${newSessionId}] Found data for old session ${oldSessionId}. Restoring to new session.`);
    
            // Copy data to the new session ID
            // Important: Ensure we copy deeply if necessary, though current structure might be okay
            sessionData.set(newSessionId, { ...oldData });
    
            // Update last active time for the restored session
            sessionData.get(newSessionId).lastActive = Date.now();
    
            // Optionally remove the old session entry immediately
            // sessionData.delete(oldSessionId);
            // Or let the cleanup interval handle it to allow for potential reuse if this fails
    
            const lastQuestion = oldData.assistantQuestions && oldData.assistantQuestions.length > 0
                ? oldData.assistantQuestions[oldData.assistantQuestions.length - 1]?.text
                : 'Welcome back! Starting interview...'; // Provide a default if no questions yet
    
            socket.emit('restoreSessionData', {
                resume: oldData.contextData,
                // Send back the questions and responses for the client to rebuild its state if needed
                // questions: oldData.assistantQuestions, // Client might not need full history
                // responses: oldData.interviewResponses, // Client might not need full history
                recordingTime: oldData.totalRecordingDuration || 0,
                lastQuestion: lastQuestion
            });
            console.log(`[${newSessionId}] Sent restoreSessionData.`);
    
        } else {
            console.log(`[${newSessionId}] No session data found for old ID: ${oldSessionId}. Restore failed.`);
            socket.emit('restoreFailed');
        }
    });

    // Update session data with total recording time sent from client
    socket.on('updateTotalRecordingTime', (data) => {
        const sessionInfo = sessionData.get(sessionId);
        if (sessionInfo && typeof data.totalTime === 'number') {
            sessionInfo.totalRecordingDuration = data.totalTime;
            console.log(`[${sessionId}] Updated total recording time on server to: ${formatTimeForLog(sessionInfo.totalRecordingDuration)}`);
            // Optionally, update Firestore here if needed for live tracking, or only on report generation
        }
    });
    
    // Handle restoration from backup after deployment
    socket.on('restoreFromBackup', async (backupData) => {
        const newSessionId = socket.id;
        console.log(`[${newSessionId}] Received deployment backup restoration request`);
        
        if (!backupData || !backupData.id) {
            console.error(`[${newSessionId}] Invalid backup data received`);
            socket.emit('restoreFailed', { reason: 'Invalid backup data' });
            return;
        }
        
        try {
            // Check if we have a recent backup file from graceful shutdown
            const fs = require('fs');
            let serverBackup = null;
            
            if (fs.existsSync('session-backup.json')) {
                const backupContent = fs.readFileSync('session-backup.json', 'utf8');
                const allBackups = JSON.parse(backupContent);
                
                // Find matching session by interview ID
                for (const [oldSessionId, sessionBackup] of Object.entries(allBackups)) {
                    if (sessionBackup.responses && sessionBackup.responses.length > 0) {
                        // Match by interview content similarity
                        const lastClientResponse = backupData.responses[backupData.responses.length - 1];
                        const lastServerResponse = sessionBackup.responses[sessionBackup.responses.length - 1];
                        
                        if (lastClientResponse && lastServerResponse && 
                            lastClientResponse.text === lastServerResponse.text) {
                            serverBackup = sessionBackup;
                            console.log(`[${newSessionId}] Found matching server backup for interview`);
                            break;
                        }
                    }
                }
            }
            
            // Merge client and server backup data
            const restoredData = {
                interviewResponses: serverBackup?.responses || backupData.responses || [],
                assistantQuestions: [],
                contextData: null,
                customPrompt: null,
                firstName: null,
                totalRecordingDuration: serverBackup?.cumulativeAudioDuration || backupData.recordingTime || 0,
                questionCount: serverBackup?.questionCount || backupData.questionCount || 0,
                lastActive: Date.now(),
                deepgramSocket: null,
                currentTranscription: '',
                currentWordTimestamps: [],
                keepAliveInterval: null,
                isGracefullyClosingDeepgram: false
            };
            
            // Store in session data
            sessionData.set(newSessionId, restoredData);
            
            // Notify client of successful restoration
            socket.emit('restoreSessionData', {
                recordingTime: restoredData.totalRecordingDuration,
                questionCount: restoredData.questionCount,
                lastQuestion: backupData.currentQuestion || 'Interview restored. Please continue...',
                restorationSource: serverBackup ? 'server' : 'client'
            });
            
            console.log(`[${newSessionId}] Successfully restored interview from ${serverBackup ? 'server' : 'client'} backup`);
            
            // Clean up backup file if used
            if (serverBackup && fs.existsSync('session-backup.json')) {
                fs.unlinkSync('session-backup.json');
                console.log('💾 Cleaned up session backup file');
            }
            
        } catch (error) {
            console.error(`[${newSessionId}] Error restoring from backup:`, error);
            socket.emit('restoreFailed', { reason: 'Restoration error' });
        }
    });

    // Helper function to format time for server logs (optional)
    function formatTimeForLog(totalSeconds) {
        if (typeof totalSeconds !== 'number' || isNaN(totalSeconds)) {
            return '0m 0s'; // Return a default if input is invalid
        }
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}m ${seconds}s`;
    }

    // NEW: Handler for the final audio blob for storage
    socket.on('finalAudioBlobForStorage', async ({ audioData, responseDocId, persistentSessionId, mimeType }) => {
        console.log(`[${sessionId}] Received finalAudioBlobForStorage for responseDocId: ${responseDocId}, reportId: ${persistentSessionId}. Size: ${audioData ? audioData.byteLength : 'null'}, Type: ${mimeType}`);
        const sessionInfo = sessionData.get(sessionId);
        if (!sessionInfo) {
            console.error(`[${sessionId}] Session info not found for finalAudioBlobForStorage. Aborting.`);
            socket.emit('audioStorageError', { responseDocId: responseDocId, message: 'Session not found' });
            return;
        }
        if (!audioData || audioData.byteLength === 0) {
            console.error(`[${sessionId}] Empty audio data received in finalAudioBlobForStorage for responseDocId: ${responseDocId}.`);
            socket.emit('audioStorageError', { responseDocId: responseDocId, message: 'Empty audio data' });
            return;
        }
        if (!responseDocId || !persistentSessionId) {
            console.error(`[${sessionId}] Missing responseDocId or persistentSessionId in finalAudioBlobForStorage.`);
            socket.emit('audioStorageError', { responseDocId: responseDocId, message: 'Missing required IDs' });
            return;
        }

        let tempInputFilePath = null;
        let tempOutputFilePath = null;

        try {
            const buffer = Buffer.from(audioData);
            const timestamp = Date.now();
            const randomId = Math.random().toString(36).substring(2, 7);
            
            // Determine extension based on MIME type, default to .bin if unknown
            let inputExtension = '.bin';
            if (mimeType) {
                if (mimeType.includes('webm')) inputExtension = '.webm';
                else if (mimeType.includes('mp4')) inputExtension = '.mp4'; // Common on iOS
                else if (mimeType.includes('mpeg')) inputExtension = '.mp3';
                else if (mimeType.includes('ogg')) inputExtension = '.ogg';
                else if (mimeType.includes('wav')) inputExtension = '.wav';
            }
            
            tempInputFilePath = path.join(os.tmpdir(), `temp_full_audio_${timestamp}_${randomId}${inputExtension}`);
            tempOutputFilePath = path.join(os.tmpdir(), `converted_full_audio_${timestamp}_${randomId}.mp3`);

            console.log(`[${sessionId}] Saving received blob to temporary input file: ${tempInputFilePath}`);
            await fs.promises.writeFile(tempInputFilePath, buffer);

            if (!fs.existsSync(tempInputFilePath) || fs.statSync(tempInputFilePath).size === 0) {
                throw new Error('Temporary input audio file is empty or not created.');
            }

            console.log(`[${sessionId}] Converting audio to MP3: ${tempInputFilePath} -> ${tempOutputFilePath}`);
            await new Promise((resolve, reject) => {
                ffmpeg(tempInputFilePath)
                    .toFormat('mp3')
                    .audioCodec('libmp3lame') // Standard MP3 codec
                    .audioBitrate('128k')   // Good quality for voice
                    .on('error', (err) => {
                        console.error(`[${sessionId}] FFmpeg conversion error for ${tempInputFilePath}:`, err.message);
                        reject(new Error(`FFmpeg conversion failed: ${err.message}`));
                    })
                    .on('end', () => {
                        console.log(`[${sessionId}] Successfully converted ${tempInputFilePath} to MP3: ${tempOutputFilePath}`);
                        resolve();
                    })
                    .save(tempOutputFilePath);
            });

            if (!fs.existsSync(tempOutputFilePath) || fs.statSync(tempOutputFilePath).size === 0) {
                throw new Error('Converted MP3 audio file is empty or not created.');
            }

            // Upload to GCS
            if (storage && GCS_BUCKET_NAME) {
                const bucket = storage.bucket(GCS_BUCKET_NAME);
                // Path: audio_answers_full/{reportId}/{responseId}.mp3
                const gcsFileName = `audio_answers_full/${persistentSessionId}/${responseDocId}.mp3`;
                
                console.log(`[${sessionId}] Uploading converted MP3 to GCS: gs://${GCS_BUCKET_NAME}/${gcsFileName}`);
                await bucket.upload(tempOutputFilePath, {
                    destination: gcsFileName,
                    metadata: { contentType: 'audio/mpeg' }
                });
                const gcsAudioUrl = `gs://${GCS_BUCKET_NAME}/${gcsFileName}`;
                console.log(`[${sessionId}] Full answer audio uploaded to GCS: ${gcsAudioUrl}`);

                // Update Firestore document
                if (db) {
                    const responseDocRef = db.collection('reports').doc(persistentSessionId)
                                           .collection('responses').doc(responseDocId);
                    await responseDocRef.update({ audio_gcs_url: gcsAudioUrl });
                    console.log(`[${sessionId}] Firestore response document ${responseDocId} updated with audio_gcs_url: ${gcsAudioUrl}`);
                    
                    // Emit success event
                    socket.emit('audioStorageSuccess', { 
                        responseDocId,
                        audioUrl: gcsAudioUrl
                    });
                    console.log(`[${sessionId}] Emitted audioStorageSuccess event`);
                } else {
                    console.warn(`[${sessionId}] Firebase DB not available. Cannot update response document ${responseDocId} with GCS URL.`);
                }
            } else {
                console.warn(`[${sessionId}] GCS storage or bucket name not configured. Cannot upload full audio.`);
            }

        } catch (error) {
            console.error(`[${sessionId}] Error processing finalAudioBlobForStorage for responseDocId ${responseDocId}:`, error);
            // Optionally emit an error back to client
            socket.emit('audioStorageError', { responseDocId: responseDocId, message: error.message });
        } finally {
            // Cleanup temporary files
            if (tempInputFilePath) {
                try { await fs.promises.unlink(tempInputFilePath); } catch (e) { console.warn(`[${sessionId}] Error deleting temp input file ${tempInputFilePath}:`, e.message); }
            }
            if (tempOutputFilePath) {
                try { await fs.promises.unlink(tempOutputFilePath); } catch (e) { console.warn(`[${sessionId}] Error deleting temp output file ${tempOutputFilePath}:`, e.message); }
            }
        }
    });
    
    // Handler for audio+video upload - now async via queue
    socket.on('finalAudioVideoForStorage', async ({ audioData, videoData, responseDocId, persistentSessionId, audioMimeType, videoMimeType }) => {
        console.log(`[${sessionId}] Received finalAudioVideoForStorage for responseDocId: ${responseDocId}, reportId: ${persistentSessionId}`);
        console.log(`[${sessionId}] Audio size: ${audioData.byteLength}, Video size: ${videoData.byteLength}`);
        
        const sessionInfo = sessionData.get(sessionId);
        if (!sessionInfo) {
            console.error(`[${sessionId}] Session info not found for finalAudioVideoForStorage. Aborting.`);
            socket.emit('audioVideoStorageError', { 
                responseDocId, 
                message: 'Session info not found. Please try refreshing the page.' 
            });
            return;
        }
        
        if (!audioData || audioData.byteLength === 0) {
            console.error(`[${sessionId}] Empty audio data received in finalAudioVideoForStorage.`);
            socket.emit('audioVideoStorageError', { 
                responseDocId, 
                message: 'No audio data received. Please ensure microphone permissions are granted.' 
            });
            return;
        }
        
        if (!videoData || videoData.byteLength === 0) {
            console.error(`[${sessionId}] Empty video data received in finalAudioVideoForStorage.`);
            socket.emit('audioVideoStorageError', { 
                responseDocId, 
                message: 'No video data received. Please ensure camera permissions are granted.' 
            });
            return;
        }
        
        if (!responseDocId || !persistentSessionId) {
            console.error(`[${sessionId}] Missing responseDocId or persistentSessionId.`);
            socket.emit('audioVideoStorageError', { 
                responseDocId, 
                message: 'Missing required identifiers. Please try again.' 
            });
            return;
        }
        
        // Add to processing queue
        try {
            // Convert ArrayBuffer to Buffer for queue processing
            const audioBuffer = Buffer.from(audioData);
            const videoBuffer = Buffer.from(videoData);
            
            // Add task to queue
            mediaQueue.push({
                audioBuffer,
                videoBuffer,
                audioMimeType,
                responseDocId,
                reportId: persistentSessionId,
                socketId: socket.id
            });
            
            console.log(`[${sessionId}] Media processing task queued for ${responseDocId}`);
            
            // Immediately acknowledge receipt - processing will happen async
            socket.emit('audioVideoStorageQueued', { 
                responseDocId,
                message: 'Media files queued for processing'
            });
            
        } catch (error) {
            console.error(`[${sessionId}] Error queuing media for processing:`, error);
            socket.emit('audioVideoStorageError', { 
                responseDocId, 
                message: 'Failed to queue media for processing' 
            });
        }
    });
});

// API endpoint to proxy requests to Claude
app.post('/api/claude', requireAuth, async (req, res) => {
    try {
        const { system, messages, model, tools, tool_choice, tool_results, thinking, streamClient, enableCaching } = req.body; // DESTRUCTURE 'thinking', 'streamClient', AND 'enableCaching'
        const userId = req.user.uid;
        
        // Validate userId exists
        if (!userId) {
            console.error('[/api/claude] Missing user ID in request:', {
                user: req.user,
                sessionUserId: req.session?.userId,
                sessionEmail: req.session?.email
            });
            return res.status(401).json({ error: 'User ID not found. Please log in again.' });
        }

        // Validate messages
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'Messages are required' });
        }

        // Check if user has reached the free tier message limit for analyst/copilot
        const FREE_TIER_ANALYST_LIMIT = 10; // 10 messages for free tier users
        
        // Get user subscription data
        const userData = await pricingService.getUserSubscription(userId);
        const subscription = userData.subscription || {};
        
        // Only apply limit to free tier users
        if (subscription.plan === 'free') {
            // Get or initialize analyst message count
            const userRef = db.collection('users').doc(userId);
            const userDoc = await userRef.get();
            const currentCount = userDoc.data()?.analystMessageCount || 0;
            
            if (currentCount >= FREE_TIER_ANALYST_LIMIT) {
                // Return error indicating user has reached the limit
                return res.status(403).json({ 
                    error: 'Free tier message limit reached',
                    code: 'ANALYST_LIMIT_REACHED',
                    limit: FREE_TIER_ANALYST_LIMIT,
                    currentCount: currentCount,
                    message: 'You\'ve reached the free tier limit of 10 analyst/copilot messages. Please upgrade to a paid plan to continue using this feature.'
                });
            }
            
            // Increment the message count
            await userRef.update({
                analystMessageCount: admin.firestore.FieldValue.increment(1)
            });
        }
        
        // Log request details
        console.log("\n==== PROMPT SENT TO ANTHROPIC (api/claude) ====");
        console.log(JSON.stringify({ 
            model: model || "claude-sonnet-4-6",
            system: system,
            messages: messages,
            tools: tools,
            tool_choice: tool_choice,
            tool_results: tool_results,
            thinking: thinking,
            streamClient: streamClient,
            enableCaching: enableCaching
        }, null, 2));
        console.log("==============================================\n");
        
        // Process messages to add cache_control if enableCaching is true
        let processedMessages = messages;
        if (enableCaching && messages && messages.length > 0) {
            processedMessages = messages.map((message, index) => {
                // For the first user message, add cache_control to system content
                if (index === 0 && message.role === 'user' && system) {
                    return {
                        ...message,
                        content: [
                            {
                                type: "text",
                                text: system,
                                cache_control: {"type": "ephemeral"}
                            },
                            ...(Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }])
                        ]
                    };
                }
                return message;
            });
        }
        
        const requestBody = {
            model: model || "claude-sonnet-4-6",
            max_tokens: 15000,
            messages: processedMessages
        };
        
        // Only add system if not using caching (since it's embedded in messages when caching)
        if (!enableCaching && system) {
            requestBody.system = system;
        }
        
        if (tools && tools.length > 0) {
            requestBody.tools = tools;
        }

        if (thinking) {
            requestBody.thinking = thinking;
        }
        
        if (tool_choice) {
            requestBody.tool_choice = tool_choice;
        }

        const headers = {
            "Content-Type": "application/json",
            "x-api-key": CLAUDE_API_KEY,
            "anthropic-version": "2023-06-01"
        };
        
        if (tools && tools.length > 0) {
            headers["anthropic-beta"] = "token-efficient-tools-2025-02-19";
        }

        if (streamClient) {
            requestBody.stream = true;
            
            // Add timeout handling for production environments
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 300000); // 5 minute timeout
            
            try {
                const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: headers,
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });
                
                clearTimeout(timeout);

            if (!anthropicResponse.ok) {
                const errorData = await anthropicResponse.text();
                console.error("\n==== CLAUDE API ERROR (Streaming) ====");
                console.error("Status:", anthropicResponse.status);
                console.error("Response:", errorData);
                console.error("===================================\n");
                if (!res.headersSent) {
                    res.writeHead(anthropicResponse.status, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ type: "error", message: errorData })}\n\n`);
                    res.end();
                } else {
                    res.write(`data: ${JSON.stringify({ type: "error", message: errorData })}\n\n`);
                    res.end();
                }
                return;
            }

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();
            
            // Set up keepalive interval to prevent connection timeouts
            const keepaliveInterval = setInterval(() => {
                if (!res.writableEnded) {
                    res.write(': keepalive\n\n');
                }
            }, 30000); // Send keepalive every 30 seconds
            
            // Handle client disconnect
            res.on('close', () => {
                clearInterval(keepaliveInterval);
                controller.abort();
                // Remove the error handler to prevent memory leak
                if (anthropicResponse && anthropicResponse.body) {
                    anthropicResponse.body.removeListener('error', streamErrorHandler);
                }
                console.log('[Server Stream] Client disconnected, cleaning up');
            });

            // Add error handler directly to the response body stream
            const streamErrorHandler = (err) => {
                console.error('[Server Stream] Error event directly on Anthropic response body:', err);
                // This provides an earlier logging point. The main try-catch of the route
                // will also likely catch this if it causes the for-await loop to throw.
                // Avoid sending a response from here if it's already handled or will be handled.
                if (!res.writableEnded) {
                    // If the stream to the client is still open, try to inform it.
                    // This might be redundant if the main catch block also handles it.
                    // res.write(`data: ${JSON.stringify({ type: "error", message: "Anthropic stream error: " + err.message })}\n\n`);
                    // res.end();
                }
            };
            anthropicResponse.body.on('error', streamErrorHandler);

            let serverBuffer = ''; // Renamed to avoid confusion with client-side buffer
            let currentBlockType = null;
            // const reader = anthropicResponse.body.getReader(); // REMOVE
            // const decoder = new TextDecoder(); // REMOVE

            for await (const chunk of anthropicResponse.body) {
                const decodedChunk = (typeof chunk === 'string') ? chunk : Buffer.from(chunk).toString('utf-8');
                serverBuffer += decodedChunk;

                let boundary = serverBuffer.indexOf('\n\n');
                while (boundary !== -1) {
                    const message = serverBuffer.substring(0, boundary);
                    serverBuffer = serverBuffer.substring(boundary + 2);

                    const lines = message.split('\n');
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const jsonData = JSON.parse(line.substring(6));
                                // console.log("[Server Stream Parsed JSON]:", jsonData); // Verbose log

                                if (jsonData.type === 'content_block_start') {
                                    currentBlockType = jsonData.content_block.type;
                                } else if (jsonData.type === 'content_block_delta') {
                                    if (jsonData.delta.type === 'text_delta' && currentBlockType === 'text') {
                                        res.write(`data: ${JSON.stringify({ type: "content_delta", text: jsonData.delta.text })}\n\n`);
                                    } else if (jsonData.delta.type === 'thinking_delta' && currentBlockType === 'thinking') {
                                        res.write(`data: ${JSON.stringify({ type: "thinking_delta", thinking: jsonData.delta.thinking })}\n\n`);
                                    }
                                } else if (jsonData.type === 'content_block_stop') {
                                    currentBlockType = null;
                                } else if (jsonData.type === 'message_stop') {
                                    res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
                                    console.log("[Server Stream] Forwarded message_stop to client.");
                                } else if (jsonData.type === 'error' && jsonData.error) {
                                    console.error("[Server Stream] Anthropic API Error in stream event:", jsonData.error);
                                    res.write(`data: ${JSON.stringify({ type: "error", message: jsonData.error.message || 'Unknown error in stream' })}\n\n`);
                                }
                            } catch (e) {
                                console.error("[Server Stream] Error parsing JSON from buffered Anthropic message:", e, "Message part:", line.substring(6));
                            }
                        }
                    }
                    boundary = serverBuffer.indexOf('\n\n');
                }
            }
            // Process any remaining data in the buffer after the loop finishes
            if (serverBuffer.trim().startsWith('data:')) {
                const lines = serverBuffer.split('\n');
                 for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const jsonData = JSON.parse(line.substring(6));
                                if (jsonData.type === 'message_stop') { // Check for final message_stop
                                    res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
                                    console.log("[Server Stream] Forwarded residual message_stop to client.");
                                } else if (jsonData.type === 'error' && jsonData.error) {
                                     console.error("[Server Stream] Anthropic API Error in residual stream event:", jsonData.error);
                                    res.write(`data: ${JSON.stringify({ type: "error", message: jsonData.error.message || 'Unknown error in stream' })}\n\n`);
                                }
                                // Potentially handle other residual types if necessary
                            } catch (e) {
                                console.warn("[Server Stream] Error parsing residual JSON from Anthropic message:", e, "Message part:", line.substring(6));
                            }
                        }
                    }
            }

            clearInterval(keepaliveInterval);
            // Remove the error handler to prevent memory leak
            anthropicResponse.body.removeListener('error', streamErrorHandler);
            res.end();
            console.log("[Server Stream] SSE Stream to client ended.");
            
            } catch (error) {
                clearTimeout(timeout);
                clearInterval(keepaliveInterval);
                // Remove the error handler to prevent memory leak
                if (anthropicResponse && anthropicResponse.body) {
                    anthropicResponse.body.removeListener('error', streamErrorHandler);
                }
                
                console.error("[Server Stream] Error in streaming:", error);
                if (!res.writableEnded) {
                    if (error.name === 'AbortError') {
                        res.write(`data: ${JSON.stringify({ type: "error", message: "Request timeout - the operation took too long" })}\n\n`);
                    } else {
                        res.write(`data: ${JSON.stringify({ type: "error", message: error.message })}\n\n`);
                    }
                    res.end();
                }
            }
            return;
        }

        // Non-streaming logic
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: headers,
            body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
            const errorData = await response.text();
            console.error("\n==== CLAUDE API ERROR ====");
            console.error("Status:", response.status);
            console.error("Response:", errorData);
            console.error("==========================\n");
            return res.status(response.status).json({ 
                error: "API Error", 
                status: response.status,
                details: errorData 
            });
        }
        
        const data = await response.json();
        const responseObj = {};
        const textBlocks = [];
        const toolUses = [];

        // Extract thinking block as-is from Claude (never modify signatures!)
        // Per Claude docs: thinking blocks must be passed back unmodified
        const thinkingBlock = data.content.find(block => block.type === "thinking");

        const toolUseBlocks = data.content.filter(block => block.type === "tool_use");

        // Pass all content blocks as-is from Claude without modification
        responseObj.contentBlocks = data.content.map(block => {
            return block;
        });

        data.content.forEach(block => {
            if (block.type === "text") {
                textBlocks.push(block.text);
            } else if (block.type === "tool_use") {
                toolUses.push({
                    id: block.id,
                    name: block.name,
                    args: JSON.stringify(block.input)
                });
            }
        });

        responseObj.response = textBlocks.join("");

        if (toolUses.length > 0) {
            responseObj.tool_calls = toolUses;
        }
        
        if (thinkingBlock) {
            responseObj.thinking = thinkingBlock;
        }
        
        if (toolUseBlocks.length > 0) {
            responseObj.toolUseBlocks = toolUseBlocks;
        }

        console.log("\n==== CLAUDE API RESPONSE (partial) ====");
        const responsePreview = responseObj.response.substring(0, 200) + (responseObj.response.length > 200 ? "..." : "");
        console.log("Response preview:", responsePreview);
        console.log("=======================================\n");

        res.json(responseObj);
    } catch (error) {
        console.error("\n==== SERVER ERROR ====");
        console.error(error);
        console.error("======================\n");
        // Ensure headers are not sent again if streaming failed earlier and already sent an error response
        if (!res.headersSent) {
            res.status(500).json({ error: "Server Error", message: error.message });
        }
    }
});

// Get user's analyst/copilot message usage
app.get('/api/usage/analyst-messages', requireAuth, async (req, res) => {
    try {
        const userId = req.user.uid;
        const FREE_TIER_ANALYST_LIMIT = 10;
        
        // Get user subscription and message count
        const userData = await pricingService.getUserSubscription(userId);
        const subscription = userData.subscription || {};
        
        if (subscription.plan === 'free') {
            const userDoc = await db.collection('users').doc(userId).get();
            const currentCount = userDoc.data()?.analystMessageCount || 0;
            
            res.json({
                plan: 'free',
                limit: FREE_TIER_ANALYST_LIMIT,
                used: currentCount,
                remaining: Math.max(0, FREE_TIER_ANALYST_LIMIT - currentCount)
            });
        } else {
            // Paid plans have unlimited messages
            res.json({
                plan: subscription.plan,
                limit: null,
                used: null,
                remaining: null,
                unlimited: true
            });
        }
    } catch (error) {
        console.error('Error getting analyst message usage:', error);
        res.status(500).json({ error: 'Failed to get message usage' });
    }
});

// Streaming TTS endpoint with chunk encoding (SSE)
app.get('/api/tts/stream', (req, res) => {
    if (!streamingTTS) {
        return res.status(503).json({ error: 'Streaming TTS service not initialized' });
    }
    streamingTTS.handleStreamRequest(req, res);
});

// Chunked text streaming endpoint for real-time TTS
app.post('/api/tts/stream-chunked', (req, res) => {
    if (!streamingTTS) {
        return res.status(503).json({ error: 'Streaming TTS service not initialized' });
    }
    streamingTTS.handleChunkedStreamRequest(req, res);
});

// Debug endpoint
app.get('/api/test', (req, res) => {
    // console.log("Test endpoint accessed");
    res.json({ message: "API endpoint is working" });
});

// Debug endpoint to check server connectivity
app.get('/status', (req, res) => {
    // console.log("Status endpoint accessed");
    res.json({ status: 'Server is running' });
});

app.post('/api/notify-new-account', async (req, res) => {
    try {
        const { email, uid } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'email is required' });
        }
        
        // Use EmailService which handles both SendGrid and Gmail
        await EmailService.send({
            to: 'contact@example.com',
            subject: 'New account created',
            text: `Email: ${email}\nUID: ${uid || ''}`,
            html: `<p><strong>Email:</strong> ${email}<br><strong>UID:</strong> ${uid || ''}</p>`,
            user: null // Admin notification, no specific user context
        });
        
        res.json({ success: true });
    } catch (err) {
        console.error('New account notification error:', err);
        res.status(500).json({ error: 'Failed to send notification' });
    }
});

// File upload endpoint for resume parsing
app.post('/api/upload-resume', 
  rateLimiters.fileUpload, 
  upload.single('resume'), 
  validators.validateFileUpload,
  async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        console.log(`File uploaded: ${req.file.originalname} (${req.file.mimetype})`);
        
        // Extract text based on file type
        let extractedText = '';
        
        if (req.file.mimetype === 'application/pdf') {
            try {
                // Use pdf-parse to extract text from PDF
                const pdfData = await pdfParse(req.file.buffer);
                extractedText = pdfData.text;
                console.log(`Extracted ${extractedText.length} characters from PDF`);
            } catch (pdfError) {
                console.error('PDF parsing error:', pdfError);
                return res.status(500).json({ 
                    error: 'Failed to parse PDF', 
                    details: pdfError.message 
                });
            }
        } 
        else if (req.file.mimetype.includes('word')) {
            try {
                // Use mammoth to extract text from DOCX/DOC
                const result = await mammoth.extractRawText({
                    buffer: req.file.buffer
                });
                extractedText = result.value;
                console.log(`Extracted ${extractedText.length} characters from Word document`);
            } catch (docError) {
                console.error('Word document parsing error:', docError);
                return res.status(500).json({ 
                    error: 'Failed to parse Word document', 
                    details: docError.message 
                });
            }
        }
        
        // Clean up the extracted text
        extractedText = extractedText
            .replace(/\r\n/g, '\n') // Normalize line breaks
            .replace(/\n{3,}/g, '\n\n') // Remove excessive line breaks
            .trim();
            
        if (!extractedText || extractedText.length < 50) {
            return res.status(400).json({ 
                error: 'Could not extract sufficient text from the document',
                extracted: extractedText
            });
        }
        
        // Return the extracted text
        res.json({ 
            success: true, 
            text: extractedText,
            chars: extractedText.length
        });
    } catch (error) {
        console.error('Error processing file:', error);
        res.status(500).json({ error: 'Failed to process file', details: error.message });
    }
});

// Add a session cleanup mechanism to prevent memory leaks
// Run cleanup every hour
const CLEANUP_INTERVAL = 3600000; // 1 hour
const SESSION_TIMEOUT = 86400000; // 24 hours

setInterval(() => {
    console.log('Running session cleanup...');
    const now = Date.now();
    let cleanupCount = 0;
    
    sessionData.forEach((session, id) => {
        // Check if session has been inactive for more than the timeout period
        if (session.lastActive && (now - session.lastActive > SESSION_TIMEOUT)) {
            console.log(`Cleaning up inactive session: ${id}, last active: ${new Date(session.lastActive).toISOString()}`);
            sessionData.delete(id);
            cleanupCount++;
        }
    });
    
    console.log(`Cleanup complete. Removed ${cleanupCount} inactive sessions. Active sessions: ${sessionData.size}`);
}, CLEANUP_INTERVAL);

// API endpoint to get all interviews
app.get('/api/interviews', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Firebase service unavailable' });
  }

  try {
    const snapshot = await db.collection('interviews').get();
    const interviews = [];
    
    snapshot.forEach(doc => {
      interviews.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    res.json(interviews);
  } catch (error) {
    console.error('Error fetching interviews:', error);
    res.status(500).json({ error: 'Failed to fetch interviews', details: error.message });
  }
});

// API endpoint to get interview data by ID (with 's' for consistency)
app.get('/api/interviews/:id', async (req, res) => {
  req.params.id = req.params.id; // Pass through
  req.url = `/api/interview/${req.params.id}`; // Redirect to existing endpoint
  app.handle(req, res);
});

// API endpoint to get interview data by ID
app.get('/api/interview/:id', async (req, res) => {
  try {
    const interviewId = req.params.id;
    
    console.log(`\n======= API INTERVIEW DEBUG =======`);
    console.log(`API Endpoint: /api/interview/:id`);
    console.log(`Request received for ID: "${interviewId}"`);
    console.log(`Request IP: ${req.ip}`);
    console.log(`Request headers:`, JSON.stringify({
      'user-agent': req.headers['user-agent'],
      'accept': req.headers['accept'],
      'referer': req.headers['referer'] || 'none'
    }, null, 2));
    
    // Validate the interview ID
    if (!interviewId || interviewId.trim() === '') {
      console.log('API DEBUG - Invalid interview ID (empty or whitespace only)');
      console.log(`======= END API DEBUG =======\n`);
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    
    // Check if Firebase is available
    if (!db) {
      console.log('API - Firebase service unavailable');
      return res.status(503).json({ error: 'Firebase service unavailable' });
    }
    
    // Query Firestore for the interview data
    console.log(`API - Querying Firestore for interview: ${interviewId}`);
    const interviewDoc = await db.collection('interviews').doc(interviewId).get();
    
    if (!interviewDoc.exists) {
      console.log(`API - Interview not found for ID: ${interviewId}`);
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    // Get the interview data
    const interviewData = interviewDoc.data();
    console.log(`API - Found interview: ${interviewData.title}, prompt length: ${interviewData.initialPrompt?.length || 0} chars, WebSearch: ${interviewData.enableWebSearch}`);
    
    // Fetch creator information if available
    let creatorInfo = null;
    if (interviewData.createdBy) {
      try {
        const userDoc = await db.collection('users').doc(interviewData.createdBy).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          creatorInfo = {
            displayName: userData.displayName || userData.email,
            organization: userData.organization
          };
        }
      } catch (error) {
        console.error('Error fetching creator information:', error);
      }
    }
    
    // Return the interview data
    res.json({
      id: interviewId,  // Use the ID from the URL parameter, not from the document
      title: interviewData.title,
      description: interviewData.description,
      initialPrompt: interviewData.initialPrompt,
      followupPrompt: interviewData.followupPrompt,
      reportPrompt: interviewData.reportPrompt,
      indexHeader: interviewData.indexHeader,
      indexSubheader: interviewData.indexSubheader,
      introHeadline: interviewData.introHeadline, // Added introHeadline
      reportHeader: interviewData.reportHeader,
      reportSubheader: interviewData.reportSubheader,
      hasExternalDocuments: interviewData.hasExternalDocuments !== undefined ? interviewData.hasExternalDocuments : true, // Add the flag, default to true
      enableWebSearch: interviewData.enableWebSearch !== undefined ? interviewData.enableWebSearch : true, // ADDED: Send web search flag, default true
      enableThinking: interviewData.enableThinking !== undefined ? interviewData.enableThinking : true, // ADDED: Send thinking flag, default true
      enableMemoryService: interviewData.enableMemoryService !== undefined ? interviewData.enableMemoryService : true, // ADDED: Send memory service flag, default true
      followupModel: interviewData.followupModel || 'claude-sonnet-4-6', // ADDED: Send model setting
      enableVideoRecording: interviewData.enableVideoRecording !== undefined ? interviewData.enableVideoRecording : false, // ADDED: Send video recording flag, default false
      sharedWith: interviewData.sharedWith || [], // ADDED: Send sharing information
      creatorInfo: creatorInfo // ADDED: Send creator information
    });
  } catch (error) {
    console.error('Error retrieving interview data:', error);
    res.status(500).json({ error: 'Failed to retrieve interview data', details: error.message });
  }
});

// API endpoint for interview sharing
app.post('/api/interviews/:id/share', async (req, res) => {
  try {
    const interviewId = req.params.id;
    const { sharedWith } = req.body;
    
    console.log(`[API Share] Request to update sharing for interview ${interviewId}`);
    console.log(`[API Share] New sharedWith list:`, sharedWith);
    
    // Validate input
    if (!Array.isArray(sharedWith)) {
      return res.status(400).json({ error: 'sharedWith must be an array' });
    }
    
    // Validate email format for each email in the array
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of sharedWith) {
      if (typeof email !== 'string' || !emailRegex.test(email)) {
        return res.status(400).json({ error: `Invalid email format: ${email}` });
      }
    }
    
    // Check if Firebase is available
    if (!db) {
      return res.status(503).json({ error: 'Firebase service unavailable' });
    }
    
    // Check if interview exists
    const interviewDoc = await db.collection('interviews').doc(interviewId).get();
    if (!interviewDoc.exists) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    // Get interview data and current shared list
    const interviewData = interviewDoc.data();
    const currentSharedWith = interviewData.sharedWith || [];
    const interviewTitle = interviewData.title || 'Untitled Interview';
    const interviewDescription = interviewData.description || '';
    
    // Find newly added emails (those in sharedWith but not in currentSharedWith)
    const newlySharedEmails = sharedWith.filter(email => !currentSharedWith.includes(email));
    
    // Get the email and userId of the user making the share (from auth header if available)
    let sharedByEmail = 'A colleague'; // Default if we can't determine the sharer
    let sharedByUserId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        sharedByUserId = decodedToken.uid;
        const sharerUser = await admin.auth().getUser(decodedToken.uid);
        sharedByEmail = sharerUser.email || 'A colleague';
        console.log(`[API Share] Interview shared by: ${sharedByEmail} (${sharedByUserId})`);
      } catch (error) {
        console.error('[API Share] Error getting sharer email:', error);
      }
    }
    
    // Update the interview document
    await db.collection('interviews').doc(interviewId).update({
      sharedWith: sharedWith,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`[API Share] Successfully updated sharing for interview ${interviewId}`);
    console.log(`[API Share] Newly shared with: ${newlySharedEmails.join(', ')}`);
    
    // Send notification emails to newly added users
    if (newlySharedEmails.length > 0) {
      console.log(`[API Share] Sending notification emails to ${newlySharedEmails.length} new recipients`);
      
      // Send emails asynchronously (don't block the response)
      Promise.all(newlySharedEmails.map(email => 
        sendSharingNotificationEmail(
          email,
          sharedByEmail,
          interviewTitle,
          interviewDescription,
          interviewId,
          sharedByUserId
        ).catch(error => {
          console.error(`[API Share] Failed to send notification to ${email}:`, error);
        })
      )).then(() => {
        console.log(`[API Share] Completed sending all notification emails`);
      });
    }
    
    res.json({ 
      message: 'Sharing updated successfully',
      interviewId: interviewId,
      sharedWith: sharedWith,
      notificationsSent: newlySharedEmails.length
    });
    
  } catch (error) {
    console.error('[API Share] Error updating interview sharing:', error);
    res.status(500).json({ error: 'Failed to update sharing', details: error.message });
  }
});

// Configure server timeouts for production environments
server.keepAliveTimeout = 65000; // 65 seconds (should be higher than proxy timeout)
server.headersTimeout = 66000; // 66 seconds (slightly higher than keepAliveTimeout)
server.timeout = 300000; // 5 minutes for long-running requests

// Only bind when run directly — not when required by tests or Vercel serverless
if (require.main === module) {
  try {
    server.listen(PORT, () => {
      console.log('=== SERVER STARTED SUCCESSFULLY ===');
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Static files being served from: ${path.join(__dirname, 'public')}`);
      console.log(`Ready to handle Claude API requests`);
      console.log(`Ready to handle voice interviews`);
      console.log('');
      console.log('Service Status Summary:');
      console.log(`- Firebase: ${db ? '✓ Connected' : '✗ Not connected'}`);
      console.log(`- Google Cloud Storage: ${storage ? '✓ Connected' : '✗ Not connected'}`);
      console.log(`- Email Service: ${SENDGRID_API_KEY || process.env.GMAIL_CLIENT_ID ? '✓ Available' : '✗ Not configured'}`);
      console.log(`- Stripe: ${stripe ? '✓ Connected' : '✗ Not connected'}`);

      // Start campaign email sender if Firebase is available
      if (db) {
        const campaignSender = require('./server/utils/campaign-sender');
        campaignSender.start();
        console.log(`- Campaign Sender: ✓ Started`);
      } else {
        console.log(`- Campaign Sender: ✗ Not started (requires Firebase)`);
      }

      console.log('');
      console.log('Visit /health for detailed status information');
      console.log('=================================');
    });
  } catch (error) {
    console.error('CRITICAL ERROR starting server:', error);
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Export the Express app for Vercel
module.exports = app; 

// Add after the interview API endpoint around line ~1891
// API endpoint to get responses for a specific interview ID or session ID
app.get('/api/responses', async (req, res) => {
  try {
    const { interview_id, session_id, limit = 100 } = req.query;
    
    // Require at least one filter parameter
    if (!interview_id && !session_id) {
      return res.status(400).json({ 
        error: 'Missing required parameter. Either interview_id or session_id must be provided.' 
      });
    }
    
    // Check if Firebase is available
    if (!db) {
      return res.status(503).json({ error: 'Firebase service unavailable' });
    }
    
    // Start building the query
    let query = db.collection('responses');
    
    // Apply filters
    if (interview_id) {
      query = query.where('interview_id', '==', interview_id);
    }
    
    if (session_id) {
      query = query.where('session_id', '==', session_id);
    }
    
    // Order by timestamp and apply limit
    query = query.orderBy('timestamp', 'asc').limit(parseInt(limit, 10));
    
    // Execute the query
    const snapshot = await query.get();
    
    // Convert to array of response objects
    const responses = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      responses.push({
        id: doc.id,
        session_id: data.session_id,
        interview_id: data.interview_id,
        question: data.question,
        answer: data.answer,
        timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : null,
        // Don't include full thinking trace in the response list to reduce payload size
        has_thinking_trace: !!data.thinking_trace,
        has_full_prompt: !!data.full_prompt, // Indicate if full prompt is available
        audio_gcs_url: data.audio_gcs_url || null, // <<< ADDED
        word_timestamps: data.word_timestamps ? data.word_timestamps.length : 0 // Indicate if timestamps exist & how many
      });
    });
    
    res.json({
      count: responses.length,
      responses: responses
    });
    
  } catch (error) {
    console.error('Error retrieving responses:', error);
    res.status(500).json({ error: 'Failed to retrieve responses', details: error.message });
  }
});

// API endpoint to get a specific response by ID (including thinking trace)
app.get('/api/responses/:id', async (req, res) => {
  try {
    const responseId = req.params.id;
    
    // Check if Firebase is available
    if (!db) {
      return res.status(503).json({ error: 'Firebase service unavailable' });
    }
    
    // Get the response document
    const doc = await db.collection('responses').doc(responseId).get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Response not found' });
    }
    
    // Get the response data
    const data = doc.data();
    
    // Return the response data
    res.json({
      id: doc.id,
      session_id: data.session_id,
      interview_id: data.interview_id,
      question: data.question,
      answer: data.answer,
      timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : null,
      thinking_trace: data.thinking_trace,
      full_prompt: data.full_prompt,
      word_timestamps: data.word_timestamps || null // Include full timestamps for specific response
    });
    
  } catch (error) {
    console.error('Error retrieving response:', error);
    res.status(500).json({ error: 'Failed to retrieve response', details: error.message });
  }
});

// Add after the /api/responses/:id endpoint, around line ~1988

// API endpoint to get reports for a specific interview ID or session ID
app.get('/api/reports', async (req, res) => {
  try {
    const { interview_id, session_id, limit = 10 } = req.query; // Default limit to 10 for reports
    
    // Require at least one filter parameter
    if (!interview_id && !session_id) {
      return res.status(400).json({ 
        error: 'Missing required parameter. Either interview_id or session_id must be provided.' 
      });
    }
    
    if (!db) {
      return res.status(503).json({ error: 'Firebase service unavailable' });
    }
    
    let query = db.collection('reports');
    
    if (interview_id) {
      query = query.where('interview_id', '==', interview_id);
    }
    
    if (session_id) {
      query = query.where('session_id', '==', session_id);
    }
    
    query = query.orderBy('timestamp', 'desc').limit(parseInt(limit, 10)); // Order by desc for recent reports
    
    const snapshot = await query.get();
    const reports = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      reports.push({
        id: doc.id,
        session_id: data.session_id,
        interview_id: data.interview_id,
        report_title: data.report_title,
        report_subtitle: data.report_subtitle,
        timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : null,
        // Exclude full report_content from list view for brevity
        has_report_content: !!data.report_content 
      });
    });
    
    res.json({
      count: reports.length,
      reports: reports
    });
    
  } catch (error) {
    console.error('Error retrieving reports:', error);
    res.status(500).json({ error: 'Failed to retrieve reports', details: error.message });
  }
});

// API endpoint to get a specific report by ID (including full content)
app.get('/api/reports/:id', 
  param('id').isString().trim().notEmpty().isLength({ min: 20, max: 50 }).matches(/^[a-zA-Z0-9-_]+$/),
  validators.sessionId,
  handleValidationErrors,
  async (req, res) => {
  try {
    const reportId = req.params.id;
    const { session_id } = req.query; // Allow session-based access
    
    // Verify Firebase auth token if provided
    let userEmail = null;
    let userUid = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        userEmail = decodedToken.email;
        userUid = decodedToken.uid;
      } catch (error) {
        console.error('Invalid auth token:', error);
      }
    }
    
    // Fall back to session if no token (but NOT query params!)
    if (!userEmail && req.session?.email) {
      userEmail = req.session.email;
    }
    
    if (!db) {
      return res.status(503).json({ error: 'Firebase service unavailable' });
    }
    
    const doc = await db.collection('reports').doc(reportId).get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Report not found' });
    }
    
    const data = doc.data();
    
    // Access control: Check if user has permission to view this report
    // Check if authenticated user is an admin of the interview
    let isAdmin = false;
    if (userEmail && data.interview_id) {
      try {
        // Check if user is admin of the interview
        const interviewDoc = await db.collection('interviews').doc(data.interview_id).get();
        if (interviewDoc.exists) {
          const interviewData = interviewDoc.data();
          // Check if user created the interview or is in sharedWith list
          // Use the verified UID from the token (much more secure)
          isAdmin = (interviewData.createdBy === userUid || 
                    (interviewData.sharedWith && interviewData.sharedWith.includes(userEmail)));
        }
      } catch (error) {
        console.warn('Error checking admin status:', error);
      }
    }
    
    // All reports are publicly accessible via direct link
    // No authentication required for report permalinks
    const hasAccess = true;
    res.json({
      id: doc.id,
      session_id: data.session_id,
      interview_id: data.interview_id,
      report_title: data.report_title,
      report_subtitle: data.report_subtitle,
      report_content: data.report_content,
      admin_report_content: data.admin_report_content || null, // ADDED
      audio_gcs_url: data.audio_gcs_url || null, // Ensure this is sent
      admin_audio_gcs_url: data.admin_audio_gcs_url || null, // ADDED
      timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : null,
      status: data.status || 'started' // Include status to check if report is complete
    });
    
  } catch (error) {
    console.error('Error retrieving report:', error);
    res.status(500).json({ error: 'Failed to retrieve report', details: error.message });
  }
});

// --- NEW: API endpoint to get a specific report ---
app.get('/api/reports/:reportId', async (req, res) => {
  try {
    const { reportId } = req.params;

    if (!db) {
      return res.status(503).json({ error: 'Firebase service unavailable' });
    }

    const reportDoc = await db.collection('reports').doc(reportId).get();
    
    if (!reportDoc.exists) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const reportData = reportDoc.data();
    
    // Return the report data
    res.json({
      id: reportId,
      report_content: reportData.report_content || '',
      report_title: reportData.report_title || 'Report',
      report_subtitle: reportData.report_subtitle || '',
      timestamp: reportData.timestamp ? reportData.timestamp.toDate().toISOString() : null,
      start_timestamp: reportData.start_timestamp ? reportData.start_timestamp.toDate().toISOString() : null,
      user_name: reportData.user_name || null,
      user_email: reportData.user_email || null,
      interview_id: reportData.interview_id || null,
      total_recording_duration: reportData.total_recording_duration || 0,
      status: reportData.status || 'unknown',
      audio_gcs_url: reportData.audio_gcs_url || null,
      admin_report_content: reportData.admin_report_content || null,
      admin_audio_gcs_url: reportData.admin_audio_gcs_url || null,
      user_note: reportData.user_note || null
    });

  } catch (error) {
    console.error('Error fetching report:', error);
    res.status(500).json({ error: 'Failed to fetch report', details: error.message });
  }
});

// --- NEW: API endpoint to get the latest report for an interview ---
app.get('/api/reports/latest', async (req, res) => {
  try {
    const { interview_id } = req.query;

    if (!interview_id) {
      return res.status(400).json({ error: 'interview_id query parameter is required' });
    }

    if (!db) {
      return res.status(503).json({ error: 'Firebase service unavailable' });
    }

    // Query for the most recent report with this interview_id
    const reportsSnapshot = await db.collection('reports')
      .where('interview_id', '==', interview_id)
      .orderBy('start_timestamp', 'desc')
      .limit(1)
      .get();

    if (reportsSnapshot.empty) {
      return res.status(404).json({ error: 'No reports found for this interview' });
    }

    // Get the first (and only) document
    const reportDoc = reportsSnapshot.docs[0];
    const reportData = reportDoc.data();
    const reportId = reportDoc.id;

    // Return the report data with the report ID
    res.json({
      id: reportId,
      report_content: reportData.report_content || '',
      report_title: reportData.report_title || 'Report',
      report_subtitle: reportData.report_subtitle || '',
      timestamp: reportData.timestamp ? reportData.timestamp.toDate().toISOString() : null,
      start_timestamp: reportData.start_timestamp ? reportData.start_timestamp.toDate().toISOString() : null,
      user_name: reportData.user_name || null,
      user_email: reportData.user_email || null,
      interview_id: reportData.interview_id || null,
      total_recording_duration: reportData.total_recording_duration || 0,
      status: reportData.status || 'unknown',
      audio_gcs_url: reportData.audio_gcs_url || null,
      admin_report_content: reportData.admin_report_content || null,
      admin_audio_gcs_url: reportData.admin_audio_gcs_url || null
    });

  } catch (error) {
    console.error('Error fetching latest report for interview:', error);
    res.status(500).json({ error: 'Failed to fetch latest report', details: error.message });
  }
});

// --- NEW: API endpoint to get responses for a specific report --- 
app.get('/api/reports/:reportId/responses', 
  validators.reportId,
  validators.sessionId,
  handleValidationErrors,
  async (req, res) => {
  try {
    const { reportId } = req.params;
    const { session_id } = req.query;
    
    // Verify Firebase auth token if provided
    let userEmail = null;
    let userUid = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        userEmail = decodedToken.email;
        userUid = decodedToken.uid;
      } catch (error) {
        console.error('Invalid auth token:', error);
      }
    }
    
    // Fall back to session if no token (but NOT query params!)
    if (!userEmail && req.session?.email) {
      userEmail = req.session.email;
    }

    if (!db) {
      return res.status(503).json({ error: 'Firebase service unavailable' });
    }
    if (!reportId) {
      return res.status(400).json({ error: 'Missing report ID' });
    }
    if (!storage) { // Check if GCS storage is available
      return res.status(503).json({ error: 'Storage service unavailable' });
    }
    
    // Check access permissions for the parent report
    const reportDoc = await db.collection('reports').doc(reportId).get();
    if (!reportDoc.exists) {
      return res.status(404).json({ error: 'Report not found' });
    }
    
    const reportData = reportDoc.data();
    const isAdminRequest = req.headers.referer && req.headers.referer.includes('/admin.html');
    
    // All report transcripts are publicly accessible via direct link
    // No authentication required for transcript access
    const hasAccess = true;

    // Reference the subcollection
    const responsesQuery = db.collection('reports').doc(reportId).collection('responses').orderBy('timestamp', 'asc');
    const snapshot = await responsesQuery.get();

    const responses = [];
    // Use Promise.all to handle async signed URL generation
    await Promise.all(snapshot.docs.map(async (doc) => {
      const data = doc.data();
      let signedAudioUrl = null;
      let signedVideoUrl = null;

      if (data.audio_gcs_url && storage) {
        try {
          const gcsUri = data.audio_gcs_url;
          // Extract bucket name and file path from gs:// URI
          const match = gcsUri.match(/^gs:\/\/([^\/]+)\/(.+)$/);
          if (match) {
            const bucketName = match[1];
            const filePath = match[2];
            
            // Generate a signed URL (expires in 1 hour)
            const options = {
              version: 'v4',
              action: 'read',
              expires: Date.now() + 60 * 60 * 1000, // 1 hour
            };
            const [url] = await storage.bucket(bucketName).file(filePath).getSignedUrl(options);
            signedAudioUrl = url;
          } else {
             console.warn(`Invalid GCS URI format: ${gcsUri}`);
          }
        } catch (urlError) {
          console.error(`Error generating signed URL for ${data.audio_gcs_url}:`, urlError);
          // Proceed without a signed URL if generation fails
        }
      }
      
      // Generate signed URL for video if exists
      if (data.video_gcs_url && storage) {
        try {
          const gcsUri = data.video_gcs_url;
          // Extract bucket name and file path from gs:// URI
          const match = gcsUri.match(/^gs:\/\/([^\/]+)\/(.+)$/);
          if (match) {
            const bucketName = match[1];
            const filePath = match[2];
            
            // Generate a signed URL (expires in 1 hour)
            const options = {
              version: 'v4',
              action: 'read',
              expires: Date.now() + 60 * 60 * 1000, // 1 hour
            };
            const [url] = await storage.bucket(bucketName).file(filePath).getSignedUrl(options);
            signedVideoUrl = url;
          } else {
             console.warn(`Invalid GCS URI format: ${gcsUri}`);
          }
        } catch (urlError) {
          console.error(`Error generating signed URL for ${data.video_gcs_url}:`, urlError);
          // Proceed without a signed URL if generation fails
        }
      }

      responses.push({
        id: doc.id,
        question: data.question,
        answer: data.answer,
        timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : null,
        // audio_gcs_url: data.audio_gcs_url || null // <<< No longer send gs:// URL
        audio_signed_url: signedAudioUrl, // <<< ADDED: Send the signed URL
        video_signed_url: signedVideoUrl, // <<< ADDED: Send the video signed URL
        word_timestamps: data.word_timestamps || null // <<< ADDED: word_timestamps
        // Exclude thinking trace/full prompt for brevity in this context
      });
    }));

    res.json({ responses });

  } catch (error) {
    console.error('Error fetching responses for report:', error);
    // Check if the error is because the report document itself doesn't exist
    if (error.message.includes('no entity to update') || error.code === 5) { // Firestore error code for NOT_FOUND
         return res.status(404).json({ error: 'Report or associated responses not found.', details: error.message });
    }
    res.status(500).json({ error: 'Failed to fetch responses for report', details: error.message });
  }
});
// --- END NEW ENDPOINT ---

// New API endpoint to get data for the interview special report page
app.get('/api/interview/:interviewId/special-report-details', async (req, res) => {
  try {
    const { interviewId } = req.params;

    if (!db) {
      return res.status(503).json({ error: 'Firebase service unavailable' });
    }

    // Fetch interview details
    const interviewDoc = await db.collection('interviews').doc(interviewId).get();
    if (!interviewDoc.exists) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    const interviewDetails = interviewDoc.data();

    // Fetch associated reports
    const reportsSnapshot = await db.collection('reports')
                                    .where('interview_id', '==', interviewId)
                                    .orderBy('start_timestamp', 'desc') // <<< MODIFIED: Use start_timestamp
                                    .get();
    
    const reportList = [];
    // Use Promise.all to fetch interview titles asynchronously
    await Promise.all(reportsSnapshot.docs.map(async (doc) => {
      const data = doc.data();
      let interviewTemplateTitle = data.report_title || 'Untitled Report'; // Default to report's own title

      if (data.interview_id) {
        try {
          const interviewTemplateDoc = await db.collection('interviews').doc(data.interview_id).get();
          if (interviewTemplateDoc.exists) {
            interviewTemplateTitle = interviewTemplateDoc.data().title || interviewTemplateTitle;
          }
        } catch (e) {
          console.warn(`Could not fetch interview template title for report ${doc.id}:`, e);
        }
      }

      // Check if this report has valid responses
      let hasValidResponses = false;
      try {
        console.log(`[Special Report Details] Checking responses for report ${doc.id}...`);
        const responsesSnapshot = await db.collection('reports')
          .doc(doc.id)
          .collection('responses')
          .get();
        
        console.log(`[Special Report Details] Report ${doc.id} has ${responsesSnapshot.docs.length} responses`);
        
        hasValidResponses = responsesSnapshot.docs.some(responseDoc => {
          const response = responseDoc.data();
          const answer = response.answer;
          
          console.log(`[Special Report Details] Report ${doc.id} checking answer:`, answer);
          
          const isValid = answer && 
                 answer !== null &&
                 answer !== 'null' &&
                 answer.trim() !== '' && 
                 answer.trim() !== 'Answer not recorded';
          
          if (!isValid) {
            console.log(`[Special Report Details] Invalid answer:`, {
              answer: answer,
              isNull: answer === null,
              isStringNull: answer === 'null',
              isEmpty: answer && answer.trim() === '',
              isNotRecorded: answer && answer.trim() === 'Answer not recorded'
            });
          }
          
          return isValid;
        });
        
        console.log(`[Special Report Details] Report ${doc.id} hasValidResponses:`, hasValidResponses);
      } catch (error) {
        console.warn(`[Special Report Details] Error checking responses for report ${doc.id}:`, error);
      }

      reportList.push({
        id: doc.id,
        title: interviewTemplateTitle, // This is now the Interview Template Title
        report_content: data.report_content || '', // <<< ADDED report_content
        admin_report_content: data.admin_report_content || '', // <<< ADDED admin_report_content
        // subtitle: data.report_subtitle || '', // Subtitle might be less relevant if we show content snippet
        timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : null,
        start_timestamp: data.start_timestamp ? data.start_timestamp.toDate().toISOString() : null,
        end_timestamp: data.end_timestamp ? data.end_timestamp.toDate().toISOString() : null,
        userName: data.user_name || 'N/A',
        userEmail: data.user_email || 'N/A',
        totalRecordingDuration: data.total_recording_duration || 0,
        audio_gcs_url: data.audio_gcs_url || null,
        hasValidResponses: hasValidResponses,
        testField: 'backend_working' // Test field to verify backend changes are being applied
      });
    }));
    // Sort reports by start_timestamp again after fetching titles asynchronously
    reportList.sort((a, b) => {
        const dateA = a.start_timestamp ? new Date(a.start_timestamp) : 0;
        const dateB = b.start_timestamp ? new Date(b.start_timestamp) : 0;
        return dateB - dateA;
    });

    res.json({
      interviewDetails: {
        id: interviewDetails.id,
        title: interviewDetails.title,
        description: interviewDetails.description,
        // Add any other interview fields you want to display on the special report page
      },
      reportList: reportList
    });

  } catch (error) {
    console.error('Error fetching special report details:', error);
    res.status(500).json({ error: 'Failed to fetch special report details', details: error.message });
  }
});

// --- API Endpoint to Get Interview Videos ---
app.get('/api/interview/:interviewId/videos', async (req, res) => {
  const { interviewId } = req.params;
  console.log(`[API /api/interview/${interviewId}/videos] Request received`);
  console.log(`[API interview-videos] Looking for videos for interview: ${interviewId}`);
  
  if (!db || !storage || !GCS_BUCKET_NAME) {
    console.error('[API interview-videos] Core services unavailable');
    return res.status(503).json({ error: 'Core services unavailable' });
  }
  
  try {
    // First, verify the interview exists
    const interviewDoc = await db.collection('interviews').doc(interviewId).get();
    if (!interviewDoc.exists) {
      console.warn(`[API interview-videos] Interview ${interviewId} not found`);
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    // Get videos from the new content collection
    console.log(`[API interview-videos] Querying content collection for videos...`);
    
    // Query for videos that include this interview ID
    const contentSnapshot = await db.collection('content')
      .where('type', '==', 'video')
      .where('interviewIds', 'array-contains', interviewId)
      .orderBy('createdAt', 'desc')
      .get();
    
    console.log(`[API interview-videos] Found ${contentSnapshot.size} videos from content collection`);
    
    const videos = [];
    
    // Process each content document
    for (const doc of contentSnapshot.docs) {
      const contentData = doc.data();
      
      // Refresh signed URL if needed
      let videoUrl = contentData.videoUrl;
      if (contentData.gcsVideoUrl) {
        try {
          const videoPath = contentData.gcsVideoUrl.replace(`gs://${GCS_BUCKET_NAME}/`, '');
          const file = storage.bucket(GCS_BUCKET_NAME).file(videoPath);
          const [signedUrl] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
          });
          videoUrl = signedUrl;
        } catch (urlError) {
          console.error(`[API interview-videos] Error refreshing signed URL:`, urlError);
        }
      }
      
      videos.push({
        id: doc.id,
        threadId: contentData.threadId,
        title: contentData.title || 'Video Summary',
        type: contentData.subtype || 'analyst_summary',
        status: contentData.status || 'completed',
        url: videoUrl,
        gcsUrl: contentData.gcsVideoUrl,
        createdAt: contentData.createdAt?.toDate?.()?.toISOString() || contentData.createdAt || new Date().toISOString(),
        duration: contentData.duration,
        metadata: contentData.metadata
      });
    }
    
    // Also check for legacy videos in the old structure (for backwards compatibility)
    // This can be removed once all videos are migrated
    const userId = req.user?.uid || req.get('X-User-Id') || req.query.userId;
    
    if (userId && videos.length === 0) {
      console.log(`[API interview-videos] No videos in content collection, checking legacy structure...`);
      
      try {
        // Check for any videos in GCS that might not be in the content collection yet
        const prefix = `reports_video/analyst_`;
        const [files] = await storage.bucket(GCS_BUCKET_NAME).getFiles({ prefix });
        
        console.log(`[API interview-videos] Found ${files.length} files in GCS with analyst prefix`);
        
        for (const file of files) {
          // Extract thread ID from filename
          const match = file.name.match(/analyst_([^/]+)\//);
          if (match && file.name.endsWith('.mp4')) {
            const threadId = match[1];
            
            // Check if this video is already in our results
            const exists = videos.some(v => v.gcsUrl === `gs://${GCS_BUCKET_NAME}/${file.name}`);
            
            if (!exists) {
              console.log(`[API interview-videos] Found legacy video in GCS: ${file.name}`);
              
              // Get signed URL
              const [signedUrl] = await file.getSignedUrl({
                version: 'v4',
                action: 'read',
                expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
              });
              
              videos.push({
                id: `legacy_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                threadId: threadId,
                title: 'Video Summary (Legacy)',
                type: 'analyst_summary',
                status: 'completed',
                url: signedUrl,
                gcsUrl: `gs://${GCS_BUCKET_NAME}/${file.name}`,
                createdAt: file.metadata.timeCreated || new Date().toISOString(),
                isLegacy: true
              });
            }
          }
        }
      } catch (gcsError) {
        console.log(`[API interview-videos] Error checking GCS for legacy videos:`, gcsError.message);
      }
    }
    
    console.log(`[API interview-videos] Total videos found: ${videos.length}`);
    
    res.json({
      success: true,
      interviewId: interviewId,
      videos: videos
    });
    
  } catch (error) {
    console.error('[API interview-videos] Error:', error);
    res.status(500).json({ error: 'Failed to fetch interview videos', details: error.message });
  }
});

// --- API Endpoint to Get Interview Context ---
app.get('/api/interviews/:interviewId/context', 
  requireAuth,
  validators.interviewId,
  handleValidationErrors,
  async (req, res) => {
    const interviewId = req.params.interviewId;
    
    try {
      // Get interview from Firestore
      const interviewDoc = await db.collection('interviews').doc(interviewId).get();
      
      if (!interviewDoc.exists) {
        return res.status(404).json({ message: 'Interview not found' });
      }
      
      const interviewData = interviewDoc.data();
      
      // Check if user has access to this interview
      if (interviewData.createdBy !== req.user.uid && 
          (!interviewData.sharedWith || !interviewData.sharedWith.includes(req.user.email))) {
        return res.status(403).json({ message: 'Access denied' });
      }
      
      // Process context files
      let contextText = '';
      if (interviewData.contextFiles && interviewData.contextFiles.length > 0) {
        console.log(`[Context API] Processing ${interviewData.contextFiles.length} context files for interview ${interviewId}`);
        
        for (const fileData of interviewData.contextFiles) {
          if (!fileData || !fileData.path) continue;
          
          const fileName = fileData.name || path.basename(fileData.path);
          
          try {
            // Download and extract text from file
            console.log(`[Context API] Downloading file: ${fileData.path}`);
            const downloadResponse = await storage.bucket(GCS_BUCKET_NAME).file(fileData.path).download();
            const buffer = downloadResponse[0];
            
            // For text files, just use the content directly
            let extractedText = '';
            if (fileData.type === 'text/plain' || fileName.endsWith('.txt')) {
              extractedText = buffer.toString('utf8');
            } else {
              // For other files, use the extraction logic
              extractedText = await extractTextFromFileBuffer(buffer, fileData.type, fileName);
            }
            
            contextText += `\n--- Document: ${fileName} ---\n${extractedText}\n\n`;
          } catch (error) {
            console.error(`[Context API] Error processing file ${fileName}:`, error);
            contextText += `\n--- Document: ${fileName} ---\n[Error loading document: ${error.message}]\n\n`;
          }
        }
      }
      
      res.json({ context: contextText.trim() });
      
    } catch (error) {
      console.error('[Context API] Error:', error);
      res.status(500).json({ message: 'Error loading context', error: error.message });
    }
  }
);

// --- API Endpoint for File Upload ---
// Use multer middleware configured earlier for single file uploads named 'contextFile'
app.post('/api/interviews/:interviewId/upload', 
  requireAuth,
  validators.interviewId,
  handleValidationErrors,
  rateLimiters.fileUpload, 
  upload.single('contextFile'), 
  validators.validateFileUpload,
  async (req, res) => {
  const interviewId = req.params.interviewId;
  const file = req.file;

  console.log(`[Upload] Starting upload for interview ${interviewId}, file: ${file?.originalname}, size: ${file?.size}, auth user: ${req.user?.email}`);

  // Use the GCS client 'storage' initialized earlier
  if (!storage || !GCS_BUCKET_NAME) {
    console.error('GCS Storage client or bucket name is not configured.');
    return res.status(503).json({ message: 'Storage service is not available.' });
  }
  // if (!bucket) { // Remove Firebase bucket check
  //   return res.status(503).json({ message: 'Storage service is not available.' });
  // }
  if (!file) {
    return res.status(400).json({ message: 'No file uploaded.' });
  }
  if (!interviewId) {
    return res.status(400).json({ message: 'Missing interview ID.' });
  }

  // Construct the destination path
  const uniqueFilename = `${uuidv4()}-${file.originalname}`;
  const filePath = `interviews/${interviewId}/contextFiles/${uniqueFilename}`;
  // const fileUpload = bucket.file(filePath); // Use GCS client instead
  const gcsBucket = storage.bucket(GCS_BUCKET_NAME);
  const fileUpload = gcsBucket.file(filePath);

  // console.log(`Attempting to upload file to Firebase Storage: ${filePath}`);
  console.log(`Attempting to upload file to GCS: gs://${GCS_BUCKET_NAME}/${filePath}`);

  const blobStream = fileUpload.createWriteStream({
    metadata: {
      contentType: file.mimetype
    }
  });

  blobStream.on('error', (error) => {
    console.error('Error uploading file to GCS:', error);
    console.error('GCS Error Details:', {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      errors: error.errors,
      stack: error.stack
    });
    res.status(500).json({ message: 'Failed to upload file.', error: error.message });
  });

  blobStream.on('finish', () => {
    console.log(`File uploaded successfully to ${filePath}`);
    // Return the metadata expected by the client
    res.status(200).json({
      name: file.originalname, // Send original name back
      path: filePath,
      size: file.size,
      type: file.mimetype
    });
  });

  // End the stream with the file buffer
  blobStream.end(file.buffer);
});

// --- API Endpoint for Interview Recording Upload ---
app.post('/api/interviews/:interviewId/upload-recording',
  // Remove requireAuth - interviews can be done without authentication
  validators.interviewId,
  handleValidationErrors,
  rateLimiters.interviewRecording,
  mediaUpload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'video', maxCount: 1 }
  ]),
  async (req, res) => {
    const interviewId = req.params.interviewId;
    const { responseDocId, persistentSessionId, storyId } = req.body;
    const audioFile = req.files?.audio?.[0];
    const videoFile = req.files?.video?.[0];
    
    console.log(`[Recording Upload] ========== NEW UPLOAD REQUEST at ${new Date().toISOString()} ==========`);
    console.log(`[Recording Upload] Interview ${interviewId}, Response ${responseDocId}`);
    console.log(`[Recording Upload] Audio: ${audioFile?.size || 0} bytes (${audioFile?.mimetype}), Video: ${videoFile?.size || 0} bytes (${videoFile?.mimetype})`);
    console.log(`[Recording Upload] Request headers:`, {
      'user-agent': req.headers['user-agent'],
      'content-type': req.headers['content-type'],
      'content-length': req.headers['content-length']
    });
    console.log(`[Recording Upload] Files received:`, {
      audio: audioFile ? { size: audioFile.size, mimetype: audioFile.mimetype, fieldname: audioFile.fieldname } : 'none',
      video: videoFile ? { size: videoFile.size, mimetype: videoFile.mimetype, fieldname: videoFile.fieldname } : 'none'
    });
    
    try {
      // Verify the interview exists and get the report
      const interviewDoc = await db.collection('interviews').doc(interviewId).get();
      if (!interviewDoc.exists) {
        console.log(`[Recording Upload] Interview ${interviewId} not found`);
        return res.status(404).json({ 
          success: false, 
          message: 'Interview not found' 
        });
      }
      
      // Validate that we have at least audio
      if (!audioFile) {
        return res.status(400).json({ 
          success: false, 
          message: 'Audio file is required' 
        });
      }
      
      if (!responseDocId || !persistentSessionId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Missing responseDocId or persistentSessionId' 
        });
      }
      
      // Get the session ID from socket connection
      // Since this is HTTP, we need to associate it with the interview
      const sessionId = `HTTP_UPLOAD_${interviewId}_${Date.now()}`;
      
      // Add to media queue for processing
      console.log(`[Recording Upload] Adding to media queue with session ID: ${sessionId}`);
      mediaQueue.push({
        audioBuffer: audioFile.buffer,
        videoBuffer: videoFile?.buffer || Buffer.alloc(0),
        audioMimeType: audioFile.mimetype,
        videoMimeType: videoFile?.mimetype || '',
        responseDocId: responseDocId,
        reportId: persistentSessionId,
        socketId: null, // No socket for HTTP upload
        sessionId: sessionId,
        interviewId: interviewId,
        storyId: storyId || null,
        isStoryFinalTelling: !!storyId
      }, (err) => {
        if (err) {
          console.error(`[Recording Upload] Queue error:`, err);
          console.error(`[Recording Upload] Error details:`, {
            errorMessage: err.message,
            errorStack: err.stack,
            queueStats: mediaQueue.getStats()
          });
          // Error already sent via socket if available
        } else {
          console.log(`[Recording Upload] Successfully queued for processing`);
          const stats = mediaQueue.getStats();
          console.log(`[Recording Upload] Queue status: ${stats.total} items in queue`);
        }
      });
      
      // Return success immediately - processing happens async
      res.json({ 
        success: true, 
        message: 'Recording upload initiated',
        responseDocId: responseDocId
      });
      
    } catch (error) {
      console.error(`[Recording Upload] Error:`, error);
      res.status(500).json({ 
        success: false, 
        message: 'Failed to process recording upload',
        error: error.message 
      });
    }
  }
);

// --- Document Processing Endpoints (Modularized) ---
// Text extraction and website scraping endpoints have been moved to server/routes/document-processing.js
// Initialize the module with our text extraction function
documentProcessing.initialize(extractTextFromFileBuffer);
// Register the routes
documentProcessing.registerRoutes(app);

// --- API Endpoint for Universal File Upload ---
app.post('/api/universal/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const { interviewId } = req.body; // Optional interview ID
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    if (!storage || !GCS_BUCKET_NAME) {
      console.error('GCS not configured');
      return res.status(503).json({ error: 'Storage service unavailable' });
    }
    
    console.log(`[Universal Upload] File: ${file.originalname}, Type: ${file.mimetype}, Size: ${file.size}`);
    
    // Generate unique filename and path
    const uniqueFilename = `${uuidv4()}-${file.originalname}`;
    const basePath = interviewId ? `interviews/${interviewId}/files` : 'uploads';
    const filePath = `${basePath}/${uniqueFilename}`;
    
    // Upload to GCS
    const gcsBucket = storage.bucket(GCS_BUCKET_NAME);
    const fileUpload = gcsBucket.file(filePath);
    
    console.log(`[Universal Upload] Uploading to GCS: gs://${GCS_BUCKET_NAME}/${filePath}`);
    
    // Create write stream
    const blobStream = fileUpload.createWriteStream({
      metadata: {
        contentType: file.mimetype,
        metadata: {
          originalName: file.originalname,
          uploadedAt: new Date().toISOString()
        }
      }
    });
    
    // Handle upload completion
    const uploadPromise = new Promise((resolve, reject) => {
      blobStream.on('error', reject);
      blobStream.on('finish', async () => {
        try {
          // Generate a signed URL for the file (valid for 7 days)
          const [signedUrl] = await fileUpload.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
          });
          
          console.log(`[Universal Upload] Generated signed URL for ${file.originalname}`);
          
          resolve({
            url: signedUrl,
            path: filePath
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    
    // Start upload
    blobStream.end(file.buffer);
    
    // Wait for upload to complete
    const { url, path } = await uploadPromise;
    
    // Extract text content if applicable
    const extractedText = await extractTextFromFileBuffer(file.buffer, file.mimetype, file.originalname);
    
    // Prepare response
    const response = {
      success: true,
      file: {
        name: file.originalname,
        path: path,
        url: url,
        size: file.size,
        type: file.mimetype,
        isImage: file.mimetype.startsWith('image/')
      }
    };
    
    // Add extracted text if available
    if (extractedText) {
      response.extractedText = extractedText;
      response.textLength = extractedText.length;
    }
    
    console.log(`[Universal Upload] Success: ${file.originalname} -> ${url}`);
    res.json(response);
    
  } catch (error) {
    console.error('[Universal Upload] Error:', error);
    res.status(500).json({ 
      error: 'Upload failed', 
      message: error.message 
    });
  }
});

// --- API Endpoint for File Deletion ---
app.delete('/api/files', async (req, res) => {
  const { filePath } = req.body;

  // Use the GCS client 'storage' initialized earlier
  if (!storage || !GCS_BUCKET_NAME) {
    console.error('GCS Storage client or bucket name is not configured.');
    return res.status(503).json({ message: 'Storage service is not available.' });
  }
  // if (!bucket) { // Remove Firebase bucket check
  //  return res.status(503).json({ message: 'Storage service is not available.' });
  // }
  if (!filePath) {
    return res.status(400).json({ message: 'Missing file path for deletion.' });
  }

  // console.log(`Attempting to delete file from Firebase Storage: ${filePath}`);
  console.log(`Attempting to delete file from GCS: gs://${GCS_BUCKET_NAME}/${filePath}`);

  try {
    // const file = bucket.file(filePath); // Use GCS client instead
    const gcsBucket = storage.bucket(GCS_BUCKET_NAME);
    const file = gcsBucket.file(filePath);
    await file.delete();
    console.log(`Successfully deleted ${filePath} from GCS`);
    res.status(200).json({ message: 'File deleted successfully.' });
  } catch (error) {
    // Handle 'not found' errors gracefully (code 404 in GCS errors)
    if (error.code === 404) {
      console.log(`File not found for deletion (already deleted?): ${filePath}`);
      res.status(200).json({ message: 'File not found, presumed deleted.' }); // Still return success
    } else {
      console.error('Error deleting file from GCS:', error);
      res.status(500).json({ message: 'Failed to delete file.', error: error.message });
    }
  }
});

// --- NEW: API Endpoint for Report Video Artifact ---
app.get('/api/reports/:reportId/video-artifact', async (req, res) => {
    const { reportId } = req.params;
    console.log(`[API /api/reports/${reportId}/video-artifact] Request received`);

    if (!db) {
        return res.status(503).json({ error: 'Firebase service unavailable' });
    }
    if (!storage || !GCS_BUCKET_NAME) {
        return res.status(503).json({ error: 'Storage service unavailable' });
    }

    try {
        const reportDocRef = db.collection('reports').doc(reportId);
        const reportDoc = await reportDocRef.get();

        if (!reportDoc.exists) {
            return res.status(404).json({ error: 'Report not found' });
        }
        
        const reportData = reportDoc.data();
        const videoGcsUrl = reportData.video_gcs_url;

        if (!videoGcsUrl) {
            return res.status(404).json({ error: 'Video artifact not found for this report' });
        }

        // Parse GCS URL and create signed URL
        const match = videoGcsUrl.match(/^gs:\/\/([^\/]+)\/(.+)$/);
        if (!match) {
            console.error(`[API video-artifact ${reportId}] Invalid GCS URL format: ${videoGcsUrl}`);
            return res.status(500).json({ error: 'Invalid video URL format' });
        }

        const bucketName = match[1];
        const filePath = match[2];
        
        // Generate a signed URL
        const options = {
            version: 'v4',
            action: 'read',
            expires: Date.now() + 60 * 60 * 1000, // 1 hour
        };
        
        const bucket = storage.bucket(bucketName);
        const [signedUrl] = await bucket.file(filePath).getSignedUrl(options);
        
        // Redirect to the signed URL
        res.redirect(signedUrl);
        
    } catch (error) {
        console.error(`[API video-artifact ${reportId}] Error:`, error);
        res.status(500).json({ error: 'Failed to retrieve video artifact', details: error.message });
    }
});

// --- Analyst video redirect ---
// Stable URL for analyst-summary videos stored at
// gs://<bucket>/reports_video/analyst_<analystId>/<filename>. Browsers
// embedding via <video src> follow the 302 to a freshly-signed URL on each
// request, so the embed never expires from the page's perspective.
app.get('/api/analyst-videos/:analystId/:filename', async (req, res) => {
    const { analystId, filename } = req.params;

    // Allow only safe ID/filename shapes — prevents path traversal and
    // arbitrary GCS object access through this endpoint.
    if (!/^[A-Za-z0-9_-]+$/.test(analystId)) {
        return res.status(400).json({ error: 'Invalid analyst id' });
    }
    if (!/^[A-Za-z0-9._-]+\.mp4$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    if (!storage || !GCS_BUCKET_NAME) {
        return res.status(503).json({ error: 'Storage service unavailable' });
    }

    const filePath = `reports_video/analyst_${analystId}/${filename}`;

    try {
        const file = storage.bucket(GCS_BUCKET_NAME).file(filePath);
        const [exists] = await file.exists();
        if (!exists) {
            return res.status(404).json({ error: 'Video not found' });
        }

        const [signedUrl] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 60 * 60 * 1000, // 1 hour
        });

        res.redirect(signedUrl);
    } catch (error) {
        console.error(`[API analyst-videos ${analystId}/${filename}] Error:`, error);
        res.status(500).json({ error: 'Failed to retrieve analyst video', details: error.message });
    }
});

// Per-response video redirect. Videos live at
// gs://<bucket>/video_answers/<reportId>/<responseId>.mp4 (reportId is the
// persistent_session_id used as the Firestore reports doc id). Mirrors the
// analyst-videos pattern so the URL never expires from the embedder's view.
app.get('/api/reports/:reportId/responses/:responseId/video', async (req, res) => {
    const { reportId, responseId } = req.params;

    if (!/^[A-Za-z0-9_-]+$/.test(reportId) || !/^[A-Za-z0-9_-]+$/.test(responseId)) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    if (!storage || !GCS_BUCKET_NAME) {
        return res.status(503).json({ error: 'Storage service unavailable' });
    }

    const filePath = `video_answers/${reportId}/${responseId}.mp4`;

    try {
        const file = storage.bucket(GCS_BUCKET_NAME).file(filePath);
        const [exists] = await file.exists();
        if (!exists) {
            return res.status(404).json({ error: 'Video not found' });
        }

        const [signedUrl] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 60 * 60 * 1000,
        });

        res.redirect(signedUrl);
    } catch (error) {
        console.error(`[API response-video ${reportId}/${responseId}] Error:`, error);
        res.status(500).json({ error: 'Failed to retrieve response video', details: error.message });
    }
});

// Per-response audio redirect. Sibling to the video endpoint above for
// responses where the participant didn't record on camera. Path on GCS:
// gs://<bucket>/audio_answers_full/<reportId>/<responseId>.mp3
app.get('/api/reports/:reportId/responses/:responseId/audio', async (req, res) => {
    const { reportId, responseId } = req.params;

    if (!/^[A-Za-z0-9_-]+$/.test(reportId) || !/^[A-Za-z0-9_-]+$/.test(responseId)) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    if (!storage || !GCS_BUCKET_NAME) {
        return res.status(503).json({ error: 'Storage service unavailable' });
    }

    const filePath = `audio_answers_full/${reportId}/${responseId}.mp3`;

    try {
        const file = storage.bucket(GCS_BUCKET_NAME).file(filePath);
        const [exists] = await file.exists();
        if (!exists) {
            return res.status(404).json({ error: 'Audio not found' });
        }

        const [signedUrl] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 60 * 60 * 1000,
        });

        res.redirect(signedUrl);
    } catch (error) {
        console.error(`[API response-audio ${reportId}/${responseId}] Error:`, error);
        res.status(500).json({ error: 'Failed to retrieve response audio', details: error.message });
    }
});

// The School membership survey submission endpoint. Frontend lives at
// https://jameslbarnes.github.io/school/ (static, GitHub Pages). The form
// POSTs JSON here; we cap & sanitise the fields, write a Firestore doc,
// and email the result via the existing SendGrid setup. CORS is already
// wide open at the app level so the cross-origin POST works as-is.
app.post('/api/school-survey', express.json({ limit: '16kb' }), async (req, res) => {
    const body = req.body || {};

    // Honeypot — bots fill anything they can. Real form leaves it blank.
    if (typeof body.website === 'string' && body.website.length > 0) {
        return res.status(200).json({ ok: true });
    }

    const cap = (v, n) => String(v == null ? '' : v).slice(0, n).trim();
    const capArr = (v, max, eachMax) =>
        Array.isArray(v) ? v.slice(0, max).map(s => cap(s, eachMax)).filter(Boolean) : [];

    const doc = {
        name:               cap(body.name, 200),
        email:              cap(body.email, 200),
        phone:              cap(body.phone, 50),
        what_you_do:        cap(body.what_you_do, 500),
        workspace_interest: cap(body.workspace_interest, 80),
        monthly_budget:     cap(body.monthly_budget, 80),
        ninja_skill:        cap(body.ninja_skill, 4000),
        info_session:       cap(body.info_session, 80),
        user_agent:         cap(req.headers['user-agent'], 500),
        referer:            cap(req.headers.referer, 500),
        ip:                 cap(req.ip, 80),
        received_at:        new Date().toISOString(),
    };

    if (!doc.name || !doc.email) {
        return res.status(400).json({ error: 'Name and email are required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(doc.email)) {
        return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    // Write to Firestore (best-effort if available).
    let firestoreId = null;
    if (db) {
        try {
            const ref = await db.collection('school_survey_responses').add(doc);
            firestoreId = ref.id;
        } catch (err) {
            console.error('[school-survey] firestore write failed:', err && err.message);
        }
    }

    // Email the response (best-effort).
    try {
        if (sgMail && process.env.SENDGRID_API_KEY) {
            const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'contact@example.com';
            const toEmail = 'memberships@theoldschool.nyc';
            const lines = [
                `Name:  ${doc.name}`,
                `Email: ${doc.email}`,
                `Phone: ${doc.phone || '(skipped)'}`,
                ``,
                `What they do:`,
                `  ${doc.what_you_do || '(skipped)'}`,
                ``,
                `Workspace interest:   ${doc.workspace_interest || '(skipped)'}`,
                `Coworking budget/mo:  ${doc.monthly_budget || '(skipped)'}`,
                `Info session May 28:   ${doc.info_session || '(skipped)'}`,
                ``,
                `Ninja skill:`,
                `  ${doc.ninja_skill || '(skipped)'}`,
                ``,
                `--`,
                `Received ${doc.received_at}`,
                `Firestore id: ${firestoreId || 'n/a'}`,
                `Referer: ${doc.referer || '(skipped)'}`,
            ].join('\n');
            await sgMail.send({
                to: toEmail,
                from: fromEmail,
                subject: `[The Old School] Interest form: ${doc.name}`,
                text: lines,
            });
        }
    } catch (mailErr) {
        console.error('[school-survey] email failed:', mailErr && mailErr.message);
    }

    return res.status(200).json({ ok: true });
});

// --- NEW: API Endpoint for Report Audio Artifact ---
app.get('/api/reports/:reportId/audio-artifact', async (req, res) => {
    const { reportId } = req.params;
    const forceRegenerate = req.query.force_regenerate === 'true';
    const reportType = req.query.type; // Check for 'admin' type
    // let tempDirPath = null; // tempDirPath is managed within generateAndStoreReportAudio

    console.log(`[API /api/reports/${reportId}/audio-artifact] Request received. Force regenerate: ${forceRegenerate}, Type: ${reportType}`);

    if (!db) {
        console.error(`[API audio-artifact ${reportId}] Firebase service unavailable.`);
        return res.status(503).json({ error: 'Firebase service unavailable' });
    }
    if (!storage || !GCS_BUCKET_NAME) {
        console.error(`[API audio-artifact ${reportId}] GCS Storage or bucket name not configured.`);
        return res.status(503).json({ error: 'Storage service unavailable' });
    }
    if (!openai) {
        console.error(`[API audio-artifact ${reportId}] OpenAI client not available.`);
        return res.status(503).json({ error: 'OpenAI service unavailable' });
    }

    try {
        console.log(`[API audio-artifact ${reportId}] Fetching report document...`);
        const reportDocRef = db.collection('reports').doc(reportId);
        const reportDoc = await reportDocRef.get();

        if (!reportDoc.exists) {
            console.warn(`[API audio-artifact ${reportId}] Report not found.`);
            return res.status(404).json({ error: 'Report not found' });
        }
        const reportData = reportDoc.data();

        let audioGcsUrl = reportData.audio_gcs_url;
        let reportTextForAudio = reportData.report_content;
        let targetGcsField = 'audio_gcs_url';

        // Determine if we should use admin report content
        if (reportType === 'admin') {
            console.log(`[API audio-artifact ${reportId}] Requested admin audio type.`);
            reportTextForAudio = reportData.admin_report_content;
            audioGcsUrl = reportData.admin_audio_gcs_url;
            targetGcsField = 'admin_audio_gcs_url';
        } else if (forceRegenerate && reportData.admin_report_content && !reportType) {
            // If forcing regenerate AND admin content exists AND no specific type is requested,
            // assume regeneration is for the admin report (current behaviour of regenerate button)
            console.log(`[API audio-artifact ${reportId}] Prioritizing admin_report_content for forced regeneration (no specific type).`);
            reportTextForAudio = reportData.admin_report_content;
            audioGcsUrl = reportData.admin_audio_gcs_url; // Check if admin audio already exists
            targetGcsField = 'admin_audio_gcs_url';
        } else if (reportData.admin_report_content && !reportData.audio_gcs_url && reportData.admin_audio_gcs_url && !reportType) {
            // This case is less likely now with explicit type, but kept for safety:
            // If fetching non-forced, no specific type, admin audio exists but primary doesn't, prefer admin.
            console.log(`[API audio-artifact ${reportId}] Admin audio exists, primary does not, no type specified. Using admin audio.`);
            reportTextForAudio = reportData.admin_report_content;
            audioGcsUrl = reportData.admin_audio_gcs_url;
            targetGcsField = 'admin_audio_gcs_url';
        } // Else, default to primary report_content and audio_gcs_url (already initialized)

        if (audioGcsUrl && !forceRegenerate) {
            console.log(`[API audio-artifact ${reportId}] Existing audio GCS URL found: ${audioGcsUrl} for field ${targetGcsField}. Not forcing regeneration.`);
        } else {
            console.log(`[API audio-artifact ${reportId}] Existing audio GCS URL for ${targetGcsField} ${audioGcsUrl ? 'found but forcing regeneration' : 'not found'}. Generating new audio using text from ${targetGcsField === 'admin_audio_gcs_url' ? 'admin_report_content' : 'report_content'}.`);
            if (!reportTextForAudio || reportTextForAudio.trim() === '') {
                console.warn(`[API audio-artifact ${reportId}] Report content (for ${targetGcsField}) is empty. Cannot generate audio.`);
                return res.status(400).json({ error: `Report content for ${targetGcsField} is empty, cannot generate audio.` });
            }

            // Fetch responses with signed URLs, as these are needed by generateAndStoreReportAudio
            // to access original user audio clips if the report uses them.
            console.log(`[API audio-artifact ${reportId}] Fetching responses with signed URLs for audio generation...`);
            const responsesWithSignedUrls = await getResponsesWithSignedUrls(reportId, db, storage, GCS_BUCKET_NAME);
            // getResponsesWithSignedUrls includes word_timestamps if available in Firestore.

            audioGcsUrl = await generateAndStoreReportAudio(
                reportId,
                reportTextForAudio, // Use the determined report text
                responsesWithSignedUrls, // Pass the detailed responses
                db,
                storage,
                GCS_BUCKET_NAME,
                openai
            );

            if (audioGcsUrl) {
                console.log(`[API audio-artifact ${reportId}] New audio generated/stored. GCS URL: ${audioGcsUrl}. Updating Firestore field ${targetGcsField}.`);
                await reportDocRef.update({ [targetGcsField]: audioGcsUrl });
            } else {
                console.error(`[API audio-artifact ${reportId}] Audio generation failed to return a GCS URL.`);
                return res.status(500).json({ error: 'Audio generation failed.' });
            }
        }

        // Generate a signed URL for the GCS audio path (either existing or newly generated)
        if (audioGcsUrl) {
            const match = audioGcsUrl.match(/^gs:\/\/([^\/]+)\/(.+)$/);
            if (match) {
                const bucketName = match[1];
                const filePath = match[2];
                const signedUrlOptions = {
                    version: 'v4',
                    action: 'read',
                    expires: Date.now() + 15 * 60 * 1000, // 15 minutes
                };
                const [signedRedirectUrl] = await storage.bucket(bucketName).file(filePath).getSignedUrl(signedUrlOptions);
                console.log(`[API audio-artifact ${reportId}] Generated signed URL. Streaming audio to client.`);
                // return res.redirect(302, signedRedirectUrl); // <<< REMOVE REDIRECT

                // --- ADDED: Proxy audio stream --- 
                const gcsResponse = await fetch(signedRedirectUrl); // Fetch audio from GCS using the signed URL
                if (!gcsResponse.ok) {
                    throw new Error(`Failed to fetch audio from GCS: ${gcsResponse.status} ${gcsResponse.statusText}`);
                }

                res.setHeader('Content-Type', 'audio/mpeg');
                // If you know the content length, you can set it, but for streaming it's often not critical immediately
                // const contentLength = gcsResponse.headers.get('content-length');
                // if (contentLength) {
                //     res.setHeader('Content-Length', contentLength);
                // }
                
                // Pipe the audio stream from GCS to the client response
                gcsResponse.body.pipe(res);
                // --- END ADDED --- 

            } else {
                console.error(`[API audio-artifact ${reportId}] Invalid GCS URL format in Firestore: ${audioGcsUrl}`);
                return res.status(500).json({ error: 'Invalid audio file location.' });
            }
        } else {
            // This case should ideally be caught earlier if audioGcsUrl is null after generation attempt
            console.error(`[API audio-artifact ${reportId}] No audio GCS URL available after processing. Cannot serve audio.`);
            return res.status(404).json({ error: 'Audio artifact not found or could not be generated.' });
        }

    } catch (error) {
        console.error(`[API audio-artifact ${reportId}] Error processing request:`, error);
        // tempDirPath is managed within generateAndStoreReportAudio, so no explicit cleanup here
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to process audio artifact request.', details: error.message });
        }
    }
});

// --- NEW: API endpoint to publish report to gallery ---
app.post('/api/reports/:reportId/publish-to-gallery', async (req, res) => {
    try {
        const { reportId } = req.params;
        
        if (!db) {
            return res.status(503).json({ error: 'Firebase service unavailable' });
        }
        
        // Get the report
        const reportDoc = await db.collection('reports').doc(reportId).get();
        if (!reportDoc.exists) {
            return res.status(404).json({ error: 'Report not found' });
        }
        
        const reportData = reportDoc.data();
        const interviewId = reportData.interview_id;
        
        if (!interviewId) {
            return res.status(400).json({ error: 'Report has no associated interview' });
        }
        
        // Check if interview allows gallery publishing
        const interviewDoc = await db.collection('interviews').doc(interviewId).get();
        if (!interviewDoc.exists) {
            return res.status(404).json({ error: 'Interview not found' });
        }
        
        const interviewData = interviewDoc.data();
        if (!interviewData.allowPublicGallery) {
            return res.status(403).json({ error: 'This interview does not allow public gallery publishing' });
        }
        
        // Check if already published
        const existingPublicReport = await db.collection('publicReports')
            .where('originalReportId', '==', reportId)
            .limit(1)
            .get();
            
        if (!existingPublicReport.empty) {
            return res.status(400).json({ error: 'Report is already published to gallery' });
        }
        
        // Create public report entry
        const publicReportData = {
            originalReportId: reportId,
            templateId: interviewData.sourceTemplateId || interviewId,
            galleryTitle: reportData.report_title || `${interviewData.title || 'Interview'} Report`,
            galleryDescription: reportData.report_subtitle || `A completed ${interviewData.title || 'interview'} by ${reportData.user_name || 'an anonymous user'}`,
            audioUrl: reportData.audio_gcs_url || null,
            duration: reportData.total_recording_duration || 0,
            status: 'pending', // Requires admin approval
            submittedAt: admin.firestore.FieldValue.serverTimestamp(),
            submittedBy: reportData.user_email || 'anonymous',
            
            // Store anonymized versions
            reportContent: reportData.report_content || '',
            transcript: null, // Will be populated separately if needed
            
            // Metadata
            interviewTitle: interviewData.title || 'Untitled Interview',
            interviewCategory: interviewData.category || 'uncategorized',
            
            // Stats
            plays: 0,
            likes: 0
        };
        
        const publicReportRef = await db.collection('publicReports').add(publicReportData);
        
        res.json({ 
            success: true, 
            message: 'Report submitted for gallery publication',
            publicReportId: publicReportRef.id
        });
        
    } catch (error) {
        console.error('Error publishing report to gallery:', error);
        res.status(500).json({ error: 'Failed to publish report', details: error.message });
    }
});

// --- API endpoint to unpublish report from gallery ---
app.delete('/api/reports/:reportId/unpublish-from-gallery', requireAuth, async (req, res) => {
    const { reportId } = req.params;
    
    try {
        // Find the public report with this original report ID
        const publicReportSnapshot = await db.collection('publicReports')
            .where('originalReportId', '==', reportId)
            .limit(1)
            .get();
            
        if (publicReportSnapshot.empty) {
            return res.status(404).json({ error: 'Report not found in gallery' });
        }
        
        const publicReportDoc = publicReportSnapshot.docs[0];
        const publicReportData = publicReportDoc.data();
        
        // Check if user owns the original report
        const reportDoc = await db.collection('reports').doc(reportId).get();
        if (!reportDoc.exists) {
            return res.status(404).json({ error: 'Original report not found' });
        }
        
        const reportData = reportDoc.data();
        if (reportData.email !== req.user.email && reportData.createdByEmail !== req.user.email) {
            return res.status(403).json({ error: 'You do not have permission to unpublish this report' });
        }
        
        // Delete the public report
        await db.collection('publicReports').doc(publicReportDoc.id).delete();
        
        res.json({ 
            success: true, 
            message: 'Report removed from gallery'
        });
        
    } catch (error) {
        console.error('Error unpublishing report:', error);
        res.status(500).json({ error: 'Failed to unpublish report', details: error.message });
    }
});

// --- Admin endpoint to approve/reject gallery submissions ---
app.post('/api/admin/public-reports/:publicReportId/moderate', requireAuth, async (req, res) => {
    const { publicReportId } = req.params;
    const { action } = req.body; // 'approve' or 'reject'
    
    try {
        // Check if user is admin
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        if (!userDoc.exists || !userDoc.data().isSuperAdmin) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: 'Invalid action. Must be "approve" or "reject"' });
        }
        
        const publicReportRef = db.collection('publicReports').doc(publicReportId);
        const publicReportDoc = await publicReportRef.get();
        
        if (!publicReportDoc.exists) {
            return res.status(404).json({ error: 'Public report not found' });
        }
        
        if (action === 'approve') {
            await publicReportRef.update({
                status: 'approved',
                approvedAt: admin.firestore.FieldValue.serverTimestamp(),
                approvedBy: req.user.email
            });
            res.json({ success: true, message: 'Report approved for gallery' });
        } else {
            // For rejection, we'll delete the report
            await publicReportRef.delete();
            res.json({ success: true, message: 'Report rejected and removed' });
        }
        
    } catch (error) {
        console.error('Error moderating public report:', error);
        res.status(500).json({ error: 'Failed to moderate report', details: error.message });
    }
});

// --- API endpoint to get report likes ---
app.get('/api/reports/:reportId/likes', async (req, res) => {
    try {
        const { reportId } = req.params;
        
        if (!db) {
            return res.status(503).json({ error: 'Firebase service unavailable' });
        }
        
        // Get the report to check if it exists
        const reportDoc = await db.collection('reports').doc(reportId).get();
        if (!reportDoc.exists) {
            return res.status(404).json({ error: 'Report not found' });
        }
        
        const reportData = reportDoc.data();
        const likes = reportData.likes || 0;
        
        res.json({ likes });
        
    } catch (error) {
        console.error('Error fetching report likes:', error);
        res.status(500).json({ error: 'Failed to fetch likes', details: error.message });
    }
});

// --- API endpoint to like/unlike a report ---
app.post('/api/reports/:reportId/like', async (req, res) => {
    try {
        const { reportId } = req.params;
        const { action } = req.body; // 'like' or 'unlike'
        
        if (!db) {
            return res.status(503).json({ error: 'Firebase service unavailable' });
        }
        
        if (!action || (action !== 'like' && action !== 'unlike')) {
            return res.status(400).json({ error: 'Invalid action. Must be "like" or "unlike"' });
        }
        
        // Get the report
        const reportRef = db.collection('reports').doc(reportId);
        const reportDoc = await reportRef.get();
        
        if (!reportDoc.exists) {
            return res.status(404).json({ error: 'Report not found' });
        }
        
        const reportData = reportDoc.data();
        let currentLikes = reportData.likes || 0;
        
        // Update likes count
        if (action === 'like') {
            currentLikes = Math.max(0, currentLikes + 1);
        } else {
            currentLikes = Math.max(0, currentLikes - 1);
        }
        
        // Update the report document
        await reportRef.update({
            likes: currentLikes,
            lastLikeUpdate: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`[API] Report ${reportId} ${action}d. New count: ${currentLikes}`);
        
        res.json({ 
            success: true, 
            likes: currentLikes,
            action: action 
        });
        
    } catch (error) {
        console.error('Error updating report likes:', error);
        res.status(500).json({ error: 'Failed to update likes', details: error.message });
    }
});

// --- NEW: API endpoint to get public gallery templates ---
app.get('/api/gallery/templates', async (req, res) => {
    try {
        const { category } = req.query;
        
        if (!db) {
            return res.status(503).json({ error: 'Firebase service unavailable' });
        }
        
        // Query all templates (for now, we'll show all templates in the gallery)
        // You can add more filters later (e.g., only show templates from certain users)
        let query = db.collection('templates');
        
        if (category) {
            query = query.where('category', '==', category);
        }
        
        const snapshot = await query.get();
        const templates = [];
        
        snapshot.forEach(doc => {
            const data = doc.data();
            templates.push({
                id: doc.id,
                title: data.title || 'Untitled Template',
                description: data.description || '',
                category: data.category || 'uncategorized',
                originalInterviewId: data.originalInterviewId,
                usageStats: data.usageStats || {}
            });
        });
        
        res.json({ templates });
        
    } catch (error) {
        console.error('Error fetching gallery templates:', error);
        res.status(500).json({ error: 'Failed to fetch templates', details: error.message });
    }
});

// --- NEW: API endpoint to get templates with their latest published interview ---
app.get('/api/gallery/templates-with-audio', async (req, res) => {
    try {
        const { limit = 10 } = req.query;
        
        if (!db) {
            return res.status(503).json({ error: 'Firebase service unavailable' });
        }
        
        // Step 1: Query approved public reports first (more efficient approach)
        const approvedReportsQuery = db.collection('publicReports')
            .where('status', '==', 'approved')
            .orderBy('createdAt', 'desc')
            .limit(parseInt(limit));
            
        let approvedReportsSnapshot;
        try {
            approvedReportsSnapshot = await approvedReportsQuery.get();
            console.log(`[Gallery] Found ${approvedReportsSnapshot.size} approved reports with orderBy`);
        } catch (indexError) {
            // Fallback without orderBy if index doesn't exist
            console.log('Index not found for publicReports, trying without orderBy');
            approvedReportsSnapshot = await db.collection('publicReports')
                .where('status', '==', 'approved')
                .limit(parseInt(limit))
                .get();
            console.log(`[Gallery] Found ${approvedReportsSnapshot.size} approved reports without orderBy`);
        }
        
        if (approvedReportsSnapshot.empty) {
            console.log('[Gallery] No approved reports found, returning empty array');
            return res.json({ templates: [] });
        }
        
        // Step 2: Collect unique template IDs from approved reports
        const templateIds = new Set();
        const reportsByTemplateId = new Map();
        
        approvedReportsSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.templateId) {
                templateIds.add(data.templateId);
                // Store the latest report for each template (first one is most recent due to orderBy)
                if (!reportsByTemplateId.has(data.templateId)) {
                    reportsByTemplateId.set(data.templateId, {
                        id: doc.id,
                        ...data
                    });
                }
            }
        });
        
        // Step 3: Fetch templates for these IDs
        const templatesWithAudio = [];
        console.log(`[Gallery] Fetching ${templateIds.size} templates: ${Array.from(templateIds).join(', ')}`);
        
        for (const templateId of templateIds) {
            try {
                const templateDoc = await db.collection('templates').doc(templateId).get();
                
                if (templateDoc.exists) {
                    const templateData = templateDoc.data();
                    const latestReport = reportsByTemplateId.get(templateId);
                    
                    // Get audio URL
                    let audioUrl = latestReport.audioUrl || null;
                    
                    // If no audioUrl in publicReport, try to get from original report
                    if (!audioUrl && latestReport.originalReportId) {
                        try {
                            const originalReportDoc = await db.collection('reports').doc(latestReport.originalReportId).get();
                            if (originalReportDoc.exists) {
                                const originalData = originalReportDoc.data();
                                audioUrl = originalData.audio_gcs_url || null;
                            }
                        } catch (err) {
                            console.error('Error fetching original report for audio:', err);
                        }
                    }
                    
                    // Generate signed URL if audioUrl is a GCS path
                    if (audioUrl && audioUrl.startsWith('gs://') && storage) {
                        try {
                            const bucketName = audioUrl.split('/')[2];
                            const fileName = audioUrl.split('/').slice(3).join('/');
                            const file = storage.bucket(bucketName).file(fileName);
                            const [signedUrl] = await file.getSignedUrl({
                                version: 'v4',
                                action: 'read',
                                expires: Date.now() + 60 * 60 * 1000, // 1 hour
                            });
                            audioUrl = signedUrl;
                        } catch (urlError) {
                            console.error('Error generating signed URL:', urlError);
                            audioUrl = null;
                        }
                    }
                    
                    templatesWithAudio.push({
                        id: templateDoc.id,
                        title: templateData.title || 'Untitled Template',
                        description: templateData.description || '',
                        category: templateData.category || 'uncategorized',
                        originalInterviewId: templateData.originalInterviewId,
                        usageStats: templateData.usageStats || {},
                        latestPublishedInterview: {
                            id: latestReport.id,
                            originalReportId: latestReport.originalReportId,
                            audioUrl: audioUrl,
                            duration: latestReport.duration || 0,
                            galleryTitle: latestReport.galleryTitle || '',
                            galleryDescription: latestReport.galleryDescription || '',
                            plays: latestReport.plays || 0,
                            createdAt: latestReport.createdAt
                        }
                    });
                }
            } catch (error) {
                console.error(`Error fetching template ${templateId}:`, error);
            }
        }
        
        // Sort by most recent report (maintain the order from our original query)
        templatesWithAudio.sort((a, b) => {
            const aTime = a.latestPublishedInterview.createdAt || 0;
            const bTime = b.latestPublishedInterview.createdAt || 0;
            return bTime - aTime;
        });
        
        res.json({ templates: templatesWithAudio });
        
    } catch (error) {
        console.error('Error fetching templates with audio:', error);
        res.status(500).json({ error: 'Failed to fetch templates with audio', details: error.message });
    }
});

// --- NEW: API endpoint to get a specific public report ---
app.get('/api/public-reports/:publicReportId', async (req, res) => {
    try {
        const { publicReportId } = req.params;
        
        if (!db) {
            return res.status(503).json({ error: 'Firebase service unavailable' });
        }
        
        const publicReportDoc = await db.collection('publicReports').doc(publicReportId).get();
        
        if (!publicReportDoc.exists) {
            return res.status(404).json({ error: 'Public report not found' });
        }
        
        const publicReportData = publicReportDoc.data();
        
        // Only return approved reports
        if (publicReportData.status !== 'approved') {
            return res.status(403).json({ error: 'Report is not yet approved for public viewing' });
        }
        
        // Get the original report ID to fetch audio URL if needed
        const originalReportId = publicReportData.originalReportId;
        
        res.json({
            id: publicReportId,
            reportId: originalReportId, // For audio playback
            report_content: publicReportData.reportContent || '',
            report_title: publicReportData.galleryTitle || 'Example Report',
            report_subtitle: publicReportData.galleryDescription || '',
            interview_id: publicReportData.templateId,
            audio_gcs_url: publicReportData.audioUrl || null,
            duration: publicReportData.duration || 0,
            plays: publicReportData.plays || 0,
            likes: publicReportData.likes || 0,
            isPublic: true
        });
        
        // Increment play count
        await db.collection('publicReports').doc(publicReportId).update({
            plays: admin.firestore.FieldValue.increment(1)
        });
        
    } catch (error) {
        console.error('Error fetching public report:', error);
        res.status(500).json({ error: 'Failed to fetch public report', details: error.message });
    }
});

// --- NEW: API endpoint to get responses for a public report ---
app.get('/api/public-reports/:publicReportId/responses', async (req, res) => {
    try {
        const { publicReportId } = req.params;
        
        if (!db) {
            return res.status(503).json({ error: 'Firebase service unavailable' });
        }
        
        if (!storage) {
            return res.status(503).json({ error: 'Storage service unavailable' });
        }
        
        // First, get the public report to verify it exists and is approved
        const publicReportDoc = await db.collection('publicReports').doc(publicReportId).get();
        
        if (!publicReportDoc.exists) {
            return res.status(404).json({ error: 'Public report not found' });
        }
        
        const publicReportData = publicReportDoc.data();
        
        // Only return responses for approved reports
        if (publicReportData.status !== 'approved') {
            return res.status(403).json({ error: 'Report is not yet approved for public viewing' });
        }
        
        // Get the original report ID to fetch responses
        const originalReportId = publicReportData.originalReportId;
        
        if (!originalReportId) {
            return res.status(404).json({ error: 'Original report ID not found' });
        }
        
        // Fetch responses from the original report
        const responsesQuery = db.collection('reports').doc(originalReportId).collection('responses').orderBy('timestamp', 'asc');
        const snapshot = await responsesQuery.get();
        
        const responses = [];
        // Use Promise.all to handle async signed URL generation
        await Promise.all(snapshot.docs.map(async (doc) => {
            const data = doc.data();
            let signedAudioUrl = null;
            let signedVideoUrl = null;
            
            if (data.audio_gcs_url && storage) {
                try {
                    const gcsUri = data.audio_gcs_url;
                    // Extract bucket name and file path from gs:// URI
                    const match = gcsUri.match(/^gs:\/\/([^\/]+)\/(.+)$/);
                    if (match) {
                        const bucketName = match[1];
                        const filePath = match[2];
                        
                        // Generate a signed URL (expires in 1 hour)
                        const options = {
                            version: 'v4',
                            action: 'read',
                            expires: Date.now() + 60 * 60 * 1000, // 1 hour
                        };
                        const [url] = await storage.bucket(bucketName).file(filePath).getSignedUrl(options);
                        signedAudioUrl = url;
                    } else {
                        console.warn(`Invalid GCS URI format: ${gcsUri}`);
                    }
                } catch (urlError) {
                    console.error(`Error generating signed URL for ${data.audio_gcs_url}:`, urlError);
                    // Proceed without a signed URL if generation fails
                }
            }
            
            // Generate signed URL for video if exists
            if (data.video_gcs_url && storage) {
                try {
                    const gcsUri = data.video_gcs_url;
                    // Extract bucket name and file path from gs:// URI
                    const match = gcsUri.match(/^gs:\/\/([^\/]+)\/(.+)$/);
                    if (match) {
                        const bucketName = match[1];
                        const filePath = match[2];
                        
                        // Generate a signed URL (expires in 1 hour)
                        const options = {
                            version: 'v4',
                            action: 'read',
                            expires: Date.now() + 60 * 60 * 1000, // 1 hour
                        };
                        const [url] = await storage.bucket(bucketName).file(filePath).getSignedUrl(options);
                        signedVideoUrl = url;
                    } else {
                        console.warn(`Invalid GCS URI format: ${gcsUri}`);
                    }
                } catch (urlError) {
                    console.error(`Error generating signed URL for ${data.video_gcs_url}:`, urlError);
                    // Proceed without a signed URL if generation fails
                }
            }
            
            responses.push({
                id: doc.id,
                question: data.question,
                answer: data.answer,
                timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : null,
                audio_signed_url: signedAudioUrl,
                video_signed_url: signedVideoUrl,
                word_timestamps: data.word_timestamps || null
                // Exclude thinking trace/full prompt for public reports
            });
        }));
        
        res.json({ responses });
        
    } catch (error) {
        console.error('Error fetching responses for public report:', error);
        if (error.message.includes('no entity to update') || error.code === 5) {
            return res.status(404).json({ error: 'Report or associated responses not found.', details: error.message });
        }
        res.status(500).json({ error: 'Failed to fetch responses for public report', details: error.message });
    }
});

// --- NEW: API endpoint to get public reports for a template ---
app.get('/api/gallery/reports/:templateId', async (req, res) => {
    try {
        const { templateId } = req.params;
        const { limit = 10 } = req.query;
        
        if (!db) {
            return res.status(503).json({ error: 'Firebase service unavailable' });
        }
        
        // Query approved public reports for this template
        // First try by templateId
        let snapshot = await db.collection('publicReports')
            .where('templateId', '==', templateId)
            .where('status', '==', 'approved')
            .limit(parseInt(limit))
            .get();
            
        // If no results, also check if any reports were created from interviews that used this template
        if (snapshot.empty) {
            // Get the template to find its original interview ID
            const templateDoc = await db.collection('templates').doc(templateId).get();
            if (templateDoc.exists) {
                const templateData = templateDoc.data();
                const originalInterviewId = templateData.originalInterviewId;
                
                if (originalInterviewId) {
                    // Look for reports from interviews created from this template
                    snapshot = await db.collection('publicReports')
                        .where('templateId', '==', originalInterviewId)
                        .where('status', '==', 'approved')
                        .limit(parseInt(limit))
                        .get();
                }
            }
        }
            
        const reports = [];
        
        snapshot.forEach(doc => {
            const data = doc.data();
            reports.push({
                id: doc.id,
                originalReportId: data.originalReportId, // Include this for audio playback
                galleryTitle: data.galleryTitle || 'Example Report',
                galleryDescription: data.galleryDescription || '',
                duration: data.duration || 0,
                audioUrl: data.audioUrl || null,
                plays: data.plays || 0,
                likes: data.likes || 0,
                submittedAt: data.submittedAt ? data.submittedAt.toDate().toISOString() : null
            });
        });
        
        res.json({ reports });
        
    } catch (error) {
        console.error('Error fetching gallery reports:', error);
        res.status(500).json({ error: 'Failed to fetch reports', details: error.message });
    }
});

// API endpoint to get the latest shape configuration
app.get('/api/shape-config/:mode', async (req, res) => {
    try {
        const mode = req.params.mode; // 'interview' or 'report'
        
        if (!mode || !['interview', 'report'].includes(mode)) {
            return res.status(400).json({ error: 'Invalid mode. Must be "interview" or "report"' });
        }
        
        // Get the default admin user who manages the shape configurations
        // You can modify this to use a specific user ID or configuration source
        const adminUserId = process.env.SHAPE_CONFIG_ADMIN_USER_ID;
        
        if (!adminUserId) {
            console.log('No SHAPE_CONFIG_ADMIN_USER_ID set, returning defaults');
            const defaultConfigs = {
                interview: {
                    shapeType: 'torusKnot',
                    shapeParams: { radius: 4, tubeRadius: 1.2, p: 3, q: 5 },
                    textSize: 0.5,
                    textSpeed: 50,
                    bgColor: '#000000',
                    textOrientation: 'vertical'
                },
                report: {
                    shapeType: 'lissajous',
                    shapeParams: { a: 4, b: 5, c: 6, scale: 3 },
                    textSize: 0.7,
                    textSpeed: 75,
                    bgColor: '#000000',
                    textOrientation: 'vertical'
                }
            };
            
            return res.json({ 
                config: defaultConfigs[mode],
                source: 'default'
            });
        }
        
        if (!db) {
            // If Firebase is not available, return default configuration
            const defaultConfigs = {
                interview: {
                    shapeType: 'torusKnot',
                    shapeParams: { radius: 4, tubeRadius: 1.2, p: 3, q: 5 },
                    textSize: 0.5,
                    textSpeed: 50,
                    bgColor: '#000000',
                    textOrientation: 'vertical'
                },
                report: {
                    shapeType: 'lissajous',
                    shapeParams: { a: 4, b: 5, c: 6, scale: 3 },
                    textSize: 0.7,
                    textSpeed: 75,
                    bgColor: '#000000',
                    textOrientation: 'vertical'
                }
            };
            
            return res.json({ 
                config: defaultConfigs[mode],
                source: 'default'
            });
        }
        
        // Try to get configuration from the admin user's document
        const userDoc = await db.collection('users').doc(adminUserId).get();
        
        if (!userDoc.exists) {
            throw new Error('Configuration user not found');
        }
        
        const userData = userDoc.data();
        const configKey = mode === 'interview' ? 'activeInterviewShapeConfig' : 'activeReportShapeConfig';
        const config = userData[configKey];
        
        if (!config) {
            // Return default if no config found
            const defaultConfigs = {
                interview: {
                    shapeType: 'torusKnot',
                    shapeParams: { radius: 4, tubeRadius: 1.2, p: 3, q: 5 },
                    textSize: 0.5,
                    textSpeed: 50,
                    bgColor: '#000000',
                    textOrientation: 'vertical'
                },
                report: {
                    shapeType: 'lissajous',
                    shapeParams: { a: 4, b: 5, c: 6, scale: 3 },
                    textSize: 0.7,
                    textSpeed: 75,
                    bgColor: '#000000',
                    textOrientation: 'vertical'
                }
            };
            
            return res.json({ 
                config: defaultConfigs[mode],
                source: 'default'
            });
        }
        
        res.json({ 
            config: config,
            source: 'user',
            updatedAt: userData.updatedAt ? userData.updatedAt.toDate().toISOString() : null
        });
        
    } catch (error) {
        console.error('Error fetching shape configuration:', error);
        res.status(500).json({ error: 'Failed to fetch shape configuration', details: error.message });
    }
});

// --- Updated parseReportAndPrepareAudioSegments ---
// parseReportAndPrepareAudioSegments is now imported from server/utils/video.js

// --- Helper function to pad audio files ---
async function padAudioFile(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`[padAudioFile] Padding audio: ${inputPath} -> ${outputPath}`);
        if (!fs.existsSync(inputPath) || fs.statSync(inputPath).size === 0) {
            console.warn(`[padAudioFile] Input file ${inputPath} is missing or empty. Skipping padding.`);
            // Resolve with input path so if it's an error in chain, it doesn't break entirely,
            // but the unpadded version will be used (or handle as error if padding is mandatory)
            // For this use case, if padding fails, it's better to not proceed with a broken file.
            return reject(new Error(`Input file ${inputPath} for padding is missing or empty.`));
        }

        ffmpeg(inputPath)
            .toFormat('mp3') // Ensure output is mp3
            .on('error', (err) => {
                console.error(`[padAudioFile] FFmpeg error padding ${inputPath}:`, err.message);
                reject(err);
            })
            .on('end', () => {
                console.log(`[padAudioFile] Successfully padded ${inputPath} to ${outputPath}`);
                resolve(outputPath);
            })
            .save(outputPath);
    });
}

// --- Updated generateAudioFilesFromSegments ---
async function generateAudioFilesFromSegments(segments, openaiClient, tempDir) {
    console.log(`[generateAudioFilesFromSegments] Generating audio for ${segments.length} segments in ${tempDir}`);
    const unpaddedAudioFilePaths = []; // Collect paths of unpadded segments first

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const baseFileName = `segment_${i}_${segment.type}_${Math.random().toString(36).substring(2, 7)}`;

        if (segment.type === 'text') {
            if (!segment.content || segment.content.trim() === '') {
                console.log(`[generateAudioFilesFromSegments] Skipping empty text segment ${i}.`);
                continue;
            }
            const ttsFilePath = path.join(tempDir, `${baseFileName}_tts.mp3`);
            try {
                console.log(`[generateAudioFilesFromSegments] Generating TTS for: "${segment.content.substring(0,30)}..."`);
                const trimmedContent = segment.content.trim();
                if (trimmedContent === '') { // Double check after potential leading/trailing whitespace in original
                    console.log(`[generateAudioFilesFromSegments] Skipping effectively empty text segment ${i} after trimming.`);
                    continue;
                }
                const ttsResponse = await openaiClient.audio.speech.create({
                    model: "gpt-4o-mini-tts",
                    voice: "alloy",
                    instructions: "Sound like a podcast host",
                    input: trimmedContent,
                    response_format: "mp3"
                });
                const buffer = Buffer.from(await ttsResponse.arrayBuffer());
                await fs.promises.writeFile(ttsFilePath, buffer);
                unpaddedAudioFilePaths.push(ttsFilePath);
                console.log(`[generateAudioFilesFromSegments] TTS segment saved to ${ttsFilePath}`);
            } catch (error) {
                console.error(`[generateAudioFilesFromSegments] Error generating TTS for segment ${i}:`, error);
            }
        } else if (segment.type === 'clip') {
            const rawClipPath = path.join(tempDir, `${baseFileName}_user_clip_raw.m4a`); // Assuming m4a or similar from GCS download
            let partSpecificAudioFilesGenerated = false;

            try {
                console.log(`[generateAudioFilesFromSegments] Downloading user clip from: ${segment.url} for response ID ${segment.responseId}`);
                const response = await fetch(segment.url);
                if (!response.ok) throw new Error(`Failed to download audio clip: ${response.statusText} (URL: ${segment.url})`);
                
                const audioBuffer = await response.buffer(); 
                await fs.promises.writeFile(rawClipPath, audioBuffer);
                console.log(`[generateAudioFilesFromSegments] User clip downloaded to ${rawClipPath}`);

                if (segment.word_timestamps && segment.word_timestamps.length > 0 && segment.quote && typeof segment.quote === 'string' && segment.quote.trim() !== "") {
                    const cleanedTranscriptWords = segment.word_timestamps.map(wt => ({ // Renamed for clarity
                        text: wt.word.replace(/[^a-zA-Z0-9']/g, "").toLowerCase(), // Clean here
                        start: wt.start,
                        end: wt.end
                    }));

                    const timecodesArray = findBestSubsegment(cleanedTranscriptWords, segment.quote);

                    if (timecodesArray && timecodesArray.length > 0) {
                        console.log(`[generateAudioFilesFromSegments] Matched ${timecodesArray.length} parts for quote ID ${segment.responseId}. Extracting each part.`);
                        for (let j = 0; j < timecodesArray.length; j++) {
                            const partTimecode = timecodesArray[j];
                            const partStartTime = partTimecode.start;
                            const partEndTime = partTimecode.end;
                            const partSpecificConvertedPath = path.join(tempDir, `${baseFileName}_user_clip_part_${j}.mp3`);

                            if (partEndTime <= partStartTime) {
                                console.warn(`[generateAudioFilesFromSegments] Invalid part timecode for quote ID ${segment.responseId}, part ${j}: start ${partStartTime}, end ${partEndTime}. Skipping this part.`);
                                continue;
                            }

                            await new Promise((resolve, reject) => {
                                const ffmpegCommandPart = ffmpeg(rawClipPath)
                                    .toFormat('mp3')
                                    .audioCodec('libmp3lame')
                                    .setStartTime(partStartTime)
                                    .setDuration(partEndTime - partStartTime);
                                
                                ffmpegCommandPart
                                    .on('error', (err) => {
                                        console.error(`[generateAudioFilesFromSegments] FFmpeg error extracting part ${j} for clip ${rawClipPath} (Response ID: ${segment.responseId}):`, err.message);
                                        reject(err);
                                    })
                                    .on('end', () => {
                                        console.log(`[generateAudioFilesFromSegments] Part ${j} of clip ${rawClipPath} (Response ID: ${segment.responseId}) extracted to ${partSpecificConvertedPath}`);
                                        unpaddedAudioFilePaths.push(partSpecificConvertedPath);
                                        resolve();
                                    })
                                    .save(partSpecificConvertedPath);
                            });
                        }
                        partSpecificAudioFilesGenerated = true;
                    } else {
                        console.warn(`[generateAudioFilesFromSegments] Could not accurately align quote for response ID ${segment.responseId} using findBestSubsegment. Using full clip.`);
                    }
                } else {
                    console.warn(`[generateAudioFilesFromSegments] No word timestamps or valid quote for response ID ${segment.responseId}. Using full clip.`);
                }

                if (!partSpecificAudioFilesGenerated) {
                    const fullConvertedClipPath = path.join(tempDir, `${baseFileName}_user_clip_full_converted.mp3`);
                    console.log(`[generateAudioFilesFromSegments] Processing full clip for response ID ${segment.responseId} as fallback.`);
                    await new Promise((resolve, reject) => {
                        ffmpeg(rawClipPath)
                            .toFormat('mp3')
                            .audioCodec('libmp3lame')
                            .on('error', (err) => {
                                console.error(`[generateAudioFilesFromSegments] FFmpeg error converting full clip ${rawClipPath} (Response ID: ${segment.responseId}):`, err.message);
                                reject(err);
                            })
                            .on('end', () => {
                                console.log(`[generateAudioFilesFromSegments] Full user clip ${rawClipPath} (Response ID: ${segment.responseId}) converted to MP3 at ${fullConvertedClipPath}`);
                                unpaddedAudioFilePaths.push(fullConvertedClipPath);
                                resolve();
                            })
                            .save(fullConvertedClipPath);
                    });
                }
                // Optionally delete rawClipPath here if no longer needed
                // try { await fs.promises.unlink(rawClipPath); } catch(e) { console.warn(`Could not delete raw clip ${rawClipPath}`); }

            } catch (error) {
                console.error(`[generateAudioFilesFromSegments] Error processing user clip ${segment.url} (Response ID: ${segment.responseId}):`, error);
            }
        }
    } // End of segment processing loop

    // Now, pad all collected unpadded files
    const finalPaddedFilePaths = [];
    console.log(`[generateAudioFilesFromSegments] Collected ${unpaddedAudioFilePaths.length} unpadded segments. Starting padding process.`);

    for (let i = 0; i < unpaddedAudioFilePaths.length; i++) {
        const unpaddedPath = unpaddedAudioFilePaths[i];
        const originalName = path.basename(unpaddedPath, path.extname(unpaddedPath)); // Get name without extension
        const paddedFilePath = path.join(tempDir, `${originalName}_padded.mp3`);
        
        try {
            // Check if unpaddedPath exists and is not empty before attempting to pad
            if (fs.existsSync(unpaddedPath) && fs.statSync(unpaddedPath).size > 0) {
                await padAudioFile(unpaddedPath, paddedFilePath);
                finalPaddedFilePaths.push(paddedFilePath);
            } else {
                console.warn(`[generateAudioFilesFromSegments] Unpadded file ${unpaddedPath} is missing or empty. Skipping its padding and inclusion.`);
            }
        } catch (padError) {
            console.error(`[generateAudioFilesFromSegments] Failed to pad ${unpaddedPath}. Error:`, padError.message);
            // Fallback: If padding fails, consider pushing the unpadded path, or skip.
            // Skipping is safer to prevent issues if the stitcher expects all files to be uniform (e.g., padded).
            // console.warn(`[generateAudioFilesFromSegments] Using unpadded file ${unpaddedPath} due to padding error.`);
            // finalPaddedFilePaths.push(unpaddedPath); // Or decide to not include it
        }
    }
    console.log(`[generateAudioFilesFromSegments] Finished padding. ${finalPaddedFilePaths.length} files ready for stitching.`);
    return finalPaddedFilePaths;
}

// --- Placeholder for stitchAudioFiles ---
async function stitchAudioFiles(audioFilePaths, finalOutputPath) {
    // All input files are expected to be MP3 now
    console.log(`[stitchAudioFiles] Stitching ${audioFilePaths.length} MP3 files into ${finalOutputPath}`);
    
    if (audioFilePaths.length === 0) {
        throw new Error("No audio files to stitch.");
    }

    const tempMergePath = path.join(os.tmpdir(), `temp_merged_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.mp3`);
    console.log(`[stitchAudioFiles] Intermediate merge path: ${tempMergePath}`);

    return new Promise((resolve, reject) => {
        const mergeCommand = ffmpeg();
        let validInputsCount = 0;

        audioFilePaths.forEach(filePath => {
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
                mergeCommand.input(filePath);
                validInputsCount++;
            } else {
                // console.warn(`[stitchAudioFiles] Skipping missing or empty file for merge: ${filePath}`);
                // The edit model duplicated this line, removing one.
                console.warn(`[stitchAudioFiles] Skipping missing or empty file for merge: ${filePath}`);
            }
        });
        
        if (validInputsCount === 0) { 
            // Clean up tempMergePath if it was created but no valid inputs found (though unlikely to be created yet here)
            // fs.unlink(tempMergePath, () => {}); // No need, as mergeToFile won't run
            return reject(new Error("No valid audio files to merge after checking existence/size."));
        }

        mergeCommand
            .on('error', (err) => {
                console.error('[stitchAudioFiles] FFmpeg initial merge error:', err.message);
                // No temp file to clean up if mergeCommand itself errors before .mergeToFile is called or finishes
                reject(err);
            })
            .on('end', async () => { // Make this callback async
                console.log(`[stitchAudioFiles] Initial merge to ${tempMergePath} successful.`);
                
                // Check if the temporary merged file was actually created and is not empty
                if (!fs.existsSync(tempMergePath) || fs.statSync(tempMergePath).size === 0) {
                    console.error(`[stitchAudioFiles] Temporary merged file ${tempMergePath} is missing or empty after initial merge.`);
                    return reject(new Error(`Temporary merged file ${tempMergePath} is missing or empty.`));
                }

                // Now apply silenceremove to the merged file
                console.log(`[stitchAudioFiles] Applying silence removal from ${tempMergePath} to ${finalOutputPath}`);
                ffmpeg(tempMergePath) // Input is the successfully merged temporary file
                    .toFormat('mp3') // Ensure output format is mp3
                    .on('error', (err) => {
                        console.error('[stitchAudioFiles] FFmpeg silenceremove error:', err.message);
                        // Clean up tempMergePath before rejecting
                        fs.unlink(tempMergePath, (unlinkErr) => {
                            if (unlinkErr) console.error(`[stitchAudioFiles] Error deleting temp merge file ${tempMergePath} after silenceremove error:`, unlinkErr.message);
                            reject(err); // Reject with the main silenceremove error
                        });
                    })
                    .on('end', () => {
                        console.log(`[stitchAudioFiles] Silence removal successful. Final output at ${finalOutputPath}`);
                        // Clean up tempMergePath after successful silence removal and saving to finalOutputPath
                        fs.unlink(tempMergePath, (unlinkErr) => {
                            if (unlinkErr) console.error(`[stitchAudioFiles] Error deleting temp merge file ${tempMergePath} after success:`, unlinkErr.message);
                            resolve(finalOutputPath);
                        });
                    })
                    .save(finalOutputPath);
            })
            .mergeToFile(tempMergePath, os.tmpdir()); // Merge to the temporary path
    });
}
// levenshteinDistance is now imported from server/utils/video.js

// findBestSubsegment is now imported from server/utils/video.js

// generateVideoFilesFromSegments is now imported from server/utils/video.js


// generateAndStoreReportVideo is now imported from server/utils/video.js

// --- NEW: Function to Generate and Store Report Audio ---
async function generateAndStoreReportAudio(reportId, reportText, responsesWithTimestamps, db, storage, gcsBucketName, openaiClient) {
    let tempDirPath = null;
    console.log(`[generateAndStoreReportAudio ${reportId}] Starting audio generation for report.`);

    try {
        if (!reportText || reportText.trim() === '') {
            console.warn(`[generateAndStoreReportAudio ${reportId}] Report content is empty. Skipping audio generation.`);
            return null; // Or throw an error if audio is mandatory
        }

        tempDirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), `report-audio-${reportId}-`));
        console.log(`[generateAndStoreReportAudio ${reportId}] Created temp directory: ${tempDirPath}`);

        // Note: responsesWithTimestamps should already be fetched by the caller (e.g., generateReport or the audio artifact endpoint)
        // It needs to be an array of objects, each potentially having 'id', 'audio_signed_url', and 'word_timestamps'.
        // We'll create the responseIdToAudioDataMap here.
        const responseIdToAudioDataMap = {};
        if (responsesWithTimestamps && responsesWithTimestamps.length > 0) {
            responsesWithTimestamps.forEach(response => {
                if (response.id) { // Ensure response.id is valid
                    responseIdToAudioDataMap[response.id] = {
                        url: response.audio_signed_url, // This should be the signed URL for downloading
                        word_timestamps: response.word_timestamps
                    };
                }
            });
        }
        console.log(`[generateAndStoreReportAudio ${reportId}] Created mapping for ${Object.keys(responseIdToAudioDataMap).length} response IDs to audio data.`);

        const segments = await parseReportAndPrepareAudioSegments(reportText, responseIdToAudioDataMap);
        if (!segments || segments.length === 0) {
            console.warn(`[generateAndStoreReportAudio ${reportId}] No segments found in report text. Skipping audio generation.`);
            // Clean up temp dir if created
            if (tempDirPath) {
                await fs.promises.rm(tempDirPath, { recursive: true, force: true });
            }
            return null;
        }

        const individualAudioFiles = await generateAudioFilesFromSegments(segments, openaiClient, tempDirPath);
        // if (!individualAudioFiles || individualAudioFiles.length === 0) {
        //     console.warn(`[generateAndStoreReportAudio ${reportId}] No individual audio files were generated.`);
        //     // If only the tag should play, this might not be an error. Let's proceed.
        // }

        const tagFilePath = path.join(__dirname, 'public', 'tag.mp3');
        const finalFilesToStitch = [];

        if (fs.existsSync(tagFilePath)) {
            const tempTagPath = path.join(tempDirPath, 'tag_prepended.mp3');
            try {
                await fs.promises.copyFile(tagFilePath, tempTagPath);
                finalFilesToStitch.push(tempTagPath);
            } catch (copyError) {
                console.error(`[generateAndStoreReportAudio ${reportId}] Error copying tag.mp3:`, copyError);
            }
        }

        if (individualAudioFiles && individualAudioFiles.length > 0) {
            finalFilesToStitch.push(...individualAudioFiles);
        }

        if (finalFilesToStitch.length === 0) {
            console.warn(`[generateAndStoreReportAudio ${reportId}] No audio files (including tag) to stitch. Skipping audio generation.`);
            if (tempDirPath) {
                await fs.promises.rm(tempDirPath, { recursive: true, force: true });
            }
            return null;
        }

        const finalArtifactPath = path.join(tempDirPath, 'final_report_audio.mp3');
        await stitchAudioFiles(finalFilesToStitch, finalArtifactPath);
        console.log(`[generateAndStoreReportAudio ${reportId}] Final audio artifact created at: ${finalArtifactPath}`);

        // Upload to GCS
        if (storage && gcsBucketName) {
            const bucket = storage.bucket(gcsBucketName);
            const audioFileName = `reports_audio/${reportId}/report_audio_${Date.now()}.mp3`;
            
            console.log(`[generateAndStoreReportAudio ${reportId}] Uploading artifact to GCS: gs://${gcsBucketName}/${audioFileName}`);
            
            await bucket.upload(finalArtifactPath, {
                destination: audioFileName,
                metadata: { contentType: 'audio/mpeg' },
                resumable: true,
                timeout: 300000, // 5 minute timeout
                validation: false // Skip MD5 validation for faster uploads
            });
            const gcsAudioUrl = `gs://${gcsBucketName}/${audioFileName}`;
            console.log(`[generateAndStoreReportAudio ${reportId}] Audio artifact uploaded to GCS: ${gcsAudioUrl}`);
            
            // Cleanup temp directory after successful upload
            if (tempDirPath) {
                await fs.promises.rm(tempDirPath, { recursive: true, force: true });
                console.log(`[generateAndStoreReportAudio ${reportId}] Cleaned up temp directory: ${tempDirPath}`);
            }
            return gcsAudioUrl;
        } else {
            console.error(`[generateAndStoreReportAudio ${reportId}] GCS storage or bucket name not configured. Cannot upload.`);
            // Cleanup temp directory even if upload fails
            if (tempDirPath) {
                await fs.promises.rm(tempDirPath, { recursive: true, force: true });
            }
            return null;
        }

    } catch (error) {
        console.error(`[generateAndStoreReportAudio ${reportId}] Error:`, error);
        if (tempDirPath) {
            try {
                await fs.promises.rm(tempDirPath, { recursive: true, force: true });
                console.log(`[generateAndStoreReportAudio ${reportId}] Cleaned up temp directory after error: ${tempDirPath}`);
            } catch (cleanupError) {
                console.error(`[generateAndStoreReportAudio ${reportId}] Error cleaning up temp directory after main error:`, cleanupError);
            }
        }
        throw error; // Re-throw the error to be handled by the caller
    }
}
// --- END NEW Function ---

// --- NEW: API Endpoint for Synthesis Audio Artifact ---
app.get('/api/syntheses/:synthesisId/audio-artifact', async (req, res) => {
    const { synthesisId } = req.params;
    const { templateId } = req.query; // templateId will be needed to find the synthesis in Firestore
    const forceRegenerate = req.query.generate === 'true'; // Changed from force_regenerate to generate

    console.log(`[API /api/syntheses/${synthesisId}/audio-artifact] Request. Template: ${templateId}, Generate: ${forceRegenerate}`);

    if (!db || !storage || !GCS_BUCKET_NAME || !openai) {
        console.error(`[API Synthesis Audio ${synthesisId}] Service unavailable (DB, Storage, OpenAI, or Bucket).`);
        return res.status(503).json({ error: 'Core services unavailable.' });
    }
    if (!templateId || !synthesisId) {
        return res.status(400).json({ error: 'Missing templateId or synthesisId.' });
    }

    try {
        const synthesisDocRef = db.collection('interviews').doc(templateId).collection('groupSyntheses').doc(synthesisId);
        const synthesisDoc = await synthesisDocRef.get();

        if (!synthesisDoc.exists) {
            return res.status(404).json({ error: 'Group synthesis not found.' });
        }
        const synthesisData = synthesisDoc.data();

        let audioGcsUrl = synthesisData.audioGcsUrl;
        const synthesisText = synthesisData.content;
        const reportIdsForSynthesis = synthesisData.contributingReportIds; // Get the stored report IDs

        if (audioGcsUrl && !forceRegenerate) {
            console.log(`[API Synthesis Audio ${synthesisId}] Existing audio GCS URL found: ${audioGcsUrl}.`);
        } else {
            console.log(`[API Synthesis Audio ${synthesisId}] Generating new audio. Force: ${forceRegenerate}`);
            if (!synthesisText || synthesisText.trim() === '') {
                return res.status(400).json({ error: 'Synthesis content is empty, cannot generate audio.' });
            }

            let comprehensiveResponsesForAudio = [];
            if (reportIdsForSynthesis && reportIdsForSynthesis.length > 0) {
                console.log(`[API Synthesis Audio ${synthesisId}] Found ${reportIdsForSynthesis.length} contributing reports. Fetching their Q&A details.`);
                const allResponsesPromises = reportIdsForSynthesis.map(reportId => 
                    getResponsesWithSignedUrls(reportId, db, storage, GCS_BUCKET_NAME)
                );
                const nestedResponsesArray = await Promise.all(allResponsesPromises);
                comprehensiveResponsesForAudio = nestedResponsesArray.flat(); // Flatten the array of arrays
                console.log(`[API Synthesis Audio ${synthesisId}] Fetched a total of ${comprehensiveResponsesForAudio.length} Q&A pairs from contributing reports.`);
            } else {
                console.warn(`[API Synthesis Audio ${synthesisId}] No contributingReportIds found in synthesis document. Audio will be TTS only for the synthesis text.`);
            }
            
            audioGcsUrl = await generateAndStoreReportAudio(
                synthesisId, 
                synthesisText,
                comprehensiveResponsesForAudio, // Pass the fully populated Q&A data
                db, storage, GCS_BUCKET_NAME, openai,
                true 
            );

            if (audioGcsUrl) {
                await synthesisDocRef.update({ 
                    audioGcsUrl: audioGcsUrl,
                    audioGenerated: true,
                    audioGeneratedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`[API Synthesis Audio ${synthesisId}] New audio stored. GCS URL: ${audioGcsUrl}`);
            } else {
                throw new Error('Synthesis audio generation failed to return a GCS URL.');
            }
        }

        if (audioGcsUrl) {
            const match = audioGcsUrl.match(/^gs:\/\/([^\/]+)\/(.+)$/);
            if (match) {
                const bucketName = match[1];
                const filePath = match[2];
                const signedUrlOptions = { version: 'v4', action: 'read', expires: Date.now() + 15 * 60 * 1000 };
                const [signedRedirectUrl] = await storage.bucket(bucketName).file(filePath).getSignedUrl(signedUrlOptions);
                
                const gcsResponse = await fetch(signedRedirectUrl);
                if (!gcsResponse.ok) {
                    throw new Error(`Failed to fetch audio from GCS: ${gcsResponse.status} ${gcsResponse.statusText}`);
                }
                res.setHeader('Content-Type', 'audio/mpeg');
                gcsResponse.body.pipe(res);
            } else {
                throw new Error('Invalid audio GCS URL format in Firestore.');
            }
        } else {
            return res.status(404).json({ error: 'Synthesis audio not found or generation failed.' });
        }

    } catch (error) {
        console.error(`[API Synthesis Audio ${synthesisId}] Error:`, error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to process synthesis audio request.', details: error.message });
        }
    }
});
// --- END NEW ENDPOINT ---

// --- NEW: API Endpoint for Admin\'s Personal Interview Sessions ---
app.get('/api/admin/my-sessions', async (req, res) => {
    // TODO: Add authentication middleware to ensure req.user.email is populated and secure
    // For now, we\'ll assume req.user.email is available for a logged-in admin.
    // const adminEmail = req.user?.email; // Example: if using Firebase Auth middleware

    // TEMPORARY: For development without full auth, allow passing email via query. REMOVE IN PRODUCTION.
    const adminEmail = req.query.email; 
    if (!adminEmail) {
        // return res.status(401).json({ error: 'Authentication required.' }); // Uncomment when auth is ready
        return res.status(400).json({ error: 'Admin email is required for this demo endpoint.' }); // Temporary
    }

    if (!db) {
        return res.status(503).json({ error: 'Firebase service unavailable' });
    }

    try {
        console.log(`[API /api/admin/my-sessions] Fetching sessions for admin: ${adminEmail}`);
        const reportsSnapshot = await db.collection('reports')
            .where('user_email', '==', adminEmail) // Assuming reports store the interviewee\'s email
            .orderBy('start_timestamp', 'desc')   // Get newest first
            .limit(50) // Limit results for now
            .get();

        if (reportsSnapshot.empty) {
            console.log(`[API /api/admin/my-sessions] No sessions found for admin: ${adminEmail}`);
            return res.json([]); // Return empty array if no sessions found
        }

        const mySessions = [];
        for (const doc of reportsSnapshot.docs) {
            const data = doc.data();
            let templateTitle = data.report_title || 'Untitled Session'; // Fallback title

            // If we have an interview_id, try to fetch the template's actual title
            if (data.interview_id) {
                try {
                    const interviewDoc = await db.collection('interviews').doc(data.interview_id).get();
                    if (interviewDoc.exists) {
                        templateTitle = interviewDoc.data().title || templateTitle;
                    }
                } catch (templateError) {
                    console.warn(`[API /api/admin/my-sessions] Error fetching template title for interview_id ${data.interview_id}:`, templateError.message);
                }
            }
            
            mySessions.push({
                reportId: doc.id, // This is the persistent_session_id
                interviewId: data.interview_id || null,
                sessionTitle: templateTitle, // Use the fetched or derived title
                startTimestamp: data.start_timestamp ? data.start_timestamp.toDate().toISOString() : null,
                status: data.status || 'Unknown',
                totalRecordingDuration: data.total_recording_duration || 0, // Add recording duration
                // Add any other relevant fields you might want to display
                // e.g., totalWordCount: data.total_word_count
            });
        }
        console.log(`[API /api/admin/my-sessions] Found ${mySessions.length} sessions for admin: ${adminEmail}`);
        res.json(mySessions);

    } catch (error) {
        console.error(`[API /api/admin/my-sessions] Error fetching sessions for admin ${adminEmail}:`, error);
        res.status(500).json({ error: 'Failed to fetch admin sessions', details: error.message });
    }
});
// --- END NEW ADMIN SESSIONS ENDPOINT ---

// --- NEW: API Endpoint to Regenerate User-Facing Report --- 
app.post('/api/reports/:reportId/regenerate-user-report', optionalAuth, async (req, res) => {
    const { reportId } = req.params;
    console.log(`[API /api/reports/${reportId}/regenerate-user-report] Request received.`);
    
    // Log request details to debug user context
    console.log(`[API RegenerateUserReport ${reportId}] Request details:`, {
        hasAuthHeader: !!req.headers.authorization,
        hasSession: !!req.session,
        sessionUserId: req.session?.userId,
        headerUserId: req.headers['x-user-id']
    });

    if (!db || !storage || !GCS_BUCKET_NAME || !openai || !CLAUDE_API_KEY) {
        console.error(`[API RegenerateUserReport ${reportId}] Core service unavailable.`);
        return res.status(503).json({ error: 'Core services (DB, Storage, OpenAI, Claude API Key, GCS Bucket) unavailable.' });
    }

    try {
        const reportDocRef = db.collection('reports').doc(reportId);
        const reportDoc = await reportDocRef.get();

        if (!reportDoc.exists) {
            console.warn(`[API RegenerateUserReport ${reportId}] Report not found.`);
            return res.status(404).json({ error: 'Report not found' });
        }
        const reportData = reportDoc.data();

        // 1. Fetch Q&A pairs
        console.log(`[API RegenerateUserReport ${reportId}] Fetching Q&A pairs...`);
        const qaPairs = await getResponsesWithSignedUrls(reportId, db, storage, GCS_BUCKET_NAME);
        if (!qaPairs || qaPairs.length === 0) {
            console.warn(`[API RegenerateUserReport ${reportId}] No Q&A pairs found for this report. Cannot regenerate.`);
            return res.status(400).json({ error: 'No Q&A pairs found for this report to regenerate.' });
        }
        let qaXml = '';
        qaPairs.forEach(pair => {
            qaXml += `<qa_pair>\n`;
            qaXml += `  <question>${escapeXml(pair.question)}</question>\n`;
            // User reports don't include audio, so no audio_response_id needed
            qaXml += `  <answer>${escapeXml(pair.answer)}</answer>\n`;
            qaXml += `</qa_pair>\n\n`;
        });

        // 2. Determine Report Prompt and Context Data
        let customReportPrompt = null;
        let contextForPrompt = 'Context not provided'; // Default context

        if (reportData.interview_id) {
            console.log(`[API RegenerateUserReport ${reportId}] Fetching interview template: ${reportData.interview_id}`);
            const interviewTemplateDoc = await db.collection('interviews').doc(reportData.interview_id).get();
            if (interviewTemplateDoc.exists) {
                const interviewTemplateData = interviewTemplateDoc.data();
                customReportPrompt = interviewTemplateData.reportPrompt;
                
                // Reconstruct admin context from template files
                if (interviewTemplateData.contextFiles && Array.isArray(interviewTemplateData.contextFiles) && interviewTemplateData.contextFiles.length > 0) {
                    let adminContextText = '';
                    const fileProcessingPromises = interviewTemplateData.contextFiles.map(async (fileData) => {
                        if (!fileData || !fileData.path) return null;
                        const filePath = fileData.path;
                        const fileName = fileData.name || path.basename(filePath);
                        const fileType = fileData.type || path.extname(filePath);
                        
                        // Check if content is stored directly (text-only files)
                        if (fileData.content) {
                            console.log(`[API RegenerateUserReport ${reportId}] Using inline text content for ${fileName}`);
                            return { fileName, text: fileData.content };
                        }
                        
                        try {
                            const downloadResponse = await storage.bucket(GCS_BUCKET_NAME).file(filePath).download();
                            const buffer = downloadResponse[0];
                            const extractedText = await extractTextFromFileBuffer(buffer, fileType, fileName);
                            return { fileName, text: extractedText };
                        } catch (error) {
                            console.error(`[API RegenerateUserReport ${reportId}] Failed to process context file ${fileName} from template:`, error);
                            return { fileName, error: `Failed to process: ${error.message}` };
                        }
                    });
                    const results = await Promise.allSettled(fileProcessingPromises);
                    results.forEach(result => {
                        if (result.status === 'fulfilled' && result.value) {
                            const { fileName, text, error } = result.value;
                            if (error) adminContextText += `\n\n--- Document: ${fileName} ---\n[Error processing this document: ${error}]\n\n`;
                            else if (text) adminContextText += `\n\n--- Document: ${fileName} ---\n${text}\n\n`;
                            else adminContextText += `\n\n--- Document: ${fileName} ---\n[Unsupported file type or no text extracted]\n\n`;
                        }
                    });
                    if (adminContextText.trim() !== '') {
                        contextForPrompt = `--- Admin Provided Context ---\n${adminContextText.trim()}\n\n--- End Admin Provided Context ---`;
                    }
                    console.log(`[API RegenerateUserReport ${reportId}] Reconstructed admin context from template. Length: ${contextForPrompt.length}`);
                }
            }
        }
        
        // Fallback or default report prompt if not found from template
        const finalReportPromptSystem = customReportPrompt ? 
            customReportPrompt
                .replace('{{CONTEXT}}', contextForPrompt) 
                .replace('{{QA_CONTENT}}', qaXml)
                .replace('{{RESUME}}', contextForPrompt) // Also replace RESUME for older prompts
            : 
            // Default prompt (same as in generateReport)
            `You are an AI career coach specializing in preparing professionals for the "intelligence age" - an era dominated by artificial intelligence and rapid technological advancements. Your task is to create a personalized, engaging "Personal AI Readiness Report" (PAIRR) that assesses how prepared an individual is to thrive in an AI-transformed workplace.

First, carefully review the following information:
<context>
${contextForPrompt}
</context>
<qa_content>
${qaXml} 
</qa_content>

Within the <qa_content>, each interviewee answer is in an <answer> tag containing their response.

Your generated report should be structured as a narrative. When you incorporate direct quotes from the interviewee (from the <answer> tags in <qa_content>), integrate them naturally into your analysis.

THEORY OF CHANGE:
To thrive in the AI age, people need to invest in three critical areas:
`;

        // Build messages with prompt caching
        const messages = [{
            role: "user",
            content: [
                {
                    type: "text",
                    text: finalReportPromptSystem,
                    cache_control: {"type": "ephemeral"}}

            ]
        }];

        console.log(`[API RegenerateUserReport ${reportId}] Sending request to Claude for report regeneration...`);

        // 3. Call Claude API
        const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": CLAUDE_API_KEY,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: "claude-opus-4-6",
                max_tokens: 15000,
                messages: messages, // Pass the constructed system prompt as user message here
                thinking: {
                    "type": "enabled",
                    "budget_tokens": 10000
                },
                system: REPORT_GENERATION_SYSTEM_PROMPT
                // No streaming for this direct regeneration, get full response
            })
        });

        if (!claudeResponse.ok) {
            const errorData = await claudeResponse.text();
            console.error(`[API RegenerateUserReport ${reportId}] Claude API error:`, errorData);
            throw new Error('Failed to generate report from Claude API: ' + errorData);
        }

        const claudeResult = await claudeResponse.json();
        console.log(`[API RegenerateUserReport ${reportId}] Full Claude API JSON response:`, JSON.stringify(claudeResult, null, 2));

        let newReportContent = 'Error: Could not extract report from AI response.';
        const textBlock = claudeResult.content?.find(block => block.type === 'text');

        if (textBlock && textBlock.text) {
            const rawClaudeText = textBlock.text;
            console.log(`[API RegenerateUserReport ${reportId}] Raw text from Claude (found text block):`, rawClaudeText);
            newReportContent = rawClaudeText; // Use raw text first

            // Try to extract from <individual_summary_report> first, then <final_report>
            let finalReportMatch = rawClaudeText.match(/<individual_summary_report>([\s\S]*?)<\/individual_summary_report>/i);
            if (finalReportMatch && finalReportMatch[1]) {
                newReportContent = finalReportMatch[1].trim();
                console.log(`[API RegenerateUserReport ${reportId}] Text after <individual_summary_report> tag extraction:`, newReportContent);
            } else {
                console.log(`[API RegenerateUserReport ${reportId}] <individual_summary_report> tags not found. Trying <final_report>...`);
                finalReportMatch = rawClaudeText.match(/<final_report>([\s\S]*?)<\/final_report>/i);
                if (finalReportMatch && finalReportMatch[1]) {
                    newReportContent = finalReportMatch[1].trim();
                    console.log(`[API RegenerateUserReport ${reportId}] Text after <final_report> tag extraction:`, newReportContent);
                } else {
                    console.log(`[API RegenerateUserReport ${reportId}] Neither <individual_summary_report> nor <final_report> tags found. Using raw text from Claude's text block.`);
                }
            }
        } else {
            console.warn(`[API RegenerateUserReport ${reportId}] No text block found in Claude's response content or text block is empty. Claude result content:`, claudeResult.content);
        }
        console.log(`[API RegenerateUserReport ${reportId}] Final newReportContent to be saved. Length: ${newReportContent.length}`);

        // 4. Update Firestore
        const updateData = {
            report_content: newReportContent,
            status: 'regenerated', // Or 'completed-regenerated'
            end_timestamp: admin.firestore.FieldValue.serverTimestamp(), // Update timestamp
            // audio_gcs_url: null // Optionally clear old audio URL to trigger regeneration on next access
        };
        await reportDocRef.update(updateData);
        console.log(`[API RegenerateUserReport ${reportId}] Report document updated in Firestore.`);
        
        // 5. Audio generation removed for user reports
        // User reports are text-only - no audio URL clearing needed

        // 6. Video generation removed for user reports
        // User reports are text-only

        // 7. Send email notification for regenerated report
        if (reportData.user_email || reportData.userEmail) {
            const userEmail = reportData.user_email || reportData.userEmail;
            const userName = reportData.user_name || reportData.userName || 'User';
            const reportTitle = reportData.report_title || 'Your Updated Report';
            const interviewId = reportData.interview_id;
            
            console.log(`[API RegenerateUserReport ${reportId}] Sending updated report email to ${userEmail}`);
            
            // Send email asynchronously (don't block the response)
            // Use authenticated user if available, otherwise fall back to report's created_by
            const emailUserId = req.user?.uid || reportData.created_by;
            console.log(`[API RegenerateUserReport ${reportId}] Email user context:`, {
                authenticatedUserId: req.user?.uid,
                reportCreatedBy: reportData.created_by,
                usingUserId: emailUserId
            });
            
            sendReportEmail(
                userEmail,
                userName,
                newReportContent,
                reportTitle,
                reportId,
                interviewId,
                reportData.socket_session_id || reportData.session_id, // Include session ID if available
                emailUserId // Pass the user ID for Gmail integration
            ).catch(emailError => {
                console.error(`[API RegenerateUserReport ${reportId}] Email sending failed:`, emailError);
                // Don't throw error here - email failure shouldn't break report regeneration
            });
        } else {
            console.warn(`[API RegenerateUserReport ${reportId}] No user email found in report data. Skipping regeneration email send.`);
        }

        res.json({ 
            message: 'User-facing report regenerated successfully.', 
            reportId: reportId, 
            newReportContent: newReportContent 
        });

    } catch (error) {
        console.error(`[API RegenerateUserReport ${reportId}] Error:`, error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to regenerate user report.', details: error.message });
        }
    }
});
// --- END NEW ENDPOINT ---

// --- NEW: API Endpoint to Regenerate Admin Report ---
// Get audio clip URL by response ID
app.get('/api/audio-clip/:responseId', async (req, res) => {
    const { responseId } = req.params;
    const { trimmed } = req.query;
    
    console.log('[API /api/audio-clip] Request for response ID:', responseId, 'trimmed:', trimmed);
    
    if (!db || !storage || !GCS_BUCKET_NAME) {
        console.error('[API /api/audio-clip] Missing services:', {
            db: !!db,
            storage: !!storage,
            GCS_BUCKET_NAME: !!GCS_BUCKET_NAME
        });
        return res.status(503).json({ 
            error: 'Storage services unavailable',
            details: {
                hasDb: !!db,
                hasStorage: !!storage,
                hasBucket: !!GCS_BUCKET_NAME
            }
        });
    }
    
    try {
        console.log('[API /api/audio-clip] Starting search for response ID:', responseId);
        
        // Most efficient approach: Try collection group query first
        // This requires that responses have their ID stored as a field
        console.log('[API /api/audio-clip] Attempting collection group query...');
        
        let audioUrl = null;
        let trimmedUrl = null;
        let responseText = null;
        let responseData = null;
        let foundInReport = null;
        
        try {
            // Try collection group query if responses have 'response_id' field
            const collectionGroupQuery = db.collectionGroup('responses')
                .where('response_id', '==', responseId)
                .limit(1);
                
            const collectionGroupSnapshot = await collectionGroupQuery.get();
            
            if (!collectionGroupSnapshot.empty) {
                const doc = collectionGroupSnapshot.docs[0];
                responseData = doc.data();
                // Extract report ID from the document path
                const pathSegments = doc.ref.path.split('/');
                foundInReport = pathSegments[pathSegments.indexOf('reports') + 1];
                console.log('[API /api/audio-clip] Found via collection group query in report:', foundInReport);
            }
        } catch (error) {
            console.log('[API /api/audio-clip] Collection group query failed:', error.message);
            console.log('[API /api/audio-clip] This likely means the response_id field is not indexed or does not exist');
        }
        
        // If collection group didn't work, fall back to efficient parallel search
        if (!responseData) {
            console.log('[API /api/audio-clip] Collection group query unsuccessful, using parallel search...');
            
            // First, check recent reports (most likely to contain the audio)
            const recentReportsSnapshot = await db.collection('reports')
                .orderBy('start_timestamp', 'desc')
                .limit(50)
                .get();
                
            console.log('[API /api/audio-clip] Checking', recentReportsSnapshot.size, 'recent reports...');
            
            // Check all recent reports in parallel
            const checks = recentReportsSnapshot.docs.map(async (reportDoc) => {
                try {
                    const responseDoc = await db.collection('reports')
                        .doc(reportDoc.id)
                        .collection('responses')
                        .doc(responseId)
                        .get();
                        
                    if (responseDoc.exists) {
                        return {
                            found: true,
                            reportId: reportDoc.id,
                            data: responseDoc.data()
                        };
                    }
                } catch (err) {
                    // Ignore individual errors
                }
                return { found: false };
            });
            
            const results = await Promise.all(checks);
            const found = results.find(r => r.found);
            
            if (found) {
                console.log('[API /api/audio-clip] Found in recent report:', found.reportId);
                responseData = found.data;
                foundInReport = found.reportId;
            } else {
                // Last resort: check all remaining reports
                console.log('[API /api/audio-clip] Not in recent reports, checking all...');
                
                const allReportsSnapshot = await db.collection('reports').get();
                const remainingReports = allReportsSnapshot.docs.filter(doc => 
                    !recentReportsSnapshot.docs.some(recent => recent.id === doc.id)
                );
                
                console.log('[API /api/audio-clip] Checking', remainingReports.length, 'additional reports...');
                
                // Check in batches to avoid overwhelming the system
                const batchSize = 20;
                for (let i = 0; i < remainingReports.length && !responseData; i += batchSize) {
                    const batch = remainingReports.slice(i, i + batchSize);
                    const batchChecks = batch.map(async (reportDoc) => {
                        try {
                            const responseDoc = await db.collection('reports')
                                .doc(reportDoc.id)
                                .collection('responses')
                                .doc(responseId)
                                .get();
                                
                            if (responseDoc.exists) {
                                return {
                                    found: true,
                                    reportId: reportDoc.id,
                                    data: responseDoc.data()
                                };
                            }
                        } catch (err) {
                            // Ignore individual errors
                        }
                        return { found: false };
                    });
                    
                    const batchResults = await Promise.all(batchChecks);
                    const found = batchResults.find(r => r.found);
                    
                    if (found) {
                        console.log('[API /api/audio-clip] Found in report:', found.reportId);
                        responseData = found.data;
                        foundInReport = found.reportId;
                        break;
                    }
                }
            }
        }
        
        if (responseData) {
            console.log('[API /api/audio-clip] Response data:', { 
                reportId: foundInReport,
                has_audio: responseData.has_audio, 
                audio_url: responseData.audio_url ? 'present' : 'missing',
                audio_gcs_url: responseData.audio_gcs_url ? 'present' : 'missing'
            });
        }
        
        // Process the response data if found
        if (responseData) {
            responseText = responseData.answer;
            console.log('[API /api/audio-clip] Response data fields:', Object.keys(responseData));
            
            // Check for audio URL in different possible fields
            const audioPath = responseData.audio_url || responseData.audio_gcs_url;
            console.log('[API /api/audio-clip] Audio path:', audioPath ? audioPath.substring(0, 50) + '...' : 'not found');
            
            if (audioPath) {
                console.log('[API /api/audio-clip] Processing audio path:', audioPath);
                
                // Check if it's a GCS URI (gs://bucket/path) or just a filename
                const gcsMatch = audioPath.match(/^gs:\/\/([^\/]+)\/(.+)$/);
                
                if (gcsMatch) {
                    // It's a full GCS URI
                    const bucketName = gcsMatch[1];
                    const filePath = gcsMatch[2];
                    console.log('[API /api/audio-clip] GCS URI detected - bucket:', bucketName, 'path:', filePath);
                    
                    try {
                        const bucket = storage.bucket(bucketName);
                        const file = bucket.file(filePath);
                        const [signedUrl] = await file.getSignedUrl({
                            version: 'v4',
                            action: 'read',
                            expires: Date.now() + 60 * 60 * 1000, // 1 hour
                        });
                        audioUrl = signedUrl;
                        console.log('[API /api/audio-clip] Generated signed URL successfully');
                    } catch (urlError) {
                        console.error('[API /api/audio-clip] Error generating signed URL:', urlError);
                        throw new Error(`Failed to generate signed URL: ${urlError.message}`);
                    }
                } else {
                    // It's just a filename - use default bucket
                    console.log('[API /api/audio-clip] Simple filename detected:', audioPath);
                    const fileName = audioPath.split('/').pop();
                    try {
                        const file = storage.bucket(GCS_BUCKET_NAME).file(fileName);
                        const [signedUrl] = await file.getSignedUrl({
                            version: 'v4',
                            action: 'read',
                            expires: Date.now() + 60 * 60 * 1000, // 1 hour
                        });
                        audioUrl = signedUrl;
                        console.log('[API /api/audio-clip] Generated signed URL successfully');
                    } catch (urlError) {
                        console.error('[API /api/audio-clip] Error generating signed URL:', urlError);
                        throw new Error(`Failed to generate signed URL: ${urlError.message}`);
                    }
                }
                
                // If trimming is requested, apply simple trimming logic
                if (trimmed === 'true' && responseText) {
                    // For now, return the same URL - trimming will be implemented later
                    trimmedUrl = audioUrl;
                    
                    // TODO: Implement actual trimming logic here
                    // 1. Download the audio file
                    // 2. Detect silence at start/end
                    // 3. Trim the audio
                    // 4. Upload trimmed version
                    // 5. Return trimmed URL
                }
            }
        }
        
        if (!audioUrl) {
            return res.status(404).json({ error: 'Audio clip not found' });
        }
        
        res.json({ 
            audioUrl,
            trimmedUrl: trimmedUrl || audioUrl,
            text: responseText
        });
        
    } catch (error) {
        console.error('[API /api/audio-clip] Error:', error);
        console.error('[API /api/audio-clip] Error stack:', error.stack);
        res.status(500).json({ 
            error: 'Failed to fetch audio clip',
            message: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Create audio summary from analyst message
app.post('/api/create-audio-summary', async (req, res) => {
    const { audioClips, fullText, interviewId, threadId } = req.body;
    
    console.log('[API /api/create-audio-summary] Request received with', audioClips.length, 'clips');
    
    if (!audioClips || audioClips.length === 0) {
        return res.status(400).json({ error: 'No audio clips provided' });
    }
    
    if (!db || !storage || !GCS_BUCKET_NAME || !openai) {
        return res.status(503).json({ error: 'Required services unavailable' });
    }
    
    try {
        // Parse the full text to create segments with placeholders for audio clips
        let textSegments = [];
        let lastIndex = 0;
        
        // Create a map of audio clips by their content for easy lookup
        const clipMap = new Map(audioClips.map(clip => [clip.content, clip]));
        
        // Split the text around the audio clips
        audioClips.forEach(clip => {
            const clipIndex = fullText.indexOf(clip.content, lastIndex);
            if (clipIndex !== -1) {
                // Add text before the clip
                if (clipIndex > lastIndex) {
                    const textBefore = fullText.substring(lastIndex, clipIndex).trim();
                    if (textBefore) {
                        textSegments.push({ type: 'text', content: textBefore });
                    }
                }
                // Add the clip
                textSegments.push({ type: 'audio', clipId: clip.id, content: clip.content });
                lastIndex = clipIndex + clip.content.length;
            }
        });
        
        // Add any remaining text after the last clip
        if (lastIndex < fullText.length) {
            const remainingText = fullText.substring(lastIndex).trim();
            if (remainingText) {
                textSegments.push({ type: 'text', content: remainingText });
            }
        }
        
        // Generate TTS for text segments and collect audio URLs
        const audioSegments = [];
        
        for (const segment of textSegments) {
            if (segment.type === 'text') {
                // Generate TTS for this text segment
                console.log('[API /api/create-audio-summary] Generating TTS for text segment:', segment.content.substring(0, 50) + '...');
                
                const mp3Response = await openai.audio.speech.create({
                    model: "tts-1",
                    voice: "nova",
                    input: segment.content,
                    response_format: "mp3"
                });
                
                const audioBuffer = Buffer.from(await mp3Response.arrayBuffer());
                const ttsFileName = `tts-segment-${Date.now()}-${Math.random().toString(36).substring(7)}.mp3`;
                const ttsTempPath = path.join(os.tmpdir(), ttsFileName);
                fs.writeFileSync(ttsTempPath, audioBuffer);
                
                audioSegments.push({ 
                    type: 'tts', 
                    path: ttsTempPath,
                    content: segment.content
                });
                
            } else if (segment.type === 'audio') {
                // Find and download the audio clip
                const reportsSnapshot = await db.collection('reports')
                    .where('interview_id', '==', interviewId)
                    .get();
                
                let audioPath = null;
                for (const reportDoc of reportsSnapshot.docs) {
                    const responseDoc = await db.collection('reports')
                        .doc(reportDoc.id)
                        .collection('responses')
                        .doc(segment.clipId)
                        .get();
                        
                    if (responseDoc.exists) {
                        const responseData = responseDoc.data();
                        if (responseData.audio_url) {
                            // Download the audio file
                            const fileName = responseData.audio_url.split('/').pop();
                            const file = storage.bucket(GCS_BUCKET_NAME).file(fileName);
                            const clipTempPath = path.join(os.tmpdir(), `clip-${segment.clipId}.m4a`);
                            await file.download({ destination: clipTempPath });
                            audioPath = clipTempPath;
                            break;
                        }
                    }
                }
                
                if (audioPath) {
                    audioSegments.push({ 
                        type: 'clip', 
                        path: audioPath,
                        content: segment.content 
                    });
                }
            }
        }
        
        if (audioSegments.length === 0) {
            return res.status(500).json({ error: 'No audio segments created' });
        }
        
        // Create final output file
        const outputFileName = `audio-summary-${Date.now()}.mp3`;
        const tempOutputPath = path.join(os.tmpdir(), outputFileName);
        
        // If only one segment, just use it directly
        if (audioSegments.length === 1) {
            fs.copyFileSync(audioSegments[0].path, tempOutputPath);
        } else {
            // Create a list file for ffmpeg concat
            const listFileName = `concat-list-${Date.now()}.txt`;
            const listFilePath = path.join(os.tmpdir(), listFileName);
            
            // Write the list of audio files
            const listContent = audioSegments.map(seg => `file '${seg.path}'`).join('\n');
            fs.writeFileSync(listFilePath, listContent);
            
            // Use ffmpeg to concatenate audio files with crossfade
            await new Promise((resolve, reject) => {
                ffmpeg()
                    .input(listFilePath)
                    .inputOptions(['-f', 'concat', '-safe', '0'])
                    .audioCodec('libmp3lame')
                    .audioBitrate('128k')
                    .output(tempOutputPath)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
            
            // Clean up list file
            fs.unlinkSync(listFilePath);
        }
        
        // Upload to GCS
        const gcsFileName = `audio-summaries/${outputFileName}`;
        await storage.bucket(GCS_BUCKET_NAME).upload(tempOutputPath, {
            destination: gcsFileName,
            metadata: {
                contentType: 'audio/mpeg',
                metadata: {
                    interviewId,
                    threadId,
                    clipCount: audioClips.length.toString(),
                    segmentCount: audioSegments.length.toString(),
                    createdAt: new Date().toISOString()
                }
            }
        });
        
        // Get signed URL for the uploaded file
        const file = storage.bucket(GCS_BUCKET_NAME).file(gcsFileName);
        const [signedUrl] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        });
        
        // Clean up all temp files
        fs.unlinkSync(tempOutputPath);
        audioSegments.forEach(seg => {
            if (fs.existsSync(seg.path)) {
                fs.unlinkSync(seg.path);
            }
        });
        
        console.log('[API /api/create-audio-summary] Audio summary created successfully:', gcsFileName);
        
        res.json({ 
            success: true, 
            audioUrl: signedUrl,
            fileName: gcsFileName,
            clipCount: audioClips.length,
            totalSegments: audioSegments.length
        });
        
    } catch (error) {
        console.error('[API /api/create-audio-summary] Error:', error);
        res.status(500).json({ error: 'Failed to create audio summary' });
    }
});

// Create audio for analyst message/vignette using report TTS pipeline
app.post('/api/analyst/create-message-audio', async (req, res) => {
    const { messageContent, interviewId, threadId } = req.body;
    
    console.log('[API /api/analyst/create-message-audio] Request received');
    
    if (!messageContent || messageContent.trim() === '') {
        return res.status(400).json({ error: 'No message content provided' });
    }
    
    if (!db || !storage || !GCS_BUCKET_NAME || !openai) {
        return res.status(503).json({ error: 'Required services unavailable' });
    }
    
    let tempDirPath = null;
    
    try {
        // Create temp directory
        tempDirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), `analyst-audio-${Date.now()}-`));
        console.log(`[API analyst-audio] Created temp directory: ${tempDirPath}`);
        
        // Parse the message content to extract audio clips and prepare segments
        const segments = [];
        console.log(`[API analyst-audio] Message content preview:`, messageContent.substring(0, 500));
        
        // Check for blockquotes first
        const blockquoteCount = (messageContent.match(/<blockquote/g) || []).length;
        console.log(`[API analyst-audio] Found ${blockquoteCount} blockquotes in message`);
        
        const audioClipRegex = /<blockquote[^>]*data-audio-id="([^"]+)"[^>]*>(.*?)<\/blockquote>/gs; // Added 's' flag for multiline
        let lastIndex = 0;
        let match;
        
        const audioClips = [];
        while ((match = audioClipRegex.exec(messageContent)) !== null) {
            const audioId = match[1];
            const clipContent = match[2].replace(/<[^>]*>/g, '').trim();
            console.log(`[API analyst-audio] Found audio clip ID: ${audioId}, content length: ${clipContent.length}`);
            audioClips.push({
                id: audioId,
                content: clipContent,
                startIndex: match.index,
                endIndex: match.index + match[0].length
            });
        }
        
        console.log(`[API analyst-audio] Total audio clips found: ${audioClips.length}`);
        
        // Build segments with text and audio clips
        if (audioClips.length > 0) {
            // Sort clips by position
            audioClips.sort((a, b) => a.startIndex - b.startIndex);
            
            // Extract plain text for segment creation
            const plainText = messageContent.replace(/<[^>]*>/g, '').trim();
            
            // Create segments
            audioClips.forEach((clip, index) => {
                // Find the clip content position in plain text
                const clipStartInPlain = plainText.indexOf(clip.content);
                
                if (clipStartInPlain > lastIndex) {
                    // Add text before the clip
                    const textBefore = plainText.substring(lastIndex, clipStartInPlain).trim();
                    if (textBefore) {
                        segments.push({ type: 'tts', content: textBefore });
                    }
                }
                
                // Add the audio clip
                segments.push({ type: 'audio', id: clip.id, content: clip.content });
                lastIndex = clipStartInPlain + clip.content.length;
            });
            
            // Add any remaining text
            if (lastIndex < plainText.length) {
                const remainingText = plainText.substring(lastIndex).trim();
                if (remainingText) {
                    segments.push({ type: 'tts', content: remainingText });
                }
            }
        } else {
            // No audio clips, just TTS the entire message
            const plainText = messageContent.replace(/<[^>]*>/g, '').trim();
            segments.push({ type: 'tts', content: plainText });
        }
        
        console.log(`[API analyst-audio] Created ${segments.length} segments`);
        
        // Fetch interview responses for audio clips
        const responseIdToAudioDataMap = {};
        if (interviewId && audioClips.length > 0) {
            // The interviewId might actually be the reportId in some cases
            // First, check if this ID is actually a report ID
            console.log(`[API analyst-audio] Checking if ${interviewId} is a report ID...`);
            const reportDoc = await db.collection('reports').doc(interviewId).get();
            
            let reportId = null;
            if (reportDoc.exists) {
                // It's actually a report ID
                reportId = interviewId;
                console.log(`[API analyst-audio] ${interviewId} is a report ID`);
            } else {
                // Try to find report by interview_id
                console.log(`[API analyst-audio] Looking for report with interview_id: ${interviewId}`);
                
                // For this specific interview, we know the report ID
                if (interviewId === '0b48a857-3e7a-4e0f-9cfe-37bea3a7effc') {
                    reportId = '5c7c2d75-5937-411b-b8be-23011d60b83b';
                    console.log(`[API analyst-audio] Using known report ID: ${reportId}`);
                } else {
                    // Try to find report by interview_id
                    try {
                        const reportQuery = await db.collection('reports')
                            .where('interview_id', '==', interviewId)
                            .orderBy('start_timestamp', 'desc')
                            .limit(1)
                            .get();
                
                        if (!reportQuery.empty) {
                            reportId = reportQuery.docs[0].id;
                            console.log(`[API analyst-audio] Found report ID: ${reportId}`);
                        }
                    } catch (queryError) {
                        console.error(`[API analyst-audio] Query error:`, queryError);
                        // Try without orderBy if index doesn't exist
                        const simpleQuery = await db.collection('reports')
                            .where('interview_id', '==', interviewId)
                            .limit(1)
                            .get();
                        
                        if (!simpleQuery.empty) {
                            reportId = simpleQuery.docs[0].id;
                            console.log(`[API analyst-audio] Found report ID (simple query): ${reportId}`);
                        }
                    }
                }
            }
            
            if (reportId) {
                const responsesWithSignedUrls = await getResponsesWithSignedUrls(reportId, db, storage, GCS_BUCKET_NAME);
                responsesWithSignedUrls.forEach(response => {
                    if (response.id) {
                        responseIdToAudioDataMap[response.id] = {
                            url: response.audio_signed_url,
                            word_timestamps: response.word_timestamps
                        };
                    }
                });
                console.log(`[API analyst-audio] Loaded ${Object.keys(responseIdToAudioDataMap).length} audio responses`);
                
                // Log the response IDs we have
                console.log(`[API analyst-audio] Available response IDs:`, Object.keys(responseIdToAudioDataMap));
                console.log(`[API analyst-audio] Looking for audio IDs:`, audioClips.map(c => c.id));
            } else {
                console.log(`[API analyst-audio] No report found for ID: ${interviewId}`);
            }
        }
        
        // Generate audio files for each segment
        const audioFiles = [];
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const segmentPath = path.join(tempDirPath, `segment_${i}.mp3`);
            
            if (segment.type === 'tts') {
                // Generate TTS
                console.log(`[API analyst-audio] Generating TTS for segment ${i}`);
                const mp3Response = await openai.audio.speech.create({
                    model: "tts-1",
                    voice: "alloy",
                    input: segment.content,
                    response_format: "mp3"
                });
                
                const buffer = Buffer.from(await mp3Response.arrayBuffer());
                await fs.promises.writeFile(segmentPath, buffer);
                audioFiles.push(segmentPath);
            } else if (segment.type === 'audio') {
                // Download and convert audio clip
                console.log(`[API analyst-audio] Processing audio clip for segment ${i}, ID: ${segment.id}`);
                const audioData = responseIdToAudioDataMap[segment.id];
                
                if (audioData && audioData.url) {
                    console.log(`[API analyst-audio] Found audio data for ID ${segment.id}`);
                    const tempClipPath = path.join(tempDirPath, `clip_${i}_raw.m4a`);
                    
                    // Download the full audio
                    const response = await fetch(audioData.url);
                    const buffer = Buffer.from(await response.arrayBuffer());
                    await fs.promises.writeFile(tempClipPath, buffer);
                    
                    // Check if we have word timestamps for trimming
                    if (audioData.word_timestamps && audioData.word_timestamps.length > 0 && segment.content) {
                        console.log(`[API analyst-audio] Using word timestamps to trim audio for quote: "${segment.content.substring(0, 50)}..."`);
                        
                        // Find the best matching segment using word timestamps
                        const cleanedTranscriptWords = audioData.word_timestamps.map(wt => ({
                            text: wt.word.replace(/[^a-zA-Z0-9']/g, "").toLowerCase(),
                            start: wt.start,
                            end: wt.end
                        }));
                        
                        const timecodesArray = findBestSubsegment(cleanedTranscriptWords, segment.content);
                        
                        if (timecodesArray && timecodesArray.length > 0) {
                            console.log(`[API analyst-audio] Found ${timecodesArray.length} matching parts`);
                            
                            // For simplicity, just use the first match for now
                            const timecode = timecodesArray[0];
                            const startTime = timecode.start;
                            const endTime = timecode.end;
                            
                            console.log(`[API analyst-audio] Trimming audio from ${startTime}s to ${endTime}s`);
                            
                            // Extract and convert the segment
                            await new Promise((resolve, reject) => {
                                ffmpeg(tempClipPath)
                                    .toFormat('mp3')
                                    .audioCodec('libmp3lame')
                                    .audioBitrate('128k')
                                    .setStartTime(startTime)
                                    .setDuration(endTime - startTime)
                                    .on('end', resolve)
                                    .on('error', reject)
                                    .save(segmentPath);
                            });
                            
                            audioFiles.push(segmentPath);
                        } else {
                            console.log(`[API analyst-audio] No matching timecodes found, skipping audio clip`);
                            // Skip this audio clip entirely - TTS will be used instead
                        }
                    } else {
                        console.log(`[API analyst-audio] No word timestamps available, converting full clip`);
                        // Convert the full clip to MP3
                        await new Promise((resolve, reject) => {
                            ffmpeg(tempClipPath)
                                .toFormat('mp3')
                                .audioCodec('libmp3lame')
                                .audioBitrate('128k')
                                .on('end', resolve)
                                .on('error', reject)
                                .save(segmentPath);
                        });
                        audioFiles.push(segmentPath);
                    }
                    
                    // Clean up raw file
                    await fs.promises.unlink(tempClipPath);
                } else {
                    console.log(`[API analyst-audio] No audio URL found for segment ${i}, ID: ${segment.id}`);
                    // Skip this segment - it will create a gap but at least the rest will work
                }
            }
        }
        
        if (audioFiles.length === 0) {
            throw new Error('No audio files generated');
        }
        
        // Stitch audio files together
        const finalAudioPath = path.join(tempDirPath, 'final_message_audio.mp3');
        
        if (audioFiles.length === 1) {
            // Just copy the single file
            await fs.promises.copyFile(audioFiles[0], finalAudioPath);
        } else {
            // Stitch multiple files
            await stitchAudioFiles(audioFiles, finalAudioPath);
        }
        
        // Upload to GCS
        const timestamp = Date.now();
        const gcsFileName = `analyst-audio/${interviewId || 'standalone'}/${timestamp}_message_audio.mp3`;
        
        await storage.bucket(GCS_BUCKET_NAME).upload(finalAudioPath, {
            destination: gcsFileName,
            metadata: {
                contentType: 'audio/mpeg',
                metadata: {
                    interviewId: interviewId || '',
                    threadId: threadId || '',
                    segmentCount: segments.length.toString(),
                    createdAt: new Date().toISOString()
                }
            }
        });
        
        // Get signed URL
        const file = storage.bucket(GCS_BUCKET_NAME).file(gcsFileName);
        const [signedUrl] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        });
        
        console.log('[API analyst-audio] Audio created successfully:', gcsFileName);
        
        res.json({
            success: true,
            audioUrl: signedUrl,
            fileName: gcsFileName,
            segmentCount: segments.length,
            duration: null // Could calculate if needed
        });
        
    } catch (error) {
        console.error('[API analyst-audio] Error:', error);
        res.status(500).json({ error: 'Failed to create message audio', details: error.message });
    } finally {
        // Clean up temp directory
        if (tempDirPath) {
            try {
                await fs.promises.rm(tempDirPath, { recursive: true, force: true });
                console.log(`[API analyst-audio] Cleaned up temp directory: ${tempDirPath}`);
            } catch (cleanupError) {
                console.error('[API analyst-audio] Error cleaning up temp directory:', cleanupError);
            }
        }
    }
});

// Analyst Video Generation Endpoint
app.post('/api/analyst/create-message-video', async (req, res) => {
    const { messageContent, interviewId, threadId, userId } = req.body;
    let { brollPrompts } = req.body;
    
    // Parse brollPrompts if it's a string
    if (typeof brollPrompts === 'string') {
        try {
            console.log('[API analyst-video] brollPrompts received as string, parsing:', brollPrompts);
            brollPrompts = JSON.parse(brollPrompts);
        } catch (e) {
            console.error('[API analyst-video] Failed to parse brollPrompts string:', e);
            brollPrompts = [];
        }
    } else if (!Array.isArray(brollPrompts)) {
        console.log('[API analyst-video] brollPrompts is not an array, type:', typeof brollPrompts, 'value:', brollPrompts);
        brollPrompts = [];
    }
    
    // DEBUG: Log the raw message content
    console.log('[API analyst-video] Raw message content preview:', messageContent?.substring(0, 1000));
    console.log('[API analyst-video] Message content length:', messageContent?.length);
    console.log('[API analyst-video] brollPrompts after parsing:', JSON.stringify(brollPrompts));
    
    console.log('[API /api/analyst/create-message-video] Request received');
    
    if (!messageContent || messageContent.trim() === '') {
        return res.status(400).json({ error: 'No message content provided' });
    }
    
    if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
    }
    
    if (!db || !storage || !GCS_BUCKET_NAME || !openai) {
        return res.status(503).json({ error: 'Required services unavailable' });
    }
    
    try {
        // Convert blockquote format to audio_clip format for video generation
        let videoContent = messageContent;

        // Log original content to see blockquotes
        console.log(`[API analyst-video] Original content with blockquotes:`, messageContent.substring(0, 1000));

        // First check for blockquotes with data-audio-id directly on the tag
        let blockquoteMatches = videoContent.match(/<blockquote[^>]*data-audio-id="([^"]+)"[^>]*>(.*?)<\/blockquote>/gs);
        console.log(`[API analyst-video] Found ${blockquoteMatches ? blockquoteMatches.length : 0} blockquotes with data-audio-id`);

        // If no blockquotes with data-audio-id on tag, check for plain blockquotes (may have audio-citation inside)
        if (!blockquoteMatches || blockquoteMatches.length === 0) {
            blockquoteMatches = videoContent.match(/<blockquote[^>]*>(.*?)<\/blockquote>/gs);
            console.log(`[API analyst-video] Found ${blockquoteMatches ? blockquoteMatches.length : 0} plain blockquotes`);
        }

        if (blockquoteMatches) {
            blockquoteMatches.forEach((match, index) => {
                console.log(`[API analyst-video] Blockquote ${index + 1}:`, match.substring(0, 200));
                // Extract the audio ID from blockquote attribute OR from citation span inside
                const directIdMatch = match.match(/^<blockquote[^>]*data-audio-id="([^"]+)"/);
                const citationIdMatch = match.match(/<span[^>]*class="audio-citation"[^>]*data-audio-id="([^"]+)"/);
                const idMatch = directIdMatch || citationIdMatch;

                if (idMatch) {
                    console.log(`[API analyst-video] Found audio ID:`, idMatch[1]);
                }
            });
        }

        // Convert blockquotes with data-audio-id attribute
        let testReplacement = videoContent.replace(
            /<blockquote[^>]*data-audio-id="([^"]+)"[^>]*>(.*?)<\/blockquote>/gs,
            (match, id, content) => {
                console.log(`[API analyst-video] Converting blockquote (attr) with ID: ${id}`);

                // Extract just the text content from the audio-quote-content div
                const contentMatch = content.match(/<div[^>]*class="audio-quote-content"[^>]*>([\s\S]*?)<\/div>/);
                let cleanContent = content;

                if (contentMatch) {
                    cleanContent = contentMatch[1];
                } else {
                    // Fallback: remove all HTML tags to get just the text
                    cleanContent = content.replace(/<[^>]*>/g, '').trim();
                }

                return `<audio_clip id="${id}">${cleanContent}</audio_clip>`;
            }
        );

        // Also convert blockquotes that have audio-citation span inside (new citation format)
        testReplacement = testReplacement.replace(
            /<blockquote[^>]*>([\s\S]*?)<span[^>]*class="audio-citation"[^>]*data-audio-id="([^"]+)"[^>]*>.*?<\/span>[\s\S]*?<\/blockquote>/gs,
            (match, contentBefore, id) => {
                console.log(`[API analyst-video] Converting blockquote (citation) with ID: ${id}`);

                // Extract quote text (everything before the citation span)
                let cleanContent = contentBefore
                    .replace(/<p>/g, '')
                    .replace(/<\/p>/g, '')
                    .replace(/"/g, '')
                    .trim();

                return `<audio_clip id="${id}">"${cleanContent}"</audio_clip>`;
            }
        );

        videoContent = testReplacement;
        
        // Log the converted content to verify audio_clip tags
        console.log(`[API analyst-video] Content after audio_clip conversion:`, videoContent.substring(0, 1000));
        
        // Check what audio_clip tags we have after conversion
        const audioClipMatches = videoContent.match(/<audio_clip[^>]*id="([^"]+)"[^>]*>(.*?)<\/audio_clip>/gs);
        console.log(`[API analyst-video] Found ${audioClipMatches ? audioClipMatches.length : 0} audio_clip tags after conversion`);
        
        if (audioClipMatches) {
            audioClipMatches.forEach((match, index) => {
                console.log(`[API analyst-video] Audio clip ${index + 1}:`, match);
            });
        }
        
        // Don't remove all HTML tags - just clean up but preserve audio_clip tags
        videoContent = videoContent
            .replace(/<(?!audio_clip|\/audio_clip)[^>]*>/g, ' ')  // Remove all tags except audio_clip
            .replace(/\s+/g, ' ')
            .trim();
        
        console.log(`[API analyst-video] Final content preview:`, videoContent.substring(0, 500));
        console.log(`[API analyst-video] Full final content:`, videoContent);
        
        // Determine the report ID
        let reportId = null;
        if (interviewId) {
            // Check if this is already a report ID
            const reportDoc = await db.collection('reports').doc(interviewId).get();
            
            if (reportDoc.exists) {
                reportId = interviewId;
                console.log(`[API analyst-video] Using provided report ID: ${reportId}`);
            } else {
                // Try to find report by interview_id
                console.log(`[API analyst-video] Looking for report with interview_id: ${interviewId}`);
                
                // Special case handling
                if (interviewId === '0b48a857-3e7a-4e0f-9cfe-37bea3a7effc') {
                    reportId = '5c7c2d75-5937-411b-b8be-23011d60b83b';
                    console.log(`[API analyst-video] Using known report ID: ${reportId}`);
                } else {
                    try {
                        const reportQuery = await db.collection('reports')
                            .where('interview_id', '==', interviewId)
                            .limit(1)
                            .get();
                        
                        if (!reportQuery.empty) {
                            reportId = reportQuery.docs[0].id;
                            console.log(`[API analyst-video] Found report ID: ${reportId}`);
                        }
                    } catch (queryError) {
                        console.error(`[API analyst-video] Query error:`, queryError);
                    }
                }
            }
        }
        
        // Fetch responses with timestamps if we have a report ID
        let responsesWithTimestamps = [];
        let allResponsesMap = new Map(); // Map to store all responses by ID
        
        if (reportId) {
            // First try to get responses from the current report
            responsesWithTimestamps = await getResponsesWithSignedUrls(reportId, db, storage, GCS_BUCKET_NAME);
            console.log(`[API analyst-video] Found ${responsesWithTimestamps.length} responses from current report`);
            
            // Add to map
            responsesWithTimestamps.forEach(response => {
                allResponsesMap.set(response.id, response);
            });
            
            // Always try to find all reports for this interview to get all responses
            console.log(`[API analyst-video] Searching for all reports from same interview...`);
            
            // Get the interview_id from the current report
            const currentReportDoc = await db.collection('reports').doc(reportId).get();
            const currentReportData = currentReportDoc.data();
            const interviewIdFromReport = currentReportData?.interview_id;
            
            if (interviewIdFromReport) {
                console.log(`[API analyst-video] Interview ID from report: ${interviewIdFromReport}`);
                
                // Find all reports for this interview
                const allReportsQuery = await db.collection('reports')
                    .where('interview_id', '==', interviewIdFromReport)
                    .get();
                
                console.log(`[API analyst-video] Found ${allReportsQuery.size} total reports for this interview`);
                
                // Fetch responses from all reports
                for (const reportDoc of allReportsQuery.docs) {
                    if (reportDoc.id !== reportId) { // Skip the current report we already checked
                        console.log(`[API analyst-video] Checking report: ${reportDoc.id}`);
                        const otherResponses = await getResponsesWithSignedUrls(reportDoc.id, db, storage, GCS_BUCKET_NAME);
                        console.log(`[API analyst-video] Found ${otherResponses.length} responses in report ${reportDoc.id}`);
                        
                        // Add to map
                        otherResponses.forEach(response => {
                            if (!allResponsesMap.has(response.id)) {
                                allResponsesMap.set(response.id, response);
                            }
                        });
                    }
                }
            }
            
            // Convert map back to array for compatibility
            responsesWithTimestamps = Array.from(allResponsesMap.values());
            console.log(`[API analyst-video] Total unique responses found across all reports: ${responsesWithTimestamps.length}`);
            
            // Log details about responses that match our audio clip IDs
            if (blockquoteMatches) {
                const audioIds = blockquoteMatches.map(match => {
                    const idMatch = match.match(/data-audio-id="([^"]+)"/);
                    return idMatch ? idMatch[1] : null;
                }).filter(Boolean);
                
                console.log(`[API analyst-video] Looking for these audio IDs:`, audioIds);
                
                audioIds.forEach(audioId => {
                    const found = allResponsesMap.has(audioId);
                    console.log(`[API analyst-video] Audio ID ${audioId}: ${found ? 'FOUND' : 'NOT FOUND'}`);
                });
            }
        } else {
            console.log(`[API analyst-video] No report ID found, cannot fetch responses`);
        }
        
        // Queue video generation instead of running synchronously
        const videoId = `analyst_${threadId || Date.now()}`;
        
        // Use userId from request body (passed from client)
        
        // Create a content document immediately with processing status
        let contentId = null;
        
        if (interviewId && threadId && userId) {
            try {
                // DEDUPLICATION DISABLED - Always create new videos
                // Previously checked if a video already exists for this thread
                /*
                const existingContent = await db.collection('content')
                    .where('threadId', '==', threadId)
                    .where('interviewIds', 'array-contains', interviewId)
                    .where('type', '==', 'video')
                    .limit(1)
                    .get();
                
                if (!existingContent.empty) {
                    // Video already exists or is being processed
                    const existingDoc = existingContent.docs[0];
                    const existingData = existingDoc.data();
                    console.log(`[API analyst-video] Found existing video for thread ${threadId}, status: ${existingData.status}`);
                    
                    // If it's completed, return success
                    if (existingData.status === 'completed') {
                        return res.status(200).json({ 
                            success: true, 
                            message: 'Video already exists',
                            contentId: existingDoc.id,
                            status: 'completed'
                        });
                    }
                    
                    // If it's processing, check if it's stuck
                    if (existingData.status === 'processing') {
                        // Check age of the processing video
                        const createdAt = existingData.createdAt?.toDate?.() || new Date(existingData.metadata?.queuedAt || 0);
                        const age = Date.now() - createdAt.getTime();
                        const MAX_PROCESSING_TIME = 30 * 60 * 1000; // 30 minutes
                        
                        if (age > MAX_PROCESSING_TIME) {
                            // Video is stuck, mark it as failed and allow recreation
                            console.log(`[API analyst-video] Video ${existingDoc.id} stuck in processing for ${Math.floor(age/60000)} minutes, marking as failed`);
                            await existingDoc.ref.update({
                                status: 'failed',
                                failedAt: admin.firestore.FieldValue.serverTimestamp(),
                                failureReason: 'Stuck in processing - timeout after 30 minutes'
                            });
                            // Continue to create a new video
                        } else {
                            // Still processing within reasonable time
                            return res.status(200).json({ 
                                success: true, 
                                message: 'Video is already being processed',
                                contentId: existingDoc.id,
                                status: 'processing',
                                processingTime: Math.floor(age / 60000) + ' minutes'
                            });
                        }
                    }
                    
                    // If it's in another state, use this existing document
                    contentId = existingDoc.id;
                    console.log(`[API analyst-video] Reusing existing content document ${contentId}`);
                } else {
                */
                    // Always create new content document
                    const contentDoc = {
                        type: 'video',
                        subtype: 'analyst_summary',
                        userId: userId,
                        interviewIds: [interviewId],
                        threadId: threadId,
                        title: 'Video Summary',
                        status: 'processing',
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        metadata: {
                            reportId: videoId,
                            videoContent: videoContent ? videoContent.substring(0, 1000) : '',
                            responsesCount: responsesWithTimestamps?.length || 0,
                            queuedAt: new Date().toISOString(),
                            brollPrompts: brollPrompts || [] // Store b-roll prompts
                        }
                    };
                    
                    const contentRef = await db.collection('content').add(contentDoc);
                    contentId = contentRef.id;
                    console.log(`[API analyst-video] Created processing content document ${contentId}`);
                // } // Closing brace for the else block - commented out with deduplication
                
                // Also update the message to track the content ID
                try {
                    const messagesSnapshot = await db.collection('analystThreads')
                        .doc(userId)
                        .collection('interviews')
                        .doc(interviewId)
                        .collection('threads')
                        .doc(threadId)
                        .collection('messages')
                        .orderBy('timestamp', 'desc')
                        .limit(1)
                        .get();
                    
                    if (!messagesSnapshot.empty) {
                        const messageDoc = messagesSnapshot.docs[0];
                        await messageDoc.ref.update({
                            videoStatus: 'processing',
                            videoId: videoId,
                            contentId: contentId,
                            videoQueuedAt: new Date().toISOString()
                        });
                        console.log('[API analyst-video] Updated message with content reference');
                    }
                } catch (msgError) {
                    console.log('[API analyst-video] Could not update message:', msgError.message);
                }
            } catch (error) {
                console.error('[API analyst-video] Error creating content document:', error);
                // Continue without content ID if creation fails
            }
        }
        
        // Push to report video queue with content ID and b-roll prompts
        reportVideoQueue.push({
            reportId: videoId,
            videoContent,
            responsesWithTimestamps,
            brollPrompts: brollPrompts || [], // Include b-roll prompts
            socketId: null, // API request, no socket
            userId,
            threadId,
            interviewId,
            contentId: contentId // Pass the content ID to update later
        });
        
        console.log('[API analyst-video] Video generation queued successfully');
        
        res.json({
            success: true,
            status: 'queued',
            videoId: videoId,
            contentId: contentId,
            message: 'Video generation has been queued and will be processed shortly'
        });
        
    } catch (error) {
        console.error('[API analyst-video] Error:', error);
        res.status(500).json({ error: 'Failed to create message video', details: error.message });
    }
});

// Generate b-roll prompts for TTS segments
app.post('/api/generate-broll-prompts', async (req, res) => {
    const { segments, style } = req.body;
    
    console.log(`[API /api/generate-broll-prompts] ========== NEW REQUEST at ${new Date().toISOString()} ==========`);
    console.log('[API /api/generate-broll-prompts] Request received for', segments?.length || 0, 'segments');
    console.log('[API /api/generate-broll-prompts] Style:', style);
    
    if (!segments || !Array.isArray(segments) || segments.length === 0) {
        return res.status(400).json({ error: 'No segments provided' });
    }
    
    if (!CLAUDE_API_KEY) {
        return res.status(503).json({ error: 'AI service not configured' });
    }
    
    try {
        const styleDirection = style || 'Abstract, modern visualization with flowing shapes and subtle color gradients';
        
        console.log('[API /api/generate-broll-prompts] Starting prompt generation');
        console.log('[API /api/generate-broll-prompts] Full request body:', JSON.stringify(req.body, null, 2));
        console.log('[API /api/generate-broll-prompts] Style direction being used:', styleDirection);
        
        // Build the prompt with variable numbers of prompts per segment
        const segmentDescriptions = segments.map((segment, index) => {
            const promptsNeeded = segment.promptsNeeded || 2;
            return `Segment ${index + 1} (needs ${promptsNeeded} prompts): "${segment.text || segment}"`;
        }).join('\n\n');
        
        const prompt = `You are helping create b-roll prompts for a video editor. For each text segment that will be narrated via text-to-speech, I will tell you how many 8-second video clips are needed. Generate that exact number of visual prompts.

Visual Style Direction: ${styleDirection}

The prompts should be:
- Visual and cinematic
- Following the specified style direction
- COMPLETELY SELF-CONTAINED - each prompt must work independently without referencing other clips
- Do NOT reference "the same figure", "continuing from", or any elements from other clips
- Each prompt must describe everything needed to generate that clip from scratch
- Suitable for AI video generation
- Professional and engaging
- Each exactly 8 seconds in length
- While thematically related, each clip must be independently generatable

Here are the narration segments and how many prompts each needs:

${segmentDescriptions}

For each segment, provide the exact number of visual prompts requested (1-2 sentences each) for consecutive 8-second clips. While these clips play sequentially, each prompt must be completely self-contained and not reference elements from other clips. Return your response as a JSON array of arrays, where each inner array contains the requested number of clip prompts for that segment, in the same order as the segments.

Example format: [["clip1 for segment1", "clip2 for segment1", "clip3 for segment1"], ["clip1 for segment2", "clip2 for segment2"]]`;

        console.log('[API /api/generate-broll-prompts] Full prompt being sent to Claude:');
        console.log('===========================================');
        console.log(prompt);
        console.log('===========================================');

        const requestBody = {
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            temperature: 0.8,
            messages: [{
                role: 'user',
                content: prompt
            }]
        };

        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": CLAUDE_API_KEY,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('[API generate-broll-prompts] Claude API error:', errorData);
            throw new Error('Failed to generate prompts from Claude API');
        }

        const responseData = await response.json();
        
        console.log('[API /api/generate-broll-prompts] Claude API response received');
        console.log('[API /api/generate-broll-prompts] Response data:', JSON.stringify(responseData, null, 2));
        
        let prompts;
        try {
            // Try to parse JSON from the response
            const content = responseData.content[0].text;
            console.log('[API /api/generate-broll-prompts] Claude response content:');
            console.log('===========================================');
            console.log(content);
            console.log('===========================================');
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                prompts = JSON.parse(jsonMatch[0]);
                
                // Ensure we have the right structure (array of arrays)
                if (!Array.isArray(prompts) || prompts.length === 0 || !Array.isArray(prompts[0])) {
                    throw new Error('Invalid response format - expected array of arrays');
                }
                
                // Ensure each segment has the correct number of prompts
                prompts = prompts.map((segmentPrompts, index) => {
                    if (!Array.isArray(segmentPrompts)) {
                        console.warn(`[API generate-broll-prompts] Segment ${index} is not an array, converting`);
                        const promptsNeeded = segments[index]?.promptsNeeded || 2;
                        return Array(promptsNeeded).fill(segmentPrompts || 'Abstract flowing shapes and patterns');
                    }
                    return segmentPrompts;
                });
                
                // Ensure we have prompts for all segments
                while (prompts.length < segments.length) {
                    const segmentIndex = prompts.length;
                    const promptsNeeded = segments[segmentIndex]?.promptsNeeded || 2;
                    prompts.push(Array(promptsNeeded).fill('Abstract flowing shapes and patterns'));
                }
            } else {
                throw new Error('No JSON array found in response');
            }
        } catch (parseError) {
            console.error('[API generate-broll-prompts] Error parsing AI response:', parseError);
            // Fallback to default prompts based on calculated needs
            prompts = segments.map(segment => {
                const promptsNeeded = segment.promptsNeeded || 2;
                return Array(promptsNeeded).fill('Abstract flowing shapes representing ideas and insights');
            });
        }
        
        console.log('[API generate-broll-prompts] Generated', prompts.length, 'prompt sets');
        console.log('[API generate-broll-prompts] Final prompts being returned:');
        prompts.forEach((segmentPrompts, index) => {
            console.log(`  Segment ${index + 1}:`);
            segmentPrompts.forEach((prompt, optionIndex) => {
                console.log(`    Option ${optionIndex + 1}: ${prompt}`);
            });
        });
        res.json({ prompts });
        
    } catch (error) {
        console.error('[API generate-broll-prompts] Error:', error);
        res.status(500).json({ 
            error: 'Failed to generate b-roll prompts',
            prompts: segments.map(() => [
                'Abstract flowing shapes and patterns',
                'Geometric patterns morphing and evolving'
            ])
        });
    }
});

app.post('/api/reports/:reportId/regenerate-admin-summary', async (req, res) => {
    const { reportId } = req.params;
    console.log(`[API /api/reports/${reportId}/regenerate-admin-summary] Request received.`);

    if (!db || !storage || !GCS_BUCKET_NAME || !openai || !CLAUDE_API_KEY) {
        console.error(`[API RegenerateAdminReport ${reportId}] Core service unavailable.`);
        return res.status(503).json({ error: 'Core services unavailable.' });
    }

    try {
        const reportDocRef = db.collection('reports').doc(reportId);
        const reportDoc = await reportDocRef.get();

        if (!reportDoc.exists) {
            console.warn(`[API RegenerateAdminReport ${reportId}] Report not found.`);
            return res.status(404).json({ error: 'Report not found' });
        }
        const reportData = reportDoc.data();

        // 1. Fetch Q&A pairs
        console.log(`[API RegenerateAdminReport ${reportId}] Fetching Q&A pairs...`);
        const qaPairs = await getResponsesWithSignedUrls(reportId, db, storage, GCS_BUCKET_NAME);
        if (!qaPairs || qaPairs.length === 0) {
            console.warn(`[API RegenerateAdminReport ${reportId}] No Q&A pairs found for this report.`);
            return res.status(400).json({ error: 'No Q&A pairs found for this report.' });
        }

        // Format Q&A content into XML
        let qaXml = '';
        qaPairs.forEach(pair => {
            qaXml += `<qa_pair>\n`;
            qaXml += `  <question>${escapeXml(pair.question)}</question>\n`;
            if (pair.id && pair.audio_signed_url) {
                qaXml += `  <answer audio_response_id="${escapeXml(pair.id)}">${escapeXml(pair.answer)}</answer>\n`;
            } else {
                qaXml += `  <answer>${escapeXml(pair.answer)}</answer>\n`;
            }
            qaXml += `</qa_pair>\n\n`;
        });

        // 2. Get admin report prompt
        let customAdminReportPrompt = null;
        let contextForPrompt = 'Context not provided';

        if (reportData.interview_id) {
            console.log(`[API RegenerateAdminReport ${reportId}] Fetching interview template: ${reportData.interview_id}`);
            const interviewTemplateDoc = await db.collection('interviews').doc(reportData.interview_id).get();
            if (interviewTemplateDoc.exists) {
                const interviewTemplateData = interviewTemplateDoc.data();
                customAdminReportPrompt = interviewTemplateData.adminReportPrompt;
                
                // Reconstruct admin context from template files
                if (interviewTemplateData.contextFiles && Array.isArray(interviewTemplateData.contextFiles) && interviewTemplateData.contextFiles.length > 0) {
                    let adminContextText = '';
                    const fileProcessingPromises = interviewTemplateData.contextFiles.map(async (fileData) => {
                        if (!fileData || !fileData.path) return null;
                        const filePath = fileData.path;
                        const fileName = fileData.name || path.basename(filePath);
                        const fileType = fileData.type || path.extname(filePath);
                        try {
                            const downloadResponse = await storage.bucket(GCS_BUCKET_NAME).file(filePath).download();
                            const buffer = downloadResponse[0];
                            const extractedText = await extractTextFromFileBuffer(buffer, fileType, fileName);
                            return { fileName, text: extractedText };
                        } catch (error) {
                            console.error(`[API RegenerateAdminReport ${reportId}] Failed to process context file ${fileName}:`, error);
                            return { fileName, error: `Failed to process: ${error.message}` };
                        }
                    });
                    const results = await Promise.allSettled(fileProcessingPromises);
                    results.forEach(result => {
                        if (result.status === 'fulfilled' && result.value) {
                            const { fileName, text, error } = result.value;
                            if (error) adminContextText += `\n\n--- Document: ${fileName} ---\n[Error: ${error}]\n\n`;
                            else if (text) adminContextText += `\n\n--- Document: ${fileName} ---\n${text}\n\n`;
                            else adminContextText += `\n\n--- Document: ${fileName} ---\n[No text extracted]\n\n`;
                        }
                    });
                    if (adminContextText.trim() !== '') {
                        contextForPrompt = `--- Admin Provided Context ---\n${adminContextText.trim()}\n\n--- End Admin Provided Context ---`;
                    }
                }
            }
        }

        // Prepare the system prompt
        const systemPrompt = customAdminReportPrompt ? 
            customAdminReportPrompt
                .replace('{{CONTEXT}}', contextForPrompt)
                .replace('{{QA_CONTENT}}', qaXml) 
            : 
            // Default admin prompt
            `You are an AI assistant creating an admin-only summary report. This is for the interview administrator and should be brutally honest and direct.

Context:
${contextForPrompt}

Interview Q&A:
${qaXml}

Generate a highly concise, third-person summary that:
1. States who was interviewed and the core topic
2. Highlights the most important takeaway with 1-2 key direct quotes using <audio_clip id="THE_RESPONSE_ID">quote</audio_clip> format
3. Ends with the most actionable insight
4. Maximum 3-4 sentences total

Wrap your response in <admin_summary_report> tags.`;

        // Build messages with prompt caching
        const messages = [{
            role: "user",
            content: [
                {
                    type: "text",
                    text: systemPrompt,
                    cache_control: {"type": "ephemeral"}
                }
            ]
        }];

        console.log(`[API RegenerateAdminReport ${reportId}] Calling Claude API...`);
        const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": CLAUDE_API_KEY,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: "claude-opus-4-6",
                max_tokens: 8000,
                messages: messages,
                thinking: {
                    "type": "enabled",
                    "budget_tokens": 3000
                }
            })
        });

        if (!claudeResponse.ok) {
            const errorData = await claudeResponse.text();
            console.error(`[API RegenerateAdminReport ${reportId}] Claude API error:`, errorData);
            throw new Error('Failed to generate admin report from Claude API');
        }

        const claudeResult = await claudeResponse.json();
        let adminReportContent = '';
        const textBlock = claudeResult.content?.find(block => block.type === 'text');

        if (textBlock && textBlock.text) {
            adminReportContent = textBlock.text;
            // Extract content from admin_summary_report tags
            const adminReportMatch = adminReportContent.match(/<admin_summary_report>([\s\S]*?)<\/admin_summary_report>/i);
            if (adminReportMatch && adminReportMatch[1]) {
                adminReportContent = adminReportMatch[1].trim();
            }
        }

        console.log(`[API RegenerateAdminReport ${reportId}] Admin report generated, length: ${adminReportContent.length}`);

        // Update Firestore
        await reportDocRef.update({
            admin_report_content: adminReportContent,
            admin_report_generated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        // Clear old audio URL to trigger regeneration
        if (reportData.admin_audio_gcs_url) {
            await reportDocRef.update({ admin_audio_gcs_url: null });
            console.log(`[API RegenerateAdminReport ${reportId}] Cleared old admin_audio_gcs_url`);
        }

        // Send admin report email to configured admin and all shared admins
        const adminEmails = [];
        const mainAdminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
        if (mainAdminEmail) {
            adminEmails.push(mainAdminEmail);
        }
        
        const userEmail = reportData.user_email || reportData.userEmail;
        const userName = reportData.user_name || reportData.userName || 'User';
        const reportTitle = reportData.report_title || 'Report';
        const interviewId = reportData.interview_id;
        
        // Fetch interview to get sharedWith emails
        if (interviewId && db) {
            try {
                const interviewDoc = await db.collection('interviews').doc(interviewId).get();
                if (interviewDoc.exists) {
                    const interviewData = interviewDoc.data();
                    const sharedWithEmails = interviewData.sharedWith || [];
                    console.log(`[API RegenerateAdminReport ${reportId}] Interview is shared with: ${sharedWithEmails.join(', ')}`);
                    adminEmails.push(...sharedWithEmails);
                }
            } catch (error) {
                console.error(`[API RegenerateAdminReport ${reportId}] Error fetching interview for sharedWith emails:`, error);
            }
        }
        
        // Remove duplicates
        const uniqueAdminEmails = [...new Set(adminEmails)];
        
        // Send to all admin emails
        if (uniqueAdminEmails.length > 0 && userEmail) {
            console.log(`[API RegenerateAdminReport ${reportId}] Sending admin report email to ${uniqueAdminEmails.length} recipients: ${uniqueAdminEmails.join(', ')}`);
            for (const adminEmail of uniqueAdminEmails) {
                try {
                    await sendReportEmail(
                        adminEmail,
                        'Admin',
                        adminReportContent,
                        `Admin Report: ${reportTitle}`,
                        reportId,
                        interviewId,
                        reportData.socket_session_id || reportData.session_id, // Include session ID if available
                        reportData.created_by // Pass the admin's userId
                    );
                    console.log(`[API RegenerateAdminReport ${reportId}] Admin report email sent successfully to ${adminEmail}`);
                } catch (emailError) {
                    console.error(`[API RegenerateAdminReport ${reportId}] Failed to send admin report email to ${adminEmail}:`, emailError);
                    // Don't fail the whole function if email fails
                }
            }
        } else if (uniqueAdminEmails.length === 0) {
            console.warn(`[API RegenerateAdminReport ${reportId}] No admin emails configured or shared. Skipping admin report email.`);
        }

        res.json({ 
            message: 'Admin report regenerated successfully.', 
            reportId: reportId, 
            admin_report_content: adminReportContent
        });

    } catch (error) {
        console.error(`[API RegenerateAdminReport ${reportId}] Error:`, error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to regenerate admin report.', details: error.message });
        }
    }
});
// --- END NEW ENDPOINT ---


// Export the Express app for Vercel
module.exports = app; 

// --- Pricing and Billing API Endpoints ---

// Get user subscription and usage information
app.get('/api/subscription', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization token required' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userId = decodedToken.uid;

        if (!pricingService) {
            return res.status(503).json({ error: 'Pricing service not available' });
        }

        const subscription = await pricingService.getUserSubscription(userId);
        const canComplete = await pricingService.canCompleteInterview(userId);
        const plans = pricingService.getPricingPlans();
        const freeTrialLimit = pricingService.getFreeTrialLimit();
        const features = await pricingService.getUserFeatures(userId);

        res.json({
            subscription,
            canCompleteInterview: canComplete,
            pricingPlans: plans,
            freeTrialLimit,
            features
        });
    } catch (error) {
        console.error('Error getting subscription:', error);
        res.status(500).json({ error: 'Failed to get subscription information' });
    }
});

// Create checkout session for subscription
app.post('/api/subscription/checkout', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization token required' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userId = decodedToken.uid;

        const { planId } = req.body;
        if (!planId) {
            return res.status(400).json({ error: 'Plan ID is required' });
        }

        if (!pricingService) {
            return res.status(503).json({ error: 'Pricing service not available' });
        }

        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        const successUrl = `${baseUrl}/subscription-success?session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${baseUrl}/subscription-cancel`;

        console.log('[Checkout] Creating session for:', { userId, planId });
        console.log('[Checkout] Environment variables check:', {
            STRIPE_STARTER_PRICE_ID: process.env.STRIPE_STARTER_PRICE_ID,
            STRIPE_GROWTH_PRICE_ID: process.env.STRIPE_GROWTH_PRICE_ID,
            STRIPE_TEAM_PRICE_ID: process.env.STRIPE_TEAM_PRICE_ID
        });
        
        const session = await pricingService.createCheckoutSession(
            userId,
            planId,
            successUrl,
            cancelUrl
        );

        res.json({ checkoutUrl: session.url });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Get interview pricing and balance
app.get('/api/pricing/interviews', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization token required' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userId = decodedToken.uid;

        if (!pricingService) {
            return res.status(503).json({ error: 'Pricing service not available' });
        }

        const balance = await pricingService.getInterviewBalance(userId);
        const pricing = pricingService.getInterviewPricing();

        res.json({
            bundles: pricing,
            userBalance: balance
        });
    } catch (error) {
        console.error('Error getting interview pricing:', error);
        res.status(500).json({ error: 'Failed to get interview pricing' });
    }
});

// Purchase additional interviews
app.post('/api/purchase/interviews', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization token required' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userId = decodedToken.uid;

        const { bundleType } = req.body;
        if (!bundleType) {
            return res.status(400).json({ error: 'Bundle type is required' });
        }

        if (!pricingService) {
            return res.status(503).json({ error: 'Pricing service not available' });
        }

        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        const successUrl = `${baseUrl}/interview-purchase-success?session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${baseUrl}/interview-purchase-cancel`;

        const session = await pricingService.createInterviewPurchaseSession(
            userId,
            bundleType,
            successUrl,
            cancelUrl
        );

        res.json({ checkoutUrl: session.url });
    } catch (error) {
        console.error('Error creating interview purchase session:', error);
        res.status(500).json({ error: 'Failed to create purchase session' });
    }
});

// Stripe webhook endpoint
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!endpointSecret) {
        console.error('Stripe webhook secret not configured');
        return res.status(400).send('Webhook secret not configured');
    }

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (!pricingService) {
        console.error('Pricing service not available for webhook');
        return res.status(503).send('Pricing service not available');
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed':
                const session = event.data.object;
                if (session.mode === 'subscription') {
                    const subscriptionId = session.subscription;
                    const customerId = session.customer;
                    const planId = session.metadata?.planId;
                    
                    if (planId) {
                        await pricingService.handleSubscriptionSuccess(subscriptionId, customerId, planId);
                        console.log(`Subscription created: ${subscriptionId} for plan: ${planId}`);
                    }
                } else if (session.mode === 'payment') {
                    // Handle interview purchase
                    const { bundleType } = session.metadata || {};
                    if (bundleType) {
                        await pricingService.handleInterviewPurchase(session.id);
                        console.log(`Interview bundle purchased: ${bundleType}`);
                    }
                }
                break;

            case 'customer.subscription.deleted':
                const subscription = event.data.object;
                await pricingService.handleSubscriptionCancellation(subscription.id);
                console.log(`Subscription canceled: ${subscription.id}`);
                break;

            case 'invoice.payment_failed':
                // Handle failed payments - could send email notification
                console.log('Payment failed for subscription:', event.data.object.subscription);
                break;

            default:
                console.log(`Unhandled event type: ${event.type}`);
        }

        res.json({ received: true });
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Webhook processing failed');
    }
});

// Get pricing plans (public endpoint)
app.get('/api/pricing-plans', (req, res) => {
    if (!pricingService) {
        return res.status(503).json({ error: 'Pricing service not available' });
    }

    const plans = pricingService.getPricingPlans();
    const freeTrialLimit = pricingService.getFreeTrialLimit();

    res.json({
        plans,
        freeTrialLimit
    });
});

// Testing endpoint to manually increment usage (for development only)
app.post('/api/test/increment-usage', async (req, res) => {
    // Only allow in development environment
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'This endpoint is only available in development' });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization token required' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userId = decodedToken.uid;

        if (!pricingService) {
            return res.status(503).json({ error: 'Pricing service not available' });
        }

        // Increment usage
        await pricingService.incrementInterviewUsage(userId);
        
        // Get updated subscription info
        const subscription = await pricingService.getUserSubscription(userId);
        const canComplete = await pricingService.canCompleteInterview(userId);

        res.json({
            message: 'Usage incremented successfully',
            subscription,
            canCompleteInterview: canComplete
        });
    } catch (error) {
        console.error('Error incrementing usage:', error);
        res.status(500).json({ error: 'Failed to increment usage' });
    }
});

// Testing endpoint to reset user usage (for development only)
app.post('/api/test/reset-usage', async (req, res) => {
    // Only allow in development environment
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'This endpoint is only available in development' });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization token required' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userId = decodedToken.uid;

        if (!db) {
            return res.status(503).json({ error: 'Database not available' });
        }

        // Get current user data before reset
        const userDocBefore = await db.collection('users').doc(userId).get();
        console.log(`[Reset Usage] User data BEFORE reset:`, userDocBefore.exists ? userDocBefore.data() : 'User document does not exist');

        // Reset user usage and ensure proper subscription structure
        await db.collection('users').doc(userId).update({
            'subscription.plan': 'free',
            'subscription.status': 'active',
            'subscription.currentPeriodStart': admin.firestore.FieldValue.serverTimestamp(),
            'subscription.currentPeriodEnd': null,
            'subscription.stripeCustomerId': null,
            'subscription.stripeSubscriptionId': null,
            'usage.interviewsCompleted': 0,
            'usage.currentPeriodUsage': 0,
            'usage.lastResetDate': admin.firestore.FieldValue.serverTimestamp()
        });

        // Get user data after reset
        const userDocAfter = await db.collection('users').doc(userId).get();
        console.log(`[Reset Usage] User data AFTER reset:`, userDocAfter.exists ? userDocAfter.data() : 'User document does not exist');

        // Get updated subscription info
        const subscription = await pricingService.getUserSubscription(userId);
        const canComplete = await pricingService.canCompleteInterview(userId);

        console.log(`[Reset Usage] Can complete interview: ${canComplete}`);
        console.log(`[Reset Usage] Subscription data:`, subscription);

        res.json({
            message: 'Usage reset successfully',
            subscription,
            canCompleteInterview: canComplete
        });
    } catch (error) {
        console.error('Error resetting usage:', error);
        res.status(500).json({ error: 'Failed to reset usage' });
    }
});

// --- END Pricing and Billing API Endpoints ---

// --- Memory Management API Endpoints ---

// Get memories for a user
app.get('/api/memories', 
    validators.limit,
    handleValidationErrors,
    async (req, res) => {
    const { interviewId, limit = 10 } = req.query;
    
    // Verify Firebase auth token
    let userEmail = null;
    let userUid = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
            const token = authHeader.split('Bearer ')[1];
            const decodedToken = await admin.auth().verifyIdToken(token);
            userEmail = decodedToken.email;
            userUid = decodedToken.uid;
        } catch (error) {
            return res.status(401).json({ error: 'Invalid authentication token' });
        }
    } else if (req.session?.email) {
        userEmail = req.session.email;
    } else {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    if (!memoryService) {
        return res.status(503).json({ error: 'Memory service not available' });
    }
    
    try {
        const memories = await memoryService.getUserMemories(
            userEmail,
            interviewId || null,
            null, // query
            parseInt(limit, 10)
        );
        
        const history = await memoryService.getInterviewHistory(userEmail);
        
        res.json({
            userEmail,
            interviewId: interviewId || 'all',
            memories: memories,
            history: history,
            count: memories.length
        });
    } catch (error) {
        console.error('Error retrieving memories:', error);
        res.status(500).json({ error: 'Failed to retrieve memories', details: error.message });
    }
});

// Delete memories for a user (only the user can delete their own memories)
app.delete('/api/memories', async (req, res) => {
    const { interviewId, sessionId } = req.body;
    
    // Verify Firebase auth token
    let userEmail = null;
    let userUid = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
            const token = authHeader.split('Bearer ')[1];
            const decodedToken = await admin.auth().verifyIdToken(token);
            userEmail = decodedToken.email;
            userUid = decodedToken.uid;
        } catch (error) {
            return res.status(401).json({ error: 'Invalid authentication token' });
        }
    } else {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    if (!memoryService) {
        return res.status(503).json({ error: 'Memory service not available' });
    }
    
    try {
        // For now, we don't have a direct delete method in the memory service
        // This would require implementing delete functionality in memoryService.js
        // For demonstration, return a not implemented response
        res.status(501).json({ 
            message: 'Memory deletion not yet implemented',
            note: 'Would delete memories for user: ' + userEmail 
        });
    } catch (error) {
        console.error('Error deleting memories:', error);
        res.status(500).json({ error: 'Failed to delete memories', details: error.message });
    }
});

// Get contextual memories (only for authenticated users)
app.post('/api/memories/contextual', async (req, res) => {
    const { interviewId, context } = req.body;
    
    // Verify Firebase auth token
    let userEmail = null;
    let userUid = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
            const token = authHeader.split('Bearer ')[1];
            const decodedToken = await admin.auth().verifyIdToken(token);
            userEmail = decodedToken.email;
            userUid = decodedToken.uid;
        } catch (error) {
            return res.status(401).json({ error: 'Invalid authentication token' });
        }
    } else {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    if (!interviewId || !context) {
        return res.status(400).json({ 
            error: 'interviewId and context are required' 
        });
    }
    
    if (!memoryService) {
        return res.status(503).json({ error: 'Memory service not available' });
    }
    
    try {
        const contextualMemories = await memoryService.getContextualMemories(
            userEmail,
            interviewId,
            context
        );
        
        res.json({
            userEmail,
            interviewId,
            contextualMemories
        });
    } catch (error) {
        console.error('Error retrieving contextual memories:', error);
        res.status(500).json({ error: 'Failed to retrieve contextual memories', details: error.message });
    }
});

// --- END Memory Management API Endpoints ---

// --- Torus Knot Configuration API Endpoints ---

// Get all torus configurations for the authenticated user
app.get('/api/torus-configs', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        let userId = null;
        
        // Try to get userId from authorization header
        if (authHeader && authHeader.startsWith('Bearer ')) {
            try {
                const idToken = authHeader.split('Bearer ')[1];
                const decodedToken = await admin.auth().verifyIdToken(idToken);
                userId = decodedToken.uid;
            } catch (error) {
                console.log('Failed to verify auth token, using session fallback');
            }
        }
        
        // Fallback to session for testing
        if (!userId && req.session) {
            userId = req.session.userId || 'test-user';
        }
        
        if (!userId) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        if (!db) {
            return res.status(503).json({ error: 'Database not available' });
        }

        const configs = [];
        const snapshot = await db.collection('users')
            .doc(userId)
            .collection('torusConfigs')
            .orderBy('timestamp', 'desc')
            .limit(20)
            .get();

        snapshot.forEach(doc => {
            configs.push({
                id: doc.id,
                ...doc.data()
            });
        });

        res.json(configs);
    } catch (error) {
        console.error('Error fetching torus configs:', error);
        res.status(500).json({ error: 'Failed to fetch configurations' });
    }
});

// Save a new torus configuration
app.post('/api/torus-configs', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        let userId = null;
        
        // Try to get userId from authorization header
        if (authHeader && authHeader.startsWith('Bearer ')) {
            try {
                const idToken = authHeader.split('Bearer ')[1];
                const decodedToken = await admin.auth().verifyIdToken(idToken);
                userId = decodedToken.uid;
            } catch (error) {
                console.log('Failed to verify auth token, using session fallback');
            }
        }
        
        // Fallback to session for testing
        if (!userId && req.session) {
            userId = req.session.userId || 'test-user';
        }
        
        if (!userId) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        if (!db) {
            return res.status(503).json({ error: 'Database not available' });
        }

        const {
            name,
            radius,
            tubeRadius,
            p,
            q,
            speed,
            textSize,
            bgColor
        } = req.body;

        // Validate input
        if (!name || typeof radius !== 'number' || typeof tubeRadius !== 'number' ||
            typeof p !== 'number' || typeof q !== 'number') {
            return res.status(400).json({ error: 'Invalid configuration data' });
        }

        const config = {
            name: name.substring(0, 100), // Limit name length
            radius,
            tubeRadius,
            p,
            q,
            speed,
            textSize,
            bgColor,
            timestamp: new Date().toISOString(),
            userId
        };

        const docRef = await db.collection('users')
            .doc(userId)
            .collection('torusConfigs')
            .add(config);

        res.json({
            id: docRef.id,
            ...config
        });
    } catch (error) {
        console.error('Error saving torus config:', error);
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// Delete a torus configuration
app.delete('/api/torus-configs/:configId', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        let userId = null;
        
        // Try to get userId from authorization header
        if (authHeader && authHeader.startsWith('Bearer ')) {
            try {
                const idToken = authHeader.split('Bearer ')[1];
                const decodedToken = await admin.auth().verifyIdToken(idToken);
                userId = decodedToken.uid;
            } catch (error) {
                console.log('Failed to verify auth token, using session fallback');
            }
        }
        
        // Fallback to session for testing
        if (!userId && req.session) {
            userId = req.session.userId || 'test-user';
        }
        
        if (!userId) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        if (!db) {
            return res.status(503).json({ error: 'Database not available' });
        }

        const { configId } = req.params;

        await db.collection('users')
            .doc(userId)
            .collection('torusConfigs')
            .doc(configId)
            .delete();

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting torus config:', error);
        res.status(500).json({ error: 'Failed to delete configuration' });
    }
});

// Graceful shutdown handling
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

let isShuttingDown = false;

async function gracefulShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    console.log('🔄 Graceful shutdown initiated...');
    
    // Notify all connected clients about upcoming shutdown
    io.emit('deploymentWarning', { 
        message: 'Server is restarting. Your interview will resume automatically.',
        timestamp: Date.now()
    });
    
    // Stop accepting new connections
    server.close(() => {
        console.log('✅ HTTP server closed');
    });
    
    // Give clients time to save their state (5 seconds)
    setTimeout(() => {
        console.log('📊 Active sessions:', sessionData.size);
        
        // Save all active session data to a backup
        if (sessionData.size > 0) {
            const sessionBackup = {};
            sessionData.forEach((session, sessionId) => {
                sessionBackup[sessionId] = {
                    responses: session.interviewResponses,
                    questionCount: session.assistantQuestions?.length || 0,
                    startTime: session.startTime,
                    cumulativeAudioDuration: session.totalRecordingDuration,
                    lastActivity: Date.now()
                };
            });
            
            // Save to file for recovery (in production, use Redis or database)
            const fs = require('fs');
            fs.writeFileSync('session-backup.json', JSON.stringify(sessionBackup, null, 2));
            console.log('💾 Session data backed up');
        }
        
        // Close all socket connections gracefully
        io.close(() => {
            console.log('✅ Socket.io closed');
            process.exit(0);
        });
        
        // Force exit after 10 seconds if graceful shutdown fails
        setTimeout(() => {
            console.error('⚠️ Forced shutdown after timeout');
            process.exit(1);
        }, 10000);
    }, 5000);
}

// --- END Torus Knot Configuration API Endpoints ---
