// Socket events module - handles all socket.io event listeners
import { state, setCustomInterviewData, resetAudioState, resetVideoState } from '../state.js';
import { elements } from '../dom.js';
import { config, getSessionStorageKey } from '../config.js';
// Use window functions since utils.js is not a module anymore
const showError = window.showError;
const clearError = window.clearError;
const formatTime = window.formatTime;
const showInfo = window.showInfo;
// createConnectionBanner doesn't exist in utils.js, define inline
const createConnectionBanner = (message, type) => {
    console.log(`Connection: ${type} - ${message}`);
};
import { enableInput, disableInput, clearStatus, updateRecordingProgressUI, updateQuestionCounter } from '../ui/controls.js';
import { setupMicrophone, sendPendingAudioData, resetRecordingState } from '../audio/recorder.js';
import { getVideoBlob, isVideoAvailable } from '../audio/video-recorder.js';
import { switchTab } from '../ui/fileUpload.js';
import { streamQuestion, handleThinkingStart, handleThinkingUpdate, handleResponseComplete, handleQuestionGenerationFailure } from '../ui/thinking.js';
import { initializeMediaSource, processAudioQueue } from '../audio/streaming.js';

// Get auth token for HTTP requests
async function getAuthToken() {
    try {
        if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
            return await firebase.auth().currentUser.getIdToken();
        }
    } catch (error) {
        console.error('Error getting auth token:', error);
    }
    return null;
}

// Upload recording via HTTP instead of WebSocket for large files
async function uploadRecordingViaHTTP(interviewId, audioBlob, videoBlob, responseDocId, persistentSessionId) {
    console.log('[HTTP Upload] ========== STARTING UPLOAD ==========');
    console.log('[HTTP Upload] Interview ID:', interviewId);
    console.log('[HTTP Upload] Response Doc ID:', responseDocId);
    console.log('[HTTP Upload] Audio blob:', {
        size: audioBlob.size,
        type: audioBlob.type
    });
    console.log('[HTTP Upload] Video blob:', videoBlob ? {
        size: videoBlob.size,
        type: videoBlob.type
    } : 'No video');
    
    const uploadStartTime = Date.now();
    
    try {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');
        if (videoBlob) {
            formData.append('video', videoBlob, 'video.webm');
        }
        formData.append('responseDocId', responseDocId);
        formData.append('persistentSessionId', persistentSessionId);
        
        // Get auth token if available
        const token = await getAuthToken();
        console.log('[HTTP Upload] Auth token present:', !!token);
        
        console.log('[HTTP Upload] Sending request to:', `/api/interviews/${interviewId}/upload-recording`);
        
        const response = await fetch(`/api/interviews/${interviewId}/upload-recording`, {
            method: 'POST',
            headers: {
                'Authorization': token ? `Bearer ${token}` : ''
            },
            body: formData
        });
        
        console.log('[HTTP Upload] Response status:', response.status, response.statusText);
        console.log('[HTTP Upload] Response headers:', {
            'content-type': response.headers.get('content-type'),
            'content-length': response.headers.get('content-length')
        });
        
        if (!response.ok) {
            const error = await response.json();
            console.error('[HTTP Upload] Server error response:', error);
            throw new Error(error.message || 'Upload failed');
        }
        
        const result = await response.json();
        const uploadDuration = Date.now() - uploadStartTime;
        console.log('[HTTP Upload] Upload successful in', uploadDuration, 'ms');
        console.log('[HTTP Upload] Server response:', result);
        
        // The server will emit success/error events via socket when processing completes
        // Removed upload success message for cleaner UX
        // showInfo('Recording uploaded successfully. Processing in progress...');
        
    } catch (error) {
        const uploadDuration = Date.now() - uploadStartTime;
        console.error('[HTTP Upload] ========== UPLOAD FAILED ==========');
        console.error('[HTTP Upload] Failed after', uploadDuration, 'ms');
        console.error('[HTTP Upload] Error type:', error.name);
        console.error('[HTTP Upload] Error message:', error.message);
        console.error('[HTTP Upload] Error stack:', error.stack);
        
        // Check if it's a network error
        if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
            console.error('[HTTP Upload] Network error - possible connection issue or CORS problem');
        }
        
        showError(`Failed to upload recording: ${error.message}`);
        
        // Emit error event to maintain compatibility with existing error handling
        if (window.socket) {
            window.socket.emit('audioVideoStorageError', {
                responseDocId: responseDocId,
                message: error.message
            });
        }
    }
}

// Initialize socket connection
export function initializeSocket() {
    console.log('[Socket Init] Environment info:', {
        isInIframe: window.self !== window.top,
        currentOrigin: window.location.origin,
        hostname: window.location.hostname,
        protocol: window.location.protocol
    });
    console.log('[Socket Init] Creating socket connection to:', config.socket.url);
    console.log('[Socket Init] Socket options:', config.socket.options);
    
    const socket = io(config.socket.url, config.socket.options);
    state.socket.instance = socket;
    
    console.log('[Socket Init] Socket instance created:', socket.id);
    
    // Add more detailed error handling
    socket.on('connect_error', (error) => {
        console.error('[Socket Init] Connection error details:', {
            message: error.message,
            type: error.type,
            context: error.context,
            socketUrl: config.socket.url
        });
    });
    
    // Bind all socket event listeners
    setupConnectionEvents(socket);
    setupSessionEvents(socket);
    setupInterviewEvents(socket);
    setupThinkingEvents(socket);
    setupAudioEvents(socket);
    setupDeepgramEvents(socket);
    
    return socket;
}

// Connection-related events
function setupConnectionEvents(socket) {
    socket.on('connect', () => {
        console.log('Socket connected! Socket ID:', socket.id);
        state.socket.connected = true;
        state.socket.retryCount = 0;
        state.session.hasAttemptedRestore = false;
        
        localStorage.setItem(getSessionStorageKey(state.interview.id), socket.id);
        
        // Start heartbeat to keep connection alive
        if (state.socket.heartbeatInterval) {
            clearInterval(state.socket.heartbeatInterval);
        }
        
        // Enhanced heartbeat with timeout detection
        let lastPongTime = Date.now();
        state.socket.heartbeatInterval = setInterval(() => {
            if (state.socket.connected && state.interview.inProgress) {
                // Check if we haven't received a pong in too long
                const timeSinceLastPong = Date.now() - lastPongTime;
                if (timeSinceLastPong > 180000) { // 180 seconds (3 minutes) without pong
                    console.error('[Socket Heartbeat] No pong received for 3 minutes, forcing reconnect');
                    socket.disconnect();
                    socket.connect();
                    return;
                }
                
                socket.emit('heartbeat');
                console.log('[Socket Heartbeat] Sent heartbeat ping');
            }
        }, 15000); // Send heartbeat every 15 seconds (more frequent)
        
        // Listen for pong responses
        socket.on('heartbeat', () => {
            lastPongTime = Date.now();
            console.log('[Socket Heartbeat] Received pong');
        });
        
        // Check for interview backup from deployment
        const backupData = localStorage.getItem('interviewBackup');
        if (backupData && !state.interview.inProgress) {
            try {
                const backup = JSON.parse(backupData);
                // Only restore if backup is less than 5 minutes old
                if (Date.now() - backup.timestamp < 5 * 60 * 1000) {
                    console.log('🔄 Restoring interview from deployment backup');
                    state.interview.id = backup.id;
                    state.interview.inProgress = true;
                    state.responses = backup.responses || [];
                    state.ui.questionCount = backup.questionCount || 0;
                    state.ui.currentQuestion = backup.currentQuestion || '';
                    state.ui.recordingTime = backup.recordingTime || 0;
                    
                    // Request session restoration with backup data
                    socket.emit('restoreFromBackup', backup);
                    localStorage.removeItem('interviewBackup');
                }
            } catch (e) {
                console.error('Failed to restore backup:', e);
            }
        }
        
        if (state.session.attemptingRejoin && state.session.previousId && !state.session.hasAttemptedRestore) {
            console.log('Attempting to restore previous session:', state.session.previousId);
            socket.emit('restoreSessionRequest', state.session.previousId);
            state.session.attemptingRejoin = false;
            state.session.hasAttemptedRestore = true;
        } else if (state.interview.inProgress) {
            console.log('Reconnected during active interview. Requesting current state.');
            createConnectionBanner('reconnected');
            socket.emit('requestCurrentState');
        } else {
            const existingBanner = document.getElementById('connectionBanner');
            if (existingBanner) existingBanner.remove();
        }
        
        if (elements.interviewInterface && !elements.interviewInterface.classList.contains('hidden') && !state.ui.thinking) {
            enableInput();
        }
        
        if (state.audio.pendingData && state.interview.inProgress) {
            console.log('Reconnected with pending audio data. Attempting to resend...');
            sendPendingAudioData();
        }
    });
    
    socket.on('disconnect', (reason) => {
        console.error('[SOCKET DISCONNECT] Socket disconnected! Reason:', reason);
        console.error('[SOCKET DISCONNECT] Current state:', {
            inProgress: state.interview.inProgress,
            questionCount: state.ui.questionCount,
            thinking: state.ui.thinking,
            socketId: socket.id
        });
        state.socket.connected = false;
        
        // Clear heartbeat interval
        if (state.socket.heartbeatInterval) {
            clearInterval(state.socket.heartbeatInterval);
            state.socket.heartbeatInterval = null;
        }
        
        createConnectionBanner('disconnected');
        disableInput();
        
        // Only show error if interview is in progress
        if (state.interview.inProgress) {
            console.error('[SOCKET DISCONNECT] Disconnected during active interview!');
        }
    });
    
    socket.on('reconnecting', (attemptNumber) => {
        console.log('Attempting to reconnect:', attemptNumber);
        createConnectionBanner('reconnecting');
    });
    
    socket.on('reconnect_failed', () => {
        console.log('Failed to reconnect after multiple attempts');
        showError('Unable to reconnect to the server. Please refresh the page.');
        if (state.deepgram.streamActive) {
            resetDeepgramUI();
        }
    });
    
    socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
        state.socket.retryCount++;
        state.session.hasAttemptedRestore = true;
        
        if (state.deepgram.streamActive) {
            resetDeepgramUI();
        }
        
        if (state.socket.retryCount > config.socket.maxRetries) {
            showError('Unable to connect to server: ' + error.message + '. Please refresh the page.');
        } else {
            showError('Connection error: ' + error.message + '. Retrying...');
        }
        disableInput();
    });
}

// Session-related events
function setupSessionEvents(socket) {
    socket.on('currentState', (data) => {
        console.log('Received current state from server:', data);
        if (state.interview.inProgress && data) {
            if (typeof data.recordingTime === 'number') {
                // Debug logging for 7-minute jump issue
                console.log('[DEBUG] Current state recording time update:', {
                    receivedRecordingTime: data.recordingTime,
                    currentAccumulatedTime: state.recording.accumulatedTime,
                    willSetTo: data.recordingTime
                });
                
                state.recording.accumulatedTime = data.recordingTime;
                updateRecordingProgressUI();
            }
            if (data.lastQuestion && elements.currentQuestionDisplay) {
                elements.currentQuestionDisplay.textContent = data.lastQuestion;
            }
            enableInput();
            clearStatus();
            clearError();
        }
    });
    
    socket.on('restoreSessionData', (data) => {
        console.log('Received restoreSessionData:', data);
        localStorage.removeItem(getSessionStorageKey(state.interview.id));
        
        const restoreMsg = document.getElementById('restoreMessage');
        if (restoreMsg) restoreMsg.classList.add('hidden');
        
        if (data) {
            state.interview.inProgress = true;
            state.session.hasAttemptedRestore = true;
            
            // Handle deployment restoration
            if (data.restorationSource) {
                console.log(`✅ Interview restored from ${data.restorationSource} backup`);
                // Update question count if provided
                if (data.questionCount) {
                    state.ui.questionCount = data.questionCount;
                    updateQuestionCounter();
                }
            }
            
            state.form.resumeText = data.resume || '';
            if (elements.resumeTextArea) elements.resumeTextArea.value = state.form.resumeText;
            
            // Debug logging for 7-minute jump issue
            console.log('[DEBUG] Restoring session with recording time:', {
                receivedRecordingTime: data.recordingTime,
                currentAccumulatedTime: state.recording.accumulatedTime,
                willSetTo: data.recordingTime || 0
            });
            
            state.recording.accumulatedTime = data.recordingTime || 0;
            
            if (elements.fileUploadArea) elements.fileUploadArea.classList.add('hidden');
            if (elements.introText) elements.introText.classList.add('hidden');
            if (elements.interviewInterface) elements.interviewInterface.classList.remove('hidden');
            
            const timeCounter = document.querySelector('.time-counter');
            if (timeCounter) timeCounter.classList.add('active');
            
            updateRecordingProgressUI();
            
            if (elements.currentQuestionDisplay && data.lastQuestion) {
                elements.currentQuestionDisplay.textContent = data.lastQuestion;
            } else if (elements.currentQuestionDisplay) {
                elements.currentQuestionDisplay.textContent = 'Restoring session...';
            }
            
            setupMicrophone();
            resetRecordingState();
            clearStatus();
            clearError();
            enableInput();
            
            console.log('Session restored successfully.');
            createConnectionBanner('restored');
        } else {
            console.log('Restore data received but was empty/invalid.');
            socket.emit('restoreFailed');
        }
    });
    
    socket.on('restoreFailed', () => {
        console.log('Session restore failed. Starting fresh.');
        state.session.hasAttemptedRestore = true;
        localStorage.removeItem(getSessionStorageKey(state.interview.id));
        
        const restoreMsg = document.getElementById('restoreMessage');
        if (restoreMsg) restoreMsg.classList.add('hidden');
        if (elements.interviewInterface) elements.interviewInterface.classList.add('hidden');
        if (elements.fileUploadArea) elements.fileUploadArea.classList.remove('hidden');
        if (elements.introText) elements.introText.classList.remove('hidden');
        switchTab('upload');
        showError("Could not restore previous session. Please start again.");
    });
    
    socket.on('storeSessionId', (sessionId) => {
        console.log('Storing session ID in localStorage:', sessionId);
        localStorage.setItem(config.storage.archiveSessionIdKey, sessionId);
    });
    
    socket.on('reportGenerationError', (error) => {
        console.error('Report generation error:', error);
        
        // Hide email notification and show error
        const emailMessage = document.getElementById('emailNotificationMessage');
        if (emailMessage) {
            emailMessage.classList.add('hidden');
        }
        
        // Show interview interface again
        const interviewInterface = document.getElementById('interviewInterface');
        if (interviewInterface) {
            interviewInterface.classList.remove('hidden');
        }
        
        showError(error.message || 'Failed to generate report. Please try again.');
        
        // Re-enable the generate report button
        if (elements.generateReportBtn) {
            elements.generateReportBtn.disabled = false;
        }
    });
}

// Interview flow events
function setupInterviewEvents(socket) {
    socket.on('redirectToReport', (data) => {
        // Story mode: navigate directly to the story review page
        if (data && data.storyMode && data.redirectUrl) {
            console.log('[redirectToReport] Story mode complete, navigating to:', data.redirectUrl);
            window.location.href = data.redirectUrl;
            return;
        }

        console.log('[redirectToReport] Report generation complete - no redirect, email will be sent');
        console.log('[redirectToReport] Current state:', {
            inProgress: state.interview.inProgress,
            accumulatedTime: state.recording.accumulatedTime,
            questionCount: state.ui.questionCount,
            thinking: state.ui.thinking
        });
        
        if (state.interview.startTime) {
            const totalInterviewDuration = Date.now() - state.interview.startTime;
            console.log(`⏱️ CLIENT TIMING - Total interview duration: ${totalInterviewDuration}ms (${(totalInterviewDuration / 1000).toFixed(1)}s)`);
        }
        
        console.log('[redirectToReport] Received data:', data);
        
        // Don't redirect - the email notification is already showing
        // The report will be sent via email instead
        const reportId = data?.reportId || '';
        const interviewId = data?.interviewId || '';
        
        if (reportId || interviewId) {
            console.log('[redirectToReport] Report ID:', reportId || interviewId);
            console.log('[redirectToReport] User will receive report via email');
            
            // Send completion message to parent window if in iframe
            if (window.self !== window.top) {
                console.log('[redirectToReport] Sending completion message to parent window');
                window.parent.postMessage({
                    type: 'interviewCompleted',
                    interviewId: interviewId || state.interview.id,
                    responseId: reportId
                }, window.location.origin);
            }
        }
    });
    
    socket.on('error', (error) => {
        console.error('Socket error received:', error);
        
        // Check if this is a question generation failure
        if (error && error.includes && error.includes('Failed to generate a valid question')) {
            // Use the thinking module's failure handler
            handleQuestionGenerationFailure();
        } else if (error && error.includes && error.includes('Too many audio chunks')) {
            // Handle audio chunk rate limit error
            console.error('Audio chunk rate limit exceeded - likely Safari browser issue');
            showError('Audio processing overloaded. This is a known Safari issue. Stopping recording...');
            
            // Stop recording gracefully
            if (state.recording.isRecording) {
                // Import the stopRecording function
                import('../audio/recorder.js').then(module => {
                    module.stopRecording().then(() => {
                        console.log('Recording stopped due to rate limit');
                        showInfo('Recording stopped. You can save your interview or continue with a new recording.');
                    }).catch(err => {
                        console.error('Error stopping recording:', err);
                        resetRecordingState();
                    });
                }).catch(err => {
                    console.error('Error importing recorder module:', err);
                    resetRecordingState();
                });
            }
        } else {
            // Handle other errors normally
            showError(error);
            resetRecordingState();
            enableInput();
        }
    });
    
    socket.on('usageLimitReached', (data) => {
        console.log('Usage limit reached:', data);
        disableInput();
        
        const message = data.message || 'You have reached your interview limit for this billing period.';
        showError(`${message} <a href="/pricing.html" class="text-blue-400 hover:text-blue-300 underline ml-2">Upgrade your plan</a>`);
        
        if (state.recording.isRecording) {
            resetRecordingState();
        }
        
        if (elements.recordBtn) {
            elements.recordBtn.disabled = true;
            elements.recordBtn.classList.add('disabled');
            elements.recordBtn.title = 'Recording limit reached';
        }
    });
    
    socket.on('updateProgress', (data) => {
        console.log('Progress update received:', data);
        if (data && typeof data.recordingTime === 'number') {
            // Debug logging for 7-minute jump issue
            console.log('[DEBUG] Progress update recording time:', {
                receivedRecordingTime: data.recordingTime,
                currentAccumulatedTime: state.recording.accumulatedTime,
                willSetTo: data.recordingTime
            });
            
            state.recording.accumulatedTime = data.recordingTime;
            updateRecordingProgressUI();
        }
    });
    
    socket.on('example_report_ready', () => {
        console.log('[example_report_ready] Example report ready - no redirect, showing email message');
        // Show email notification for example report too
        const emailMessage = document.getElementById('emailNotificationMessage');
        const emailDisplay = document.getElementById('userEmailDisplay');
        
        if (emailMessage && emailDisplay) {
            emailDisplay.textContent = 'your email';
            emailMessage.classList.remove('hidden');
        }
    });
    
    socket.on('initiateExampleReportRedirect', (exampleSessionId) => {
        console.log('Received example session ID:', exampleSessionId);
        if (exampleSessionId) {
            localStorage.setItem(config.storage.archiveSessionIdKey, exampleSessionId);
            console.log('Stored example session ID - no redirect, showing email message');
            // Show email notification instead of redirecting
            const emailMessage = document.getElementById('emailNotificationMessage');
            const emailDisplay = document.getElementById('userEmailDisplay');
            
            if (emailMessage && emailDisplay) {
                emailDisplay.textContent = 'your email';
                emailMessage.classList.remove('hidden');
            }
        } else {
            console.error('Received invalid session ID for example report.');
            showError('Failed to prepare example report. Please try again.');
            const generateExampleBtn = document.getElementById('generateExampleBtn');
            if (generateExampleBtn) {
                generateExampleBtn.textContent = 'Or see an example report';
                generateExampleBtn.disabled = false;
            }
        }
    });
}

// Thinking/AI response events
function setupThinkingEvents(socket) {
    socket.on('thinkingStarted', async () => {
        await handleThinkingStart();
    });
    
    socket.on('thinkingUpdate', (thinkingChunk) => {
        handleThinkingUpdate(thinkingChunk);
    });
    
    socket.on('responseComplete', (completeResponse) => {
        handleResponseComplete(completeResponse);
    });
    
    socket.on('thinkingComplete', () => {
        console.log('Thinking complete signal received');
    });
    
    // Report generation thinking events
    socket.on('reportThinkingStarted', () => {
        console.log('[reportThinkingStarted] Starting report generation - showing email notification');
        
        // Check if this is the Interview Designer interview
        const INTERVIEW_DESIGNER_ID = '5dbb409d-fade-4ece-ae9d-0bfb8ff34097';
        if (state.interview.id === INTERVIEW_DESIGNER_ID) {
            console.log('[reportThinkingStarted] Interview Designer detected - will redirect to builder');
            // Store a flag to handle redirect when report is complete
            state.isInterviewDesigner = true;
            return; // Don't show email notification
        }
        
        // Show email notification message instead of visualization
        const emailMessage = document.getElementById('emailNotificationMessage');
        const emailDisplay = document.getElementById('userEmailDisplay');
        
        if (emailMessage && emailDisplay) {
            // Get the user's email from the input field
            const userEmailInput = document.getElementById('userEmail');
            if (userEmailInput) {
                emailDisplay.textContent = userEmailInput.value;
            }
            
            // Show the email notification
            emailMessage.classList.remove('hidden');
            
            // Hide other UI elements
            const interviewInterface = document.getElementById('interviewInterface');
            if (interviewInterface) {
                interviewInterface.classList.add('hidden');
            }
        }
    });
    
    socket.on('reportThinkingUpdate', (thinkingChunk) => {
        console.log('[reportThinkingUpdate] Thinking update:', thinkingChunk);
        // No longer updating visualization since we're showing email message
    });
    
    socket.on('reportThinkingComplete', (data) => {
        console.log('[reportThinkingComplete] Report thinking complete', data);
        
        // Check if this is the Interview Designer interview
        if (state.isInterviewDesigner) {
            console.log('[reportThinkingComplete] Interview Designer - sending completion message to parent');
            
            // Get the report/response ID from the data if available
            const responseId = data?.reportId || data?.responseId || data?.id;
            
            // Send message to parent window (admin page)
            if (window.parent && window.parent !== window) {
                console.log('[reportThinkingComplete] Sending postMessage to parent with responseId:', responseId);
                window.parent.postMessage({
                    type: 'interviewCompleted',
                    interviewId: state.interview.id,
                    responseId: responseId
                }, window.location.origin);
            } else {
                console.warn('[reportThinkingComplete] No parent window found - cannot send completion message');
            }
            
            return;
        }
        
        // Regular flow - email will be sent
    });
    
    socket.on('responseStarted', () => {
        console.log('Response streaming started');
        state.ui.currentStreamedResponse = '';
        state.ui.isStreamingResponse = true;
        
        // Set cursor in the appropriate display based on video mode
        const isVideoEnabled = document.body.classList.contains('video-enabled');
        const targetDisplay = isVideoEnabled ? elements.currentQuestionDisplayVideo : elements.currentQuestionDisplay;
        
        if (targetDisplay) {
            targetDisplay.innerHTML = '<span class="streaming-cursor"></span>';
        }
    });
    
    // Deployment warning event
    socket.on('deploymentWarning', (data) => {
        console.log('⚠️ Deployment warning received:', data);
        
        // Save current interview state to localStorage
        if (state.interview.inProgress) {
            const interviewBackup = {
                id: state.interview.id,
                responses: state.responses,
                questionCount: state.ui.questionCount,
                currentQuestion: state.ui.currentQuestion,
                recordingTime: state.ui.recordingTime,
                timestamp: Date.now()
            };
            localStorage.setItem('interviewBackup', JSON.stringify(interviewBackup));
            console.log('💾 Interview state saved locally');
        }
        
        // Show user-friendly notification
        const notification = document.createElement('div');
        notification.className = 'deployment-notification';
        notification.innerHTML = `
            <div style="position: fixed; top: 20px; left: 50%; transform: translateX(-50%); 
                        background: #f59e0b; color: white; padding: 16px 24px; 
                        border-radius: 8px; z-index: 10000; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                    </svg>
                    <div>
                        <strong>System Update</strong><br>
                        <span style="font-size: 14px;">Your interview will resume automatically in a moment...</span>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(notification);
        
        // Remove notification after 10 seconds
        setTimeout(() => notification.remove(), 10000);
    });
    
    socket.on('responseChunk', (chunk) => {
        if (!state.ui.isStreamingResponse) return;
        streamQuestion(chunk);
    });
}

// Audio streaming events
function setupAudioEvents(socket) {
    socket.on('questionAudioChunk', (chunk) => {
        const streamIdForChunk = state.mse.currentStreamId;
        console.log(`[MSE] Received questionAudioChunk. Current Stream ID: ${streamIdForChunk}, Chunk size: ${chunk ? chunk.byteLength : 'N/A'}`);
        if (chunk) {
            state.mse.queue.push({ id: streamIdForChunk, data: chunk });
            processAudioQueue();
        }
    });
    
    socket.on('questionAudioEnd', () => {
        const streamIdForEnd = state.mse.currentStreamId;
        console.log(`[MSE] Received questionAudioEnd. Current Stream ID: ${streamIdForEnd}`);
        state.mse.queue.push({ id: streamIdForEnd, end: true });
        processAudioQueue();
    });
    
    socket.on('ttsError', (error) => {
        console.error("[TTS Error from Server]:", error.message);
        showError(`Audio generation failed: ${error.message}`);
        
        if (state.mse.mediaSource && state.mse.mediaSource.readyState === 'open') {
            try {
                if (state.mse.sourceBuffer && !state.mse.sourceBuffer.updating) {
                    state.mse.mediaSource.endOfStream();
                }
            } catch (e) {
                console.error("[MSE] Error ending stream on TTS error:", e);
            }
        }
        state.mse.queue = [];
        state.mse.isSourceBufferReady = false;
    });
}

  // Deepgram events
  function setupDeepgramEvents(socket) {
      socket.on('deepgramStreamInitializing', () => {
          console.log('[Deepgram] Server acknowledged stream initialization request');
          state.deepgram.initializationAcknowledged = true;
      });
      
      socket.on('deepgramStreamOpened', () => {
          console.log('[Deepgram] Stream opened on server. Ready to send audio.');
          state.deepgram.streamActive = true;
          state.deepgram.connectionAttempts = 0; // Reset retry counter on successful connection

          // If we're recording, restore normal status display
          if (state.recording.isRecording && elements.recordingStatus) {
              const statusText = elements.recordingStatus.querySelector('.status-text');
              if (statusText) {
                  // Clear any warning/error status
                  const currentText = statusText.textContent;
                  if (currentText.includes('⚠️') || currentText.includes('🔄')) {
                      statusText.innerHTML = `Recording: ${formatTime(state.recording.duration)}`;
                      clearError(); // Clear the transcription lost error
                      showInfo('Transcription reconnected successfully!');
                  }
              }
          }

          // Check if we have buffered audio to send
          if (state.audio.isBuffering && state.audio.audioBuffer && state.audio.audioBuffer.length > 0) {
              console.log(`[Deepgram] Reconnected! Sending ${state.audio.audioBuffer.length} buffered audio chunks`);
              setTimeout(() => {
                  // Small delay to ensure stream is fully ready
                  for (const bufferedChunk of state.audio.audioBuffer) {
                      socket.emit('audioChunkToServer', bufferedChunk);
                  }
                  state.audio.audioBuffer = [];
                  state.audio.isBuffering = false;
              }, 100);
          }
      });

      socket.on('deepgramError', (error) => {
          console.error('[Deepgram] Error from server:', error.message);
          showError(`Transcription error: ${error.message}`);
          resetDeepgramUI();
          resetRecordingState();
      });

      socket.on('deepgramStreamClosed', () => {
          console.log('[Deepgram] Stream closed on server unexpectedly.');
          if (state.deepgram.streamActive && state.recording.isRecording) {
              showError('Transcription lost. Continue speaking - attempting to reconnect...');

              // Mark that we're in a degraded state
              state.deepgram.streamActive = false;

              // Update UI to show recording continues
              if (elements.recordingStatus) {
                  const statusText = elements.recordingStatus.querySelector('.status-text');
                  if (statusText) {
                      statusText.innerHTML = '<span style="color: #ff6b6b;">⚠️ Recording (reconnecting...)</span>';
                  }
              }

              // Attempt to reconnect after a short delay
              setTimeout(() => {
                  if (state.recording.isRecording && !state.deepgram.streamActive) {
                      console.log('[Deepgram] Attempting to reconnect transcription...');
                      socket.emit('startDeepgramStream');

                      // Update status to show reconnection attempt
                      if (elements.recordingStatus) {
                          const statusText = elements.recordingStatus.querySelector('.status-text');
                          if (statusText) {
                              statusText.innerHTML = '<span style="color: #ffa500;">🔄 Recording (reconnecting...)</span>';
                          }
                      }
                  }
              }, 2000); // Wait 2 seconds before reconnecting
          } else {
              resetDeepgramUI();
          }
          // Don't stop recording - let user decide
      });
    
    socket.on('audioStorageError', ({ responseDocId, message }) => {
        console.error(`[AudioSave] Storage error for response ${responseDocId}: ${message}`);
        // Don't show error to user as this is a background process
        // The interview can continue even if audio storage fails
        
        // Clear only the blob, not chunks (chunks are managed by recorder when starting new recording)
        state.audio.recordedBlob = null;
        // DON'T clear chunks here - they might belong to a new recording
        resetVideoState();
    });
    
    socket.on('audioStorageSuccess', ({ responseDocId, audioUrl }) => {
        console.log(`[AudioSave] Storage successful for response ${responseDocId}`);
        console.log(`[AudioSave] Audio URL: ${audioUrl}`);
        
        // Clear only the blob, not chunks (chunks are managed by recorder when starting new recording)
        state.audio.recordedBlob = null;
        // DON'T clear chunks here - they might belong to a new recording
        resetVideoState();
    });
    
    socket.on('audioVideoStorageQueued', ({ responseDocId, message }) => {
        console.log(`[AudioVideoSave] Media queued for processing: ${responseDocId} - ${message}`);
        
        // Immediately clear the blobs to free memory and allow next recording
        // The media is now queued on the server, so we don't need the blobs anymore
        state.audio.recordedBlob = null;
        resetVideoState();
    });
    
    socket.on('audioVideoStorageError', ({ responseDocId, message }) => {
        console.error(`[AudioVideoSave] Storage error for response ${responseDocId}: ${message}`);
        // Don't show error to user as this is a background process
        // The interview can continue even if storage fails
        
        // Clear only the blob, not chunks (chunks are managed by recorder when starting new recording)
        state.audio.recordedBlob = null;
        // DON'T clear chunks here - they might belong to a new recording
        resetVideoState();
    });
    
    socket.on('audioVideoStorageSuccess', ({ responseDocId, audioUrl, videoUrl }) => {
        console.log(`[AudioVideoSave] Storage successful for response ${responseDocId}`);
        console.log(`[AudioVideoSave] Audio URL: ${audioUrl}`);
        console.log(`[AudioVideoSave] Video URL: ${videoUrl}`);
        
        // Clear only the blob, not chunks (chunks are managed by recorder when starting new recording)
        state.audio.recordedBlob = null;
        // DON'T clear chunks here - they might belong to a new recording
        resetVideoState();
    });
    
    socket.on('interimTranscript', (transcript) => {
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        if (isSafari) {
            console.log(`[Safari Debug] Interim transcript received: "${transcript}", length: ${transcript ? transcript.length : 0}`);
        } else {
            console.log(`[Client Deepgram] Interim transcript received: "${transcript}"`);
        }
        if (state.deepgram.interimTranscriptDisplay && state.deepgram.streamActive) {
            state.deepgram.interimTranscriptDisplay.textContent = transcript;
        }
        // Accumulate transcript to check if user spoke
        if (transcript && transcript.trim()) {
            state.deepgram.accumulatedTranscript += transcript + ' ';
            
            // Count words in the accumulated transcript
            const words = state.deepgram.accumulatedTranscript.trim().split(/\s+/).filter(word => word.length > 0);
            state.deepgram.transcribedWordCount = words.length;
            console.log(`[Deepgram] Word count: ${state.deepgram.transcribedWordCount}`);
            
            // Enable record button (as stop button) if we have 3+ words
            if (state.deepgram.transcribedWordCount >= 3 && state.recording.isRecording && elements.recordBtn) {
                if (elements.recordBtn.disabled) {
                    console.log('[Deepgram] Enabling stop button - 3+ words transcribed');
                    elements.recordBtn.disabled = false;
                    elements.recordBtn.classList.remove('disabled-recording');
                    elements.recordBtn.title = 'Submit Recording';
                }
            }
        }
    });
    
    socket.on('finalSegment', (data) => {
        console.log(`[Client Deepgram] Final segment received: "${data.transcript}", Words: ${JSON.stringify(data.words)}`);
        if (state.deepgram.interimTranscriptDisplay && state.deepgram.streamActive) {
            state.deepgram.interimTranscriptDisplay.textContent = data.transcript;
        }
        // Accumulate transcript to check if user spoke
        if (data.transcript && data.transcript.trim()) {
            state.deepgram.accumulatedTranscript += data.transcript + ' ';
            
            // Count words in the accumulated transcript
            const words = state.deepgram.accumulatedTranscript.trim().split(/\s+/).filter(word => word.length > 0);
            state.deepgram.transcribedWordCount = words.length;
            console.log(`[Deepgram] Word count: ${state.deepgram.transcribedWordCount}`);
            
            // Enable record button (as stop button) if we have 3+ words
            if (state.deepgram.transcribedWordCount >= 3 && state.recording.isRecording && elements.recordBtn) {
                if (elements.recordBtn.disabled) {
                    console.log('[Deepgram] Enabling stop button - 3+ words transcribed');
                    elements.recordBtn.disabled = false;
                    elements.recordBtn.classList.remove('disabled-recording');
                    elements.recordBtn.title = 'Submit Recording';
                }
            }
        }
    });
    
    socket.on('finalTranscriptionResult', (data) => {
        if (state.recording.startTime) {
            const totalRecordingToTranscriptionDuration = Date.now() - state.recording.startTime;
            console.log(`⏱️ CLIENT TIMING - Recording to transcription completed in ${totalRecordingToTranscriptionDuration}ms`);
        }
        console.log('[Deepgram] Final Transcription Result from Server:', data.transcript);
    });
    
    socket.on('transcriptionLogged', async ({ responseDocId, persistentSessionId }) => {
        console.log(`[AudioSave] Received transcriptionLogged for responseDocId: ${responseDocId}, reportId: ${persistentSessionId}`);
        state.deepgram.streamActive = false;
        resetDeepgramUI();
        
        // Create a copy of the blob reference to ensure it's not cleared during upload
        const audioBlobToUpload = state.audio.recordedBlob;
        
        if (audioBlobToUpload && responseDocId) {
            console.log(`[AudioSave] Sending finalAudioBlobForStorage. Blob size: ${audioBlobToUpload.size}, type: ${audioBlobToUpload.type}. ResponseDocId: ${responseDocId}`);
            try {
                const audioArrayBuffer = await audioBlobToUpload.arrayBuffer();
                
                // Check if we have video to send
                if (isVideoAvailable()) {
                    console.log('[VideoSave] Video available, uploading both audio and video via HTTP');
                    const videoBlob = getVideoBlob();
                    
                    // Use HTTP upload for large files
                    await uploadRecordingViaHTTP(
                        state.interview.id,
                        audioBlobToUpload,
                        videoBlob,
                        responseDocId,
                        persistentSessionId
                    );
                } else {
                    // For audio-only, still use WebSocket (it's small enough)
                    socket.emit('finalAudioBlobForStorage', { 
                        audioData: audioArrayBuffer, 
                        responseDocId: responseDocId,
                        persistentSessionId: persistentSessionId,
                        mimeType: audioBlobToUpload.type
                    });
                    console.log('[AudioSave] finalAudioBlobForStorage emitted.');
                    
                    // Don't clear state here - wait for success/error events
                }
            } catch (error) {
                console.error('[AudioSave] Error converting blob to ArrayBuffer:', error);
                showError('Error preparing audio for storage.');
                // Don't clear the blob on error - it might be needed for retry
            }
        } else {
            if (!audioBlobToUpload) console.warn('[AudioSave] No recordedAudioBlob to send for storage.');
            if (!responseDocId) console.warn('[AudioSave] No responseDocId received, cannot send audio for storage.');
            
            // Only clear the blob - chunks might belong to a new recording
            state.audio.recordedBlob = null;
            // DON'T clear chunks here - they are managed by the recorder
            resetVideoState();
        }
    });
    
    // Report video generation events
    socket.on('reportVideoGenerationSuccess', ({ reportId, videoUrl, threadId }) => {
        console.log(`[ReportVideo] Video generation successful for ${reportId}`);
        console.log(`[ReportVideo] Video URL: ${videoUrl}`);
        console.log(`[ReportVideo] Thread ID: ${threadId}`);
        
        // Update any processing status in the UI
        const processingStatuses = document.querySelectorAll('.video-processing-status');
        processingStatuses.forEach(status => {
            status.innerHTML = '✅ Video ready! Check Content tab';
            status.className = 'video-ready-status';
        });
        
        // If we're in the analyst view, update the message
        if (threadId && window.appState?.currentAnalystThreadId === threadId) {
            // Find the message with processing status and update it
            const messages = document.querySelectorAll('.analyst-message');
            messages.forEach(msg => {
                const statusElement = msg.querySelector('.video-processing-status');
                if (statusElement) {
                    // Replace processing status with video link
                    const videoLink = document.createElement('a');
                    videoLink.href = videoUrl;
                    videoLink.target = '_blank';
                    videoLink.className = 'video-summary-link';
                    videoLink.innerHTML = '🎬 Watch Video Summary';
                    statusElement.replaceWith(videoLink);
                }
            });
        }
    });
    
    socket.on('reportVideoGenerationError', ({ reportId, error, threadId }) => {
        console.error(`[ReportVideo] Video generation failed for ${reportId}: ${error}`);
        
        // Update any processing status in the UI
        const processingStatuses = document.querySelectorAll('.video-processing-status');
        processingStatuses.forEach(status => {
            status.innerHTML = '❌ Video generation failed';
            status.className = 'video-error-status';
        });
    });
    
    // Handle current state response after reconnection
    socket.on('currentState', (serverState) => {
        console.log('[RECONNECT] Received current state from server:', serverState);
        
        // If server says we're not thinking but client is stuck thinking, clear it
        if (!serverState.thinking && state.ui.thinking) {
            console.log('[RECONNECT] Server not thinking, clearing client thinking state');
            
            // Clear thinking state
            state.ui.thinking = false;
            document.body.classList.remove('thinking-active');
            
            // Hide thinking display
            if (elements.thinkingIndicator) {
                elements.thinkingIndicator.classList.add('hidden');
            }
            if (elements.thinkingTraceDisplay) {
                elements.thinkingTraceDisplay.classList.add('hidden');
            }
            
            // Re-enable record button
            if (elements.recordBtn) {
                elements.recordBtn.disabled = false;
                elements.recordBtn.classList.remove('thinking');
                elements.recordBtn.removeAttribute('title');
            }
            
            // Visualization cleanup removed - using thinking panel instead
            
            enableInput();
        }
        
        // Update question count if different
        if (serverState.questionCount !== undefined && serverState.questionCount !== state.ui.questionCount) {
            console.log(`[RECONNECT] Updating question count from ${state.ui.questionCount} to ${serverState.questionCount}`);
            state.ui.questionCount = serverState.questionCount;
        }
    });
}

// Helper to reset Deepgram UI
function resetDeepgramUI() {
    state.deepgram.streamActive = false;
    if (state.deepgram.interimTranscriptDisplay) {
        state.deepgram.interimTranscriptDisplay.classList.add('hidden');
        state.deepgram.interimTranscriptDisplay.textContent = '';
    }
} 