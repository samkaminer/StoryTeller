// Final Telling recorder — M4
// Manages camera/mic setup, Socket.IO + Deepgram streaming, upload, and re-record flow.

const params  = new URLSearchParams(window.location.search);
const storyId = params.get('storyId');

// ── Views ────────────────────────────────────────────────────────────────────
function showView(name) {
  ['setup', 'ready', 'recording', 'uploading', 'retake'].forEach(v => {
    const el = document.getElementById('view-' + v);
    el.classList.toggle('active', v === name);
  });
}

function showSetupError(msg) {
  const err = document.getElementById('setup-error');
  document.getElementById('setup-error-msg').textContent = msg;
  err.style.display = 'block';
  document.querySelector('#view-setup .pulse-dots').style.display = 'none';
}

// ── Timer ────────────────────────────────────────────────────────────────────
let timerInterval = null;
let elapsedSeconds = 0;

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m + ':' + String(sec).padStart(2, '0');
}

function startTimer(onAutoStop) {
  const timerEl     = document.getElementById('timer');
  const warningEl   = document.getElementById('warningBanner');
  elapsedSeconds = 0;

  timerInterval = setInterval(() => {
    elapsedSeconds++;
    timerEl.textContent = formatTime(elapsedSeconds);

    // Warning thresholds
    if (elapsedSeconds >= 210) { // 3:30 — hard stop
      clearInterval(timerInterval);
      timerInterval = null;
      timerEl.className = 'timer red';
      warningEl.className = 'warning-banner red';
      warningEl.textContent = 'Time\'s up.';
      onAutoStop();
    } else if (elapsedSeconds >= 180) { // 3:00
      timerEl.className = 'timer red';
      warningEl.className = 'warning-banner red';
      warningEl.textContent = 'Final moments — keep going';
    } else if (elapsedSeconds >= 150) { // 2:30
      timerEl.className = 'timer orange';
      warningEl.className = 'warning-banner orange';
      warningEl.textContent = '30 seconds to go';
    } else if (elapsedSeconds >= 120) { // 2:00
      timerEl.className = 'timer amber';
      warningEl.className = 'warning-banner amber';
      warningEl.textContent = '2 minutes — wrap up soon';
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// ── Live transcript ───────────────────────────────────────────────────────────
function setLiveTranscript(text) {
  const el = document.getElementById('liveTranscript');
  el.textContent = text;
  el.scrollTop = el.scrollHeight;
}

// ── MIME type selection ───────────────────────────────────────────────────────
function chooseMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
    'video/mp4',
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function chooseAudioMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

// ── State ─────────────────────────────────────────────────────────────────────
let socket       = null;
let reportId     = null;
let responseDocId = null;
let interviewId  = null;
let videoStream  = null;
let audioStream  = null;
let mainRecorder = null;   // video+audio for upload blob
let dgRecorder   = null;   // audio-only for Deepgram
let mainChunks   = [];
let rerecordUsed = false;
let stopTriggered = false; // prevent double-stop

// ── Socket.IO ─────────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io(window.location.origin, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    socket.emit('startFinalTelling', { storyId });
  });

  socket.on('finalTellingReady', (data) => {
    reportId      = data.reportId;
    responseDocId = data.responseDocId;
    interviewId   = data.interviewId;
  });

  socket.on('finalTellingError', (data) => {
    showSetupError(data.message || 'Something went wrong. Please try again.');
    showView('setup');
  });

  socket.on('interimTranscript', (text) => {
    setLiveTranscript(text);
  });

  socket.on('finalSegment', ({ transcript }) => {
    if (transcript) setLiveTranscript(transcript);
  });

  socket.on('finalTellingEnded', () => {
    // transcript saved — proceed to upload
    uploadRecording();
  });

  socket.on('connect_error', () => {
    // non-fatal — recording can still proceed; transcript may be incomplete
    console.warn('[final-recorder] socket connect error');
  });
}

// ── Camera + mic setup ────────────────────────────────────────────────────────
async function setupStreams() {
  // Portrait video
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1080, min: 480 },
        height: { ideal: 1920, min: 720 },
        frameRate: { ideal: 30, min: 15 },
        facingMode: 'user',
        aspectRatio: { ideal: 9 / 16 },
      },
      audio: false,
    });
  } catch (e) {
    if (e.name === 'OverconstrainedError') {
      try {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (e2) {
        videoStream = null;
      }
    } else {
      videoStream = null;
    }
  }

  // Microphone
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const msg = e.name === 'NotAllowedError'
      ? 'Microphone access was denied. Please allow it and reload.'
      : 'Could not access microphone: ' + e.message;
    showSetupError(msg);
    return false;
  }

  return true;
}

function attachPreviews() {
  const combinedTracks = [
    ...(audioStream ? audioStream.getTracks() : []),
    ...(videoStream ? videoStream.getTracks() : []),
  ];
  const previewStream = new MediaStream(combinedTracks);

  const readyVid = document.getElementById('previewReady');
  readyVid.srcObject = previewStream;
  readyVid.play().catch(() => {});

  const recVid = document.getElementById('previewRecording');
  recVid.srcObject = previewStream;
  recVid.play().catch(() => {});
}

// ── Recording ─────────────────────────────────────────────────────────────────
function startRecording() {
  stopTriggered = false;
  mainChunks = [];

  // Combined stream for the upload blob
  const tracks = [
    ...(audioStream ? audioStream.getTracks() : []),
    ...(videoStream ? videoStream.getTracks() : []),
  ];
  const combined = new MediaStream(tracks);

  const mimeType = chooseMimeType();
  const opts = mimeType ? { mimeType } : {};
  try {
    mainRecorder = new MediaRecorder(combined, opts);
  } catch (e) {
    mainRecorder = new MediaRecorder(combined);
  }
  mainRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) mainChunks.push(e.data);
  };
  mainRecorder.start(1000);

  // Audio-only stream for Deepgram
  if (socket && audioStream) {
    const audioMime = chooseAudioMimeType();
    const dgOpts = audioMime ? { mimeType: audioMime } : {};
    try {
      dgRecorder = new MediaRecorder(audioStream, dgOpts);
    } catch (e) {
      dgRecorder = new MediaRecorder(audioStream);
    }
    dgRecorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0 && socket && socket.connected) {
        try {
          const buf = await e.data.arrayBuffer();
          socket.emit('audioChunkToServer', buf);
        } catch (_) {}
      }
    };

    socket.emit('startDeepgramStream');
    socket.once('deepgramStreamOpened', () => {
      dgRecorder.start(250);
    });
    // If Deepgram doesn't open in 3s, start anyway (upload will still work)
    setTimeout(() => {
      if (dgRecorder && dgRecorder.state === 'inactive') {
        try { dgRecorder.start(250); } catch (_) {}
      }
    }, 3000);
  }

  startTimer(() => stopRecording(true));
}

async function stopRecording(isAutoStop = false) {
  if (stopTriggered) return;
  stopTriggered = true;
  stopTimer();

  // Stop Deepgram audio recorder
  if (dgRecorder && dgRecorder.state !== 'inactive') {
    try { dgRecorder.stop(); } catch (_) {}
  }

  // Stop main recorder — wait for final chunk
  await new Promise((resolve) => {
    if (!mainRecorder || mainRecorder.state === 'inactive') { resolve(); return; }
    mainRecorder.onstop = resolve;
    try { mainRecorder.stop(); } catch (_) { resolve(); }
  });

  showView('uploading');

  // Signal server to close Deepgram and save transcript
  if (socket && socket.connected) {
    socket.emit('stopDeepgramStream');
    // Give Deepgram 1.5s to flush final words, then emit stopFinalTelling
    await new Promise(r => setTimeout(r, 1500));
    socket.emit('stopFinalTelling');
    // Wait for server ack (max 8s) before proceeding
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 8000);
      socket.once('finalTellingEnded', () => { clearTimeout(t); resolve(); });
    });
    uploadRecording();
  } else {
    uploadRecording();
  }
}

async function uploadRecording() {
  showView('uploading');

  if (!interviewId || !reportId || !responseDocId) {
    // Can't upload without IDs — skip to result
    redirectToResult();
    return;
  }

  const audioTracks = mainChunks.filter(c => c.size > 0);
  if (audioTracks.length === 0) {
    redirectToResult();
    return;
  }

  const blobMime = mainChunks[0].type || chooseMimeType() || 'video/webm';
  const blob = new Blob(mainChunks, { type: blobMime });

  const fd = new FormData();
  const isVideo = blobMime.startsWith('video/') && videoStream;
  if (isVideo) {
    fd.append('video', blob, 'final-telling' + (blobMime.includes('mp4') ? '.mp4' : '.webm'));
    // audio-only fallback blob from audioStream if available
    const audioBlob = new Blob(mainChunks, { type: 'audio/webm' });
    fd.append('audio', audioBlob, 'final-telling.webm');
  } else {
    fd.append('audio', blob, 'final-telling.webm');
  }
  fd.append('responseDocId', responseDocId);
  fd.append('persistentSessionId', reportId);

  try {
    const res = await fetch(`/api/interviews/${encodeURIComponent(interviewId)}/upload-recording`, {
      method: 'POST',
      body: fd,
    });
    if (!res.ok) console.warn('[final-recorder] upload responded', res.status);
  } catch (err) {
    console.error('[final-recorder] upload error:', err);
  }

  redirectToResult();
}

function redirectToResult() {
  // If user has used their re-record or this is first take finishing naturally,
  // decide whether to offer retake or go straight to result.
  if (!rerecordUsed) {
    rerecordUsed = true;
    showView('retake');
  } else {
    window.location.href = '/story-result.html?storyId=' + encodeURIComponent(storyId);
  }
}

// ── Re-record ─────────────────────────────────────────────────────────────────
function startRetake() {
  // Reset timer display
  document.getElementById('timer').textContent = '0:00';
  document.getElementById('timer').className = 'timer';
  document.getElementById('warningBanner').className = 'warning-banner';
  document.getElementById('liveTranscript').textContent = '';
  mainChunks = [];

  // Re-init Deepgram session for second take
  if (socket && socket.connected) {
    socket.emit('startFinalTelling', { storyId });
    socket.once('finalTellingReady', (data) => {
      reportId      = data.reportId;
      responseDocId = data.responseDocId;
      interviewId   = data.interviewId;
    });
  }

  showView('ready');
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function init() {
  if (!storyId) {
    window.location.href = '/story.html';
    return;
  }

  showView('setup');
  connectSocket();

  const ok = await setupStreams();
  if (!ok) return;

  attachPreviews();
  showView('ready');

  document.getElementById('startBtn').addEventListener('click', () => {
    showView('recording');
    startRecording();
  });

  document.getElementById('stopBtn').addEventListener('click', () => {
    stopRecording(false);
  });

  document.getElementById('retakeBtn').addEventListener('click', () => {
    startRetake();
  });
}

firebase.auth().onAuthStateChanged(user => {
  if (!user) { window.location.href = '/story.html'; return; }
  init();
});
