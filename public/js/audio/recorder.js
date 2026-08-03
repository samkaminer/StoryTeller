// Audio recorder module - handles all recording functionality
import { state, resetRecordingState as resetStateRecording, resetAudioState, resetVideoState, resetDeepgramState } from '../state.js';
import { elements } from '../dom.js';
import { config } from '../config.js';
import { streamingTTS } from './streaming-tts.js';
// Use window functions since utils.js is not a module anymore
const showError = window.showError;
const clearError = window.clearError;
const formatTime = window.formatTime;
const getMimeType = window.getMimeType;
const showInfo = window.showInfo;
import { enableInput, disableInput, clearStatus, updateRecordingStatus, updateRecordingProgressUI } from '../ui/controls.js';
// Conditionally handle video functions based on whether video is enabled
let startVideoRecording, stopVideoRecording, pauseVideoRecording, resumeVideoRecording, getVideoBlob, isVideoAvailable;

// Only import video functions if needed - we'll check state.video.isEnabled at runtime
const videoFunctions = {
    startVideoRecording: async () => {
        if (state.video.isEnabled) {
            const module = await import('./video-recorder.js');
            return module.startVideoRecording();
        }
    },
    stopVideoRecording: async () => {
        if (state.video.isEnabled) {
            const module = await import('./video-recorder.js');
            return module.stopVideoRecording();
        }
    },
    pauseVideoRecording: async () => {
        if (state.video.isEnabled) {
            const module = await import('./video-recorder.js');
            return module.pauseVideoRecording();
        }
    },
    resumeVideoRecording: async () => {
        if (state.video.isEnabled) {
            const module = await import('./video-recorder.js');
            return module.resumeVideoRecording();
        }
    },
    getVideoBlob: () => {
        if (state.video.isEnabled && state.video.recordedBlob) {
            return state.video.recordedBlob;
        }
        return null;
    },
    isVideoAvailable: () => {
        return state.video.isEnabled && state.video.recordedBlob && state.video.recordedBlob.size > 0;
    }
};

// Assign to variables for backward compatibility
startVideoRecording = videoFunctions.startVideoRecording;
stopVideoRecording = videoFunctions.stopVideoRecording;
pauseVideoRecording = videoFunctions.pauseVideoRecording;
resumeVideoRecording = videoFunctions.resumeVideoRecording;
getVideoBlob = videoFunctions.getVideoBlob;
isVideoAvailable = videoFunctions.isVideoAvailable;

// Audio level monitoring state
let audioContext = null;
let analyserNode = null;
let levelRafId = null;
let peakLevelSeen = 0;

// Initialize microphone and MediaRecorder
export async function setupMicrophone() {
    if (state.audio.mediaRecorder) {
        console.log('Microphone already set up.');
        return true;
    }
    
    try {
        console.log('Requesting microphone access for setup/restore...');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.audio.stream = stream;
        console.log('Microphone access granted');
        
        const mimeType = getMimeType();
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        const options = {};
        
        // Safari-specific adjustments
        if (isSafari) {
            // Don't specify audioBitsPerSecond for Safari as it can cause issues
            console.log('Safari detected - using minimal MediaRecorder options');
            if (mimeType) {
                options.mimeType = mimeType;
            }
        } else {
            options.audioBitsPerSecond = config.recording.audioBitsPerSecond;
            if (mimeType) options.mimeType = mimeType;
        }

        console.log('Creating MediaRecorder with options:', options);
        state.audio.mediaRecorder = new MediaRecorder(stream, options);
        state.audio.chunks = [];

        // Buffer to store audio chunks during Deepgram disconnection
        state.audio.audioBuffer = state.audio.audioBuffer || [];
        state.audio.isBuffering = state.audio.isBuffering || false;

        state.audio.mediaRecorder.ondataavailable = async (event) => {
            if (event.data.size > 0) {
                state.audio.chunks.push(event.data);
                console.log(`[CHUNK] Audio chunk collected at ${new Date().toISOString()}. Total: ${state.audio.chunks.length}, Size: ${event.data.size}, Recording: ${state.recording.isRecording}`);
                // Send audio chunks if we're recording and connected, even if streamActive hasn't been confirmed yet
                // This prevents losing audio if deepgramStreamOpened event is delayed
                if (state.recording.isRecording && state.socket.connected) {
                    try {
                        // Safari may need blob to be converted to ArrayBuffer
                        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
                        let dataToSend;
                        if (isSafari && event.data instanceof Blob) {
                            dataToSend = await event.data.arrayBuffer();
                        } else {
                            dataToSend = event.data;
                        }

                        // If Deepgram is not active, buffer the audio
                        if (!state.deepgram.streamActive) {
                            if (!state.audio.isBuffering) {
                                console.log('[Deepgram] Stream not active, starting to buffer audio chunks');
                                state.audio.isBuffering = true;
                            }
                            state.audio.audioBuffer.push(dataToSend);
                            console.log(`[Deepgram] Buffered chunk ${state.audio.audioBuffer.length} while stream is inactive`);
                        } else {
                            // If we were buffering and now connected, send buffered chunks first
                            if (state.audio.isBuffering && state.audio.audioBuffer.length > 0) {
                                console.log(`[Deepgram] Stream active, sending ${state.audio.audioBuffer.length} buffered chunks`);
                                for (const bufferedChunk of state.audio.audioBuffer) {
                                    state.socket.instance.emit('audioChunkToServer', bufferedChunk);
                                }
                                state.audio.audioBuffer = []; // Clear buffer
                                state.audio.isBuffering = false;
                            }
                            
                            // Send current chunk
                            state.socket.instance.emit('audioChunkToServer', dataToSend);
                        }
                    } catch (error) {
                        console.error('Error sending audio chunk:', error);
                    }
                }
            }
        };

        state.audio.mediaRecorder.onstop = async () => {
            console.log(`[ONSTOP] MediaRecorder onstop handler fired at ${new Date().toISOString()}`);
            console.log(`[ONSTOP] Collected chunks count: ${state.audio.chunks.length}`);
            
            if (state.recording.timer) {
                clearInterval(state.recording.timer);
                state.recording.timer = null;
            }
            
            state.recording.duration = 0;
            state.recording.isRecording = false;
            state.recording.isPaused = false;

            if (elements.pauseBtn) {
                elements.pauseBtn.disabled = true;
                elements.pauseBtn.classList.remove('paused');
                elements.pauseBtn.title = 'Pause Recording (or press Space)';
            }
            
            if (elements.recordingStatus) {
                elements.recordingStatus.innerHTML = '';
            }

            // Create the full audio blob from collected chunks
            if (state.audio.chunks.length > 0) {
                const currentMimeType = state.audio.chunks[0].type || getMimeType() || 'audio/webm';
                state.audio.recordedBlob = new Blob(state.audio.chunks, { type: currentMimeType });
                console.log(`[AudioSave] Recorded audio blob created. Size: ${state.audio.recordedBlob.size}, Type: ${state.audio.recordedBlob.type}`);
            } else {
                console.warn('[AudioSave] No audio chunks recorded to create a blob.');
                state.audio.recordedBlob = null;
                state.audio.chunks = [];
            }
            
            // Flush any buffered audio chunks before stopping Deepgram
            if (state.audio.isBuffering && state.audio.audioBuffer.length > 0 && state.deepgram.streamActive) {
                console.log(`[ONSTOP] Flushing ${state.audio.audioBuffer.length} buffered audio chunks before stopping Deepgram`);
                for (const bufferedChunk of state.audio.audioBuffer) {
                    state.socket.instance.emit('audioChunkToServer', bufferedChunk);
                }
                state.audio.audioBuffer = [];
                state.audio.isBuffering = false;
            }

            // Delay to ensure final audio chunks are sent before stopping Deepgram
            const stopDelay = 300; // 300ms delay to ensure final chunks are processed
            console.log(`[ONSTOP] Scheduling stopDeepgramStream check in ${stopDelay}ms...`);
            setTimeout(() => {
                console.log(`[ONSTOP] ${stopDelay}ms delay complete at ${new Date().toISOString()}`);
                console.log(`[ONSTOP] Current transcript: "${state.deepgram.accumulatedTranscript}"`);
                console.log(`[ONSTOP] Deepgram stream active: ${state.deepgram.streamActive}`);
                // Check for minimum recording duration (at least 0.5 seconds)
                const recordingDuration = state.recording.currentAnswerDuration;
                if (recordingDuration < 0.5) {
                    console.warn('[Recording] Recording too short:', recordingDuration, 'seconds');
                    showError("Please speak clearly and try again.");
                    
                    // Reset UI state - MUST set thinking to false BEFORE calling resetRecordingState
                    state.ui.thinking = false;
                    enableInput();
                    resetRecordingState();
                    resetDeepgramState();
                    resetAudioState();
                    resetVideoState();
                    
                    // Clear any recording status
                    if (elements.recordingStatus) {
                        elements.recordingStatus.innerHTML = '';
                        elements.recordingStatus.classList.remove('recording');
                    }
                    
                    return; // Don't continue processing
                }
                
                if (!state.deepgram.accumulatedTranscript || state.deepgram.accumulatedTranscript.trim().length === 0) {
                    console.warn('[Recording] No transcript captured. Peak audio level seen:', peakLevelSeen);
                    const msg = peakLevelSeen < 0.03
                        ? "Microphone not picking up audio. On Mac, check System Settings → Privacy & Security → Microphone and make sure your browser is enabled."
                        : "Having trouble hearing you. Please speak up, check your microphone, and try again.";
                    showError(msg);
                    
                    // Reset UI state - MUST set thinking to false BEFORE calling resetRecordingState
                    state.ui.thinking = false;
                    enableInput();
                    resetRecordingState();
                    resetDeepgramState();
                    resetAudioState();
                    resetVideoState();
                    
                    // Clear any recording status
                    if (elements.recordingStatus) {
                        elements.recordingStatus.innerHTML = '';
                        elements.recordingStatus.classList.remove('recording');
                    }
                    
                    return; // Don't continue processing
                }
                
                // Normal flow - stop Deepgram stream
                if (state.deepgram.streamActive) {
                    console.log(`[ONSTOP] Sending stopDeepgramStream to server at ${new Date().toISOString()}`);
                    console.log(`[ONSTOP] Final transcript before stop: "${state.deepgram.accumulatedTranscript}"`);
                    state.socket.instance.emit('stopDeepgramStream');
                } else {
                    console.warn(`[ONSTOP] Deepgram stream not active, not sending stop signal`);
                }
            }, stopDelay); // Dynamic delay based on Deepgram config
        };

        console.log('Audio recording setup complete');
        enableInput();
        return true;
    } catch (error) {
        console.error('Error accessing microphone during setup/restore:', error);
        if (elements.recordBtn) {
            elements.recordBtn.disabled = true;
            elements.recordBtn.title = 'Microphone access denied';
        }
        showError('Microphone access denied. Please allow microphone access and refresh.');
        return false;
    }
}

// ── Audio level monitoring ────────────────────────────────────────────────────
function startLevelMonitoring() {
    if (!state.audio.stream) return;
    peakLevelSeen = 0;
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(state.audio.stream);
        analyserNode = audioContext.createAnalyser();
        analyserNode.fftSize = 256;
        source.connect(analyserNode);
        const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
        const indicator = document.getElementById('micLevelIndicator');

        function tick() {
            if (!analyserNode) return;
            analyserNode.getByteFrequencyData(dataArray);
            // RMS of frequency bins as a 0–1 level
            const rms = Math.sqrt(dataArray.reduce((s, v) => s + v * v, 0) / dataArray.length) / 128;
            if (rms > peakLevelSeen) peakLevelSeen = rms;
            if (indicator) {
                const bars = indicator.querySelectorAll('.mic-bar');
                const thresholds = [0.04, 0.10, 0.18, 0.28, 0.40];
                bars.forEach((bar, i) => {
                    bar.classList.toggle('active', rms >= thresholds[i]);
                });
            }
            levelRafId = requestAnimationFrame(tick);
        }
        tick();
    } catch (e) {
        console.warn('[AudioLevel] Could not start level monitoring:', e);
    }
}

function stopLevelMonitoring() {
    if (levelRafId) { cancelAnimationFrame(levelRafId); levelRafId = null; }
    if (analyserNode) { analyserNode.disconnect(); analyserNode = null; }
    if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
    const indicator = document.getElementById('micLevelIndicator');
    if (indicator) {
        indicator.querySelectorAll('.mic-bar').forEach(b => b.classList.remove('active'));
    }
}

// Toggle recording on/off
// Add debounce flag to prevent double-clicks
let isProcessingToggle = false;

export async function toggleRecording() {
    console.log(`[TOGGLE] toggleRecording called at ${new Date().toISOString()}`);
    // Prevent double-clicks
    if (isProcessingToggle) {
        console.log('[TOGGLE] Already processing, ignoring click');
        return;
    }
    
    clearError();

    if (!state.audio.mediaRecorder) {
        showError('Microphone not available or access denied.');
        return;
    }

    if (state.ui.thinking) {
        console.log("Cannot record while AI is thinking.");
        return;
    }

    // Prevent recording if question is still being typed out
    if (state.ui.isStreamingResponse || state.ui.typewriterTimeout) {
        console.log("Cannot record while question is still being displayed.");
        return;
    }

    // If recording, check if we meet the minimum requirements to stop
    if (state.recording.isRecording) {
        const recordingDuration = (Date.now() - state.recording.startTime) / 1000; // in seconds
        const hasEnoughWords = state.deepgram.transcribedWordCount >= 3;
        const hasEnoughTime = recordingDuration >= 1;
        
        if (!hasEnoughWords && !hasEnoughTime) {
            console.log(`Cannot stop yet - Words: ${state.deepgram.transcribedWordCount}, Time: ${recordingDuration.toFixed(1)}s`);
            showInfo('Keep speaking... (3+ words or 1+ second required)');
            return;
        }
    }

    // Handle existing Deepgram stream
    if (state.deepgram.streamActive && !state.recording.isRecording) {
        console.warn("Attempting to start recording while a Deepgram stream is already active. Resetting.");
        state.socket.instance.emit('stopDeepgramStream');
        resetDeepgramUI();
    }

    try {
        isProcessingToggle = true;
        
        if (state.recording.isRecording) {
            await stopRecording();
        } else {
            await startRecording();
        }
    } catch (error) {
        console.error('Error in toggleRecording:', error);
        showError('Error during recording: ' + error.message);
        resetRecordingState();
    } finally {
        // Reset the flag after a small delay to prevent rapid re-clicks
        setTimeout(() => {
            isProcessingToggle = false;
        }, 300);
    }
}

// Start recording
async function startRecording() {
    state.recording.startTime = Date.now();
    console.log(`⏱️ CLIENT TIMING - Recording started at ${new Date().toISOString()}`);
    console.log('Starting recording...');
    
    // Stop any ongoing TTS when user starts recording
    if (config.features.enableTTS && streamingTTS.isAvailable()) {
        streamingTTS.stop();
    }
    
    state.recording.isPaused = false;

    // Check recorder state before starting
    if (state.audio.mediaRecorder.state !== 'inactive') {
        console.warn(`MediaRecorder not inactive (state: ${state.audio.mediaRecorder.state}), attempting to stop before starting.`);
        try {
            state.audio.mediaRecorder.stop();
            await new Promise(resolve => setTimeout(resolve, 150));
            if (state.audio.mediaRecorder.state !== 'inactive') {
                console.error('MediaRecorder did not become inactive after stop attempt.');
                showError('Could not start recording. Please try again.');
                return;
            }
        } catch (stopError) {
            console.error('Error stopping mediaRecorder before starting:', stopError);
            showError('Warning: Could not cleanly stop previous recording state.');
        }
    }

    // Only clear chunks and blob AFTER ensuring MediaRecorder is stopped
    state.audio.chunks = [];
    state.audio.recordedBlob = null;
    state.audio.audioBuffer = [];
    state.audio.isBuffering = false;
    
    // Safari needs different chunk intervals for reliable transcription
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const chunkInterval = isSafari ? 250 : config.recording.chunkInterval; // 250ms for Safari, default for others
    
    state.audio.mediaRecorder.start(chunkInterval);
    console.log('MediaRecorder started');
    state.recording.isRecording = true;
    state.recording.startTime = Date.now();
    
    // Start video recording if enabled
    startVideoRecording();
    
    // Clear accumulated transcript and word count for new recording
    state.deepgram.accumulatedTranscript = '';
    state.deepgram.transcribedWordCount = 0;

    // Inform server to start Deepgram stream
    console.log('[Deepgram] Sending startDeepgramStream to server.');
    state.socket.instance.emit('startDeepgramStream');
    
    // Set a timeout to check if stream opened
    setTimeout(() => {
        if (!state.deepgram.streamActive) {
            console.error('[Deepgram] WARNING: Stream did not open within 3 seconds!');
            console.error('[Deepgram] Current state:', {
                streamActive: state.deepgram.streamActive,
                socketConnected: state.socket.connected,
                isRecording: state.recording.isRecording
            });
        }
    }, 3000);
    
    startLevelMonitoring();
    createInterimTranscriptDisplay();

    if (elements.pauseBtn) {
        elements.pauseBtn.disabled = false;
        elements.pauseBtn.classList.remove('paused');
        elements.pauseBtn.title = 'Pause Recording (or press Space)';
        elements.pauseBtn.classList.remove('hidden');
    }

    if (elements.recordBtn) {
        elements.recordBtn.classList.add('recording');
        elements.recordBtn.classList.add('disabled-recording');
        elements.recordBtn.disabled = true; // Keep disabled until 3+ words
        elements.recordBtn.title = 'Keep speaking... (3+ words required)';
    }
    
    // Add recording class to parent wrapper for circular progress
    const recordingWrapper = document.querySelector('.recording-visual-feedback');
    if (recordingWrapper) {
        recordingWrapper.classList.add('recording');
    }

    // Start timers
    state.recording.duration = 0;
    state.recording.currentAnswerDuration = 0;
    updateRecordingStatus();
    
    state.recording.timer = setInterval(() => {
        state.recording.duration++;
        state.recording.currentAnswerDuration++;
        updateRecordingStatus();
        
        // Enable button after 1 second even if no words transcribed yet
        if (state.recording.duration >= 1 && elements.recordBtn && elements.recordBtn.disabled) {
            console.log('[Recording] Enabling stop button - 1+ second elapsed');
            elements.recordBtn.disabled = false;
            elements.recordBtn.classList.remove('disabled-recording');
            elements.recordBtn.title = 'Submit Recording';
        }
        
        if (state.recording.duration >= config.recording.maxRecordingDurationSeconds) {
            console.log('Auto-stopping recording after 4 minutes');
            showError('Recording automatically stopped after 4 minutes.');
            toggleRecording();
        }
    }, 1000);
    
    if (state.recording.progressTimer) clearInterval(state.recording.progressTimer);
    state.recording.progressTimer = setInterval(() => {
        if (state.recording.isRecording && !state.recording.isPaused) {
            updateRecordingProgressUI();
        }
    }, config.ui.progressUpdateInterval);
}

// Stop recording
async function stopRecording() {
    stopLevelMonitoring();
    console.log(`[STOP] stopRecording called at ${new Date().toISOString()}`);
    console.log(`[STOP] MediaRecorder state: ${state.audio.mediaRecorder.state}`);
    console.log(`[STOP] Deepgram stream active: ${state.deepgram.streamActive}`);
    console.log(`[STOP] Audio chunks collected: ${state.audio.chunks.length}`);
    
    // Debug logging for timing
    console.log('[STOP] Timing info:', {
        accumulatedTime: state.recording.accumulatedTime,
        duration: state.recording.duration,
        newAccumulatedTime: state.recording.accumulatedTime + state.recording.duration
    });
    
    // Add current recording duration to accumulated time first
    state.recording.accumulatedTime += state.recording.duration;
    
    if (state.recording.timer) {
        clearInterval(state.recording.timer);
        state.recording.timer = null;
    }
    
    // Clear the progress timer to prevent UI updates during thinking state
    if (state.recording.progressTimer) {
        clearInterval(state.recording.progressTimer);
        state.recording.progressTimer = null;
    }
    
    state.recording.isRecording = false;
    
    updateRecordingProgressUI();
    state.socket.instance.emit('updateTotalRecordingTime', { totalTime: state.recording.accumulatedTime });
    
    // Add a small delay before stopping to capture final audio
    console.log(`[STOP] Scheduling MediaRecorder.stop() in 300ms...`);
    
    // Request final data multiple times to ensure we get all audio
    if (state.audio.mediaRecorder && state.audio.mediaRecorder.state === 'recording') {
        console.log(`[STOP] Requesting final data from MediaRecorder...`);
        
        // Request data multiple times with small delays
        for (let i = 0; i < 3; i++) {
            setTimeout(() => {
                if (state.audio.mediaRecorder && state.audio.mediaRecorder.state === 'recording') {
                    try {
                        console.log(`[STOP] requestData attempt ${i + 1} at ${new Date().toISOString()}`);
                        state.audio.mediaRecorder.requestData();
                    } catch (e) {
                        console.log(`[STOP] requestData ${i + 1} failed:`, e);
                    }
                }
            }, i * 100); // 0ms, 100ms, 200ms
        }
    }
    
    setTimeout(() => {
        console.log(`[STOP] 300ms delay complete at ${new Date().toISOString()}`);
        if (state.audio.mediaRecorder && (state.audio.mediaRecorder.state === 'recording' || state.audio.mediaRecorder.state === 'paused')) {
            // One final request for data just before stopping
            try {
                state.audio.mediaRecorder.requestData();
            } catch (e) {
                console.log(`[STOP] Final requestData failed:`, e);
            }
            console.log(`[STOP] Calling MediaRecorder.stop() now. State: ${state.audio.mediaRecorder.state}`);
            state.audio.mediaRecorder.stop();
            // Stop video recording too
            stopVideoRecording();
        } else {
            console.warn(`[STOP] MediaRecorder not in recording state: ${state.audio.mediaRecorder?.state}`);
            resetRecordingState();
        }
    }, 300); // Increased to 300ms to ensure all audio is captured
    
    // Update UI to thinking state
    state.ui.thinking = true;
    state.recording.isPaused = false;
    
    if (elements.pauseBtn) {
        elements.pauseBtn.disabled = true;
        elements.pauseBtn.classList.remove('paused');
        elements.pauseBtn.classList.add('hidden');
        elements.pauseBtn.title = 'Pause Recording (or press Space)';
    }
    
    if (elements.recordBtn) {
        elements.recordBtn.classList.remove('recording');
        elements.recordBtn.classList.add('thinking');
        elements.recordBtn.disabled = true;
        elements.recordBtn.title = 'Interviewer is thinking...';
        
        // Remove recording class from parent wrapper
        const recordingWrapper = document.querySelector('.recording-visual-feedback');
        if (recordingWrapper) {
            recordingWrapper.classList.remove('recording');
        }
        
        // Add thinking ellipses to the button
        const recordBtnInner = elements.recordBtn.querySelector('.record-btn-inner');
        if (recordBtnInner) {
            recordBtnInner.innerHTML = `
                <div class="thinking-ellipses">
                    <span class="ellipse-dot"></span>
                    <span class="ellipse-dot"></span>
                    <span class="ellipse-dot"></span>
                </div>
            `;
        }
    }
    
    if (elements.recordingStatus) {
        const statusText = elements.recordingStatus.querySelector('.status-text');
        if (statusText) {
            statusText.textContent = `Answer: ${formatTime(state.recording.currentAnswerDuration)} • Processing audio...`;
        }
        elements.recordingStatus.classList.remove('recording');
    }
    
    disableInput();
}

// Toggle pause
export function togglePause() {
    if (!state.recording.isRecording || !state.audio.mediaRecorder) return;

    if (state.recording.isPaused) {
        resumeRecording();
    } else {
        pauseRecording();
    }
}

// Pause recording
function pauseRecording() {
    state.audio.mediaRecorder.pause();
    pauseVideoRecording();
    state.recording.isPaused = true;

    if (state.recording.timer) {
        clearInterval(state.recording.timer);
        state.recording.timer = null;
    }
    
    if (state.recording.progressTimer) {
        clearInterval(state.recording.progressTimer);
        state.recording.progressTimer = null;
    }

    if (elements.pauseBtn) {
        elements.pauseBtn.classList.add('paused');
        elements.pauseBtn.title = 'Resume Recording (or press Space)';
    }

    updateRecordingStatus();
}

// Resume recording
function resumeRecording() {
    state.audio.mediaRecorder.resume();
    resumeVideoRecording();
    state.recording.isPaused = false;

    if (elements.pauseBtn) {
        elements.pauseBtn.classList.remove('paused');
        elements.pauseBtn.title = 'Pause Recording (or press Space)';
    }

    if (!state.recording.timer) {
        state.recording.timer = setInterval(() => {
            state.recording.duration++;
            state.recording.currentAnswerDuration++;
            updateRecordingStatus();
            
            if (state.recording.duration >= config.recording.maxRecordingDurationSeconds) {
                console.log('Auto-stopping recording after 4 minutes');
                showError('Recording automatically stopped after 4 minutes.');
                toggleRecording();
            }
        }, 1000);
    }
    
    if (!state.recording.progressTimer) {
        state.recording.progressTimer = setInterval(() => {
            if (state.recording.isRecording && !state.recording.isPaused) {
                updateRecordingProgressUI();
            }
        }, config.ui.progressUpdateInterval);
    }

    updateRecordingStatus();
}

// Reset recording state
export function resetRecordingState() {
    resetStateRecording();
    
    if (elements.recordBtn) {
        elements.recordBtn.classList.remove('recording');
        elements.recordBtn.classList.remove('disabled-recording');
        if (!state.ui.thinking) {
            elements.recordBtn.classList.remove('thinking');
            elements.recordBtn.disabled = false; // Explicitly enable when not thinking
            
            // Remove recording class from parent wrapper
            const recordingWrapper = document.querySelector('.recording-visual-feedback');
            if (recordingWrapper) {
                recordingWrapper.classList.remove('recording');
            }
            
            // Restore original button HTML structure
            const recordBtnInner = elements.recordBtn.querySelector('.record-btn-inner');
            if (recordBtnInner) {
                recordBtnInner.innerHTML = `
                    <!-- Microphone Icon -->
                    <svg class="mic-icon" width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path>
                    </svg>
                    <!-- Stop Icon (hidden initially) -->
                    <svg class="stop-icon hidden" width="24" height="24" fill="currentColor" viewBox="0 0 24 24">
                        <rect x="6" y="6" width="12" height="12" rx="2"></rect>
                    </svg>
                    <!-- Thinking Ellipses (hidden initially) -->
                    <div class="thinking-ellipses hidden">
                        <span class="ellipse-dot"></span>
                        <span class="ellipse-dot"></span>
                        <span class="ellipse-dot"></span>
                    </div>
                `;
            }
        } else {
            elements.recordBtn.disabled = true; // Keep disabled when thinking
        }
        elements.recordBtn.title = state.ui.thinking ? 'Interviewer is thinking...' : 'Start Recording (or press Enter)';
    }

    if (elements.pauseBtn) {
        elements.pauseBtn.classList.add('hidden');
        elements.pauseBtn.disabled = true;
        elements.pauseBtn.classList.remove('paused');
    }
    
    const spaceHint = document.getElementById('spaceHint');
    if (spaceHint) {
        spaceHint.classList.add('hidden');
    }
    
    if (!state.ui.thinking) {
        clearStatus();
        enableInput();
    } else {
        clearStatus();
    }
}

// Send audio to server
export async function sendAudioToServer() {
    if (!state.audio.recordedBlob) {
        console.error('No audio blob to send');
        showError('No recording to send. Please try again.');
        return;
    }
    
    if (!state.socket.connected) {
        console.log('Socket disconnected. Storing audio data to send when reconnected.');
        state.audio.pendingData = state.audio.recordedBlob;
        showError('Connection lost. Your recording will be sent when connection is restored.');
        return;
    }
    
    try {
        console.log('Sending audio to server, blob size:', state.audio.recordedBlob.size, 'bytes, type:', state.audio.recordedBlob.type);
        
        if (elements.recordingStatus) {
            const statusText = elements.recordingStatus.querySelector('.status-text');
            if (statusText) {
                statusText.textContent = `Answer: ${formatTime(state.recording.currentAnswerDuration)} • Processing...`;
            }
            elements.recordingStatus.classList.remove('recording');
        }
        
        if (elements.recordBtn) {
            elements.recordBtn.disabled = true;
        }
        
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                     (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        
        if (isIOS && state.recording.duration > 45) {
            console.log('Long iOS recording detected (' + state.recording.duration + 's). Adding processing message.');
            showInfo('Processing iOS recording...this may take longer for longer recordings.');
        }
        
        const audioArrayBuffer = await state.audio.recordedBlob.arrayBuffer();
        
        // Check if we have video to send
        if (isVideoAvailable()) {
            console.log('Video available, sending both audio and video');
            const videoBlob = getVideoBlob();
            const videoArrayBuffer = await videoBlob.arrayBuffer();
            
            // Send both audio and video
            state.socket.instance.emit('voiceResponseWithVideo', {
                audio: audioArrayBuffer,
                video: videoArrayBuffer,
                videoType: videoBlob.type
            });
        } else {
            // Send audio only (backward compatible)
            state.socket.instance.emit('voiceResponse', audioArrayBuffer);
        }
        
        console.log('Audio/video data sent successfully');
    } catch (error) {
        console.error('Error sending audio:', error);
        
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                     (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
                     
        if (isIOS) {
            showError('iOS recording error: ' + error.message + 
                     '. Try shorter recordings (under 30 seconds) for better compatibility.');
        } else {
            showError('Failed to send recording: ' + error.message);
        }
        
        if (!state.socket.connected) {
            state.audio.pendingData = state.audio.recordedBlob;
        }
        
        resetRecordingState();
    }
}

// Send pending audio data after reconnection
export async function sendPendingAudioData() {
    if (!state.audio.pendingData || !state.socket.connected) return;
    
    try {
        console.log('Sending pending audio data...');
        const arrayBuffer = await state.audio.pendingData.arrayBuffer();
        state.socket.instance.emit('voiceResponse', arrayBuffer);
        state.audio.pendingData = null;
        console.log('Pending audio data sent successfully');
    } catch (error) {
        console.error('Error sending pending audio data:', error);
        showError('Failed to send your previous recording. Please try recording again.');
    }
}

// Create interim transcript display (Deepgram)
function createInterimTranscriptDisplay() {
    if (state.deepgram.interimTranscriptDisplay && state.deepgram.interimTranscriptDisplay.parentNode) {
        state.deepgram.interimTranscriptDisplay.parentNode.removeChild(state.deepgram.interimTranscriptDisplay);
    }
    state.deepgram.interimTranscriptDisplay = null;
}

// Hide interim transcript display
function hideInterimTranscriptDisplay() {
    if (state.deepgram.interimTranscriptDisplay) {
        state.deepgram.interimTranscriptDisplay.classList.add('hidden');
        state.deepgram.interimTranscriptDisplay.textContent = '';
    }
}

// Reset Deepgram UI
function resetDeepgramUI() {
    state.deepgram.streamActive = false;
    state.deepgram.accumulatedTranscript = '';
    hideInterimTranscriptDisplay();
} 