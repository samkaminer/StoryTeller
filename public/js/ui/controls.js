// UI controls module - handles UI updates and button states
import { state } from '../state.js';
import { elements } from '../dom.js';
import { config } from '../config.js';

// Use window function since utils.js is not a module anymore
const formatTime = window.formatTime;

// Enable input controls
export function enableInput() {
    // Only enable if mediaRecorder is available and AI is not thinking
    if (state.audio.mediaRecorder && !state.ui.thinking && elements.recordBtn) {
        elements.recordBtn.disabled = false;
    }
    if (elements.pauseBtn) {
        elements.pauseBtn.disabled = true;
    }
}

// Disable input controls
export function disableInput() {
    if (elements.recordBtn) elements.recordBtn.disabled = true;
    if (elements.pauseBtn) elements.pauseBtn.disabled = true;
}

// Clear recording status
export function clearStatus() {
    if (elements.recordingStatus) {
        const statusText = elements.recordingStatus.querySelector('.status-text');
        if (statusText) {
            if (state.ui.thinking) {
                statusText.textContent = 'AI is thinking...';
            } else {
                statusText.textContent = 'Click to start recording';
            }
        }
        elements.recordingStatus.classList.remove('recording');
    }
    
    if (state.recording.timer) {
        clearInterval(state.recording.timer);
        state.recording.timer = null;
    }
    
    if (state.recording.progressTimer) {
        clearInterval(state.recording.progressTimer);
        state.recording.progressTimer = null;
    }
}

// Update recording status display
export function updateRecordingStatus() {
    if (!elements.recordingStatus) return;
    
    // Only update if we're actually recording
    if (!state.recording.isRecording || state.ui.thinking) {
        if (state.recording.timer) {
            clearInterval(state.recording.timer);
            state.recording.timer = null;
        }
        return;
    }
    
    const statusText = elements.recordingStatus.querySelector('.status-text');
    if (!statusText) return;
    
    if (state.recording.isPaused) {
        statusText.textContent = `Paused • ${formatTime(state.recording.currentAnswerDuration)}`;
        elements.recordingStatus.classList.remove('recording');
    } else {
        statusText.textContent = `Recording • ${formatTime(state.recording.currentAnswerDuration)}`;
        elements.recordingStatus.classList.add('recording');
    }
    
    // Show space hint when recording
    const spaceHint = document.getElementById('spaceHint');
    if (spaceHint) {
        spaceHint.classList.toggle('hidden', !state.recording.isRecording || state.recording.isPaused);
    }
    
    updateRecordingProgressUI();
}

// Update recording progress UI (time counter and progress ring)
export function updateRecordingProgressUI() {
    let displayTime = state.recording.accumulatedTime;
    
    // Add current recording segment if actively recording
    if (state.recording.isRecording && !state.recording.isPaused) {
        // Use the duration from the timer, not Date.now() calculation
        // This prevents double-counting when the timer and Date.now() calculations differ
        displayTime += state.recording.duration;
    } else if (state.recording.isRecording && state.recording.isPaused) {
        displayTime += state.recording.duration;
    }
    
    displayTime = Math.floor(displayTime);
    
    // Debug logging for 7-minute jump issue
    if (displayTime > 400 && displayTime < 440) {
        console.log('[DEBUG] Potential 7-minute jump detected:', {
            displayTime,
            accumulatedTime: state.recording.accumulatedTime,
            duration: state.recording.duration,
            isRecording: state.recording.isRecording,
            isPaused: state.recording.isPaused,
            targetDurationSeconds: state.recording.targetDurationSeconds,
            timeLimitExtended: state.recording.timeLimitExtended
        });
    }
    
    // Update word count progress bar (using time as proxy for words)
    // Assuming ~150 words per minute of speaking
    const estimatedWords = Math.floor((displayTime / 60) * 150);
    const targetWords = 1000; // Default target
    const wordPercentage = Math.min(100, (estimatedWords / targetWords) * 100);
    
    // Update word count display
    const currentWordCountElem = document.getElementById('currentWordCount');
    const targetWordCountElem = document.getElementById('targetWordCount');
    const wordProgressBar = document.getElementById('wordProgressBar');
    
    if (currentWordCountElem) currentWordCountElem.textContent = estimatedWords;
    if (targetWordCountElem) targetWordCountElem.textContent = targetWords;
    if (wordProgressBar) wordProgressBar.style.width = wordPercentage + '%';

    // Handle time limit extension
    const initialTargetMet = state.recording.accumulatedTime >= config.recording.initialTargetDurationSeconds;
    let alertShown = false;

    if (initialTargetMet && !state.recording.timeLimitExtended) {
        console.log('[DEBUG] Time limit extension triggered:', {
            accumulatedTime: state.recording.accumulatedTime,
            oldTargetDuration: state.recording.targetDurationSeconds,
            newTargetDuration: state.recording.targetDurationSeconds + 300
        });
        
        state.recording.timeLimitExtended = true;
        state.recording.targetDurationSeconds += 300; // Add another 5 minutes
        if (elements.targetRecordingTimeElem) {
            elements.targetRecordingTimeElem.textContent = formatTime(state.recording.targetDurationSeconds);
        }
        console.log("Initial time limit reached. Target extended to:", formatTime(state.recording.targetDurationSeconds));
        showTimeLimitExtendedAlert();
        alertShown = true;
    }

    // Update display
    const displayTimeToCurrentTarget = Math.min(displayTime, state.recording.targetDurationSeconds);
    
    if (elements.currentRecordingTimeElem) {
        elements.currentRecordingTimeElem.textContent = formatTime(displayTime);
    }
    
    const percentage = Math.min(100, (displayTimeToCurrentTarget / state.recording.targetDurationSeconds) * 100);
    
    // Update progress bar at top
    const recordingProgressBar = document.getElementById('recordingProgressBar');
    if (recordingProgressBar) {
        recordingProgressBar.style.width = percentage + '%';
        
        // Add pulse animation when progress updates
        recordingProgressBar.classList.remove('pulse');
        void recordingProgressBar.offsetWidth; // Trigger reflow
        recordingProgressBar.classList.add('pulse');
    }
    
    // Update circular progress around record button
    const circularProgress = document.querySelector('.circular-progress .progress-fill');
    if (circularProgress) {
        // Calculate stroke-dashoffset based on percentage
        // Full circle is 282.743 (2πr where r=45)
        const circumference = 282.743;
        const offset = circumference - (percentage / 100) * circumference;
        circularProgress.style.strokeDashoffset = offset;
    }
    
    // Update circular time counter elements
    const currentRecordingTimeCircular = document.getElementById('currentRecordingTimeCircular');
    const targetRecordingTimeCircular = document.getElementById('targetRecordingTimeCircular');
    
    if (currentRecordingTimeCircular) {
        currentRecordingTimeCircular.textContent = formatTime(displayTime);
    }
    
    if (targetRecordingTimeCircular) {
        targetRecordingTimeCircular.textContent = formatTime(state.recording.targetDurationSeconds);
    }
    
    // Add has-progress class when there's accumulated time
    const recordingWrapper = document.querySelector('.recording-visual-feedback');
    if (recordingWrapper && displayTime > 0) {
        recordingWrapper.classList.add('has-progress');
    }
    
    // Show time counter when recording starts
    const timeCounter = document.querySelector('.time-counter');
    if (timeCounter && (state.recording.accumulatedTime > 0 || state.recording.isRecording)) {
        timeCounter.classList.add('active');
    }
    // Top time counter is always visible
    const topTimeCounter = document.querySelector('.top-time-counter');
    if (topTimeCounter) {
        topTimeCounter.classList.add('active');
    }
    
    // Manage generate report button state
    if (initialTargetMet && elements.generateReportBtn) {
        if (elements.generateReportBtn.disabled) {
            elements.generateReportBtn.disabled = false;
            elements.generateReportBtn.classList.remove('hidden');

            if (!alertShown) {
                showTimeTargetReachedAlert();
            }
        }
    } else if (elements.generateReportBtn) {
        elements.generateReportBtn.disabled = true;
        elements.generateReportBtn.classList.add('hidden');
    }
}

// Update question counter
export function updateQuestionCounter() {
    if (elements.questionCounterElem) {
        elements.questionCounterElem.textContent = `Q: ${state.ui.questionCount}`;
    }
}

// Show time target reached alert
function showTimeTargetReachedAlert() {
    const alertElement = document.createElement('div');
    alertElement.id = 'reportReadyAlert';
    alertElement.className = 'fixed top-20 right-4 bg-white dark:bg-gray-800 text-gray-800 dark:text-white p-4 rounded-lg shadow-lg z-50 animate-fade-in border-l-4 border-accent-primary max-w-sm';
    alertElement.innerHTML = `
        <div class="flex items-start">
            <div class="flex-shrink-0 text-accent-primary">
                <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
            </div>
            <div class="ml-3">
                <h3 class="text-sm font-medium">Ready to Submit!</h3>
                <div class="mt-1 text-sm text-gray-600 dark:text-gray-300">
                    <p>Great job! You've recorded for 5 minutes. Submit now to receive your personalized summary, or continue answering for deeper insights.</p>
                </div>
                <div class="mt-2 flex space-x-2">
                    <button id="dismissAlertBtn" class="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">Continue Recording</button>
                    <button id="generateNowBtn" class="text-sm font-medium text-accent-primary hover:text-accent-secondary">Submit Interview</button>
                </div>
            </div>
            <button id="closeAlertBtn" class="ml-auto text-gray-400 hover:text-gray-500 dark:hover:text-gray-300">
                <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </div>
    `;
    document.body.appendChild(alertElement);

    // Add event listeners
    document.getElementById('dismissAlertBtn').addEventListener('click', () => {
        alertElement.remove();
    });
    document.getElementById('closeAlertBtn').addEventListener('click', () => {
        alertElement.remove();
    });
    document.getElementById('generateNowBtn').addEventListener('click', () => {
        elements.generateReportBtn.click();
        alertElement.remove();
    });

    // Auto-dismiss after 15 seconds
    setTimeout(() => {
        if (document.body.contains(alertElement)) {
            alertElement.remove();
        }
    }, 15000);
}

// Show time limit extended alert
function showTimeLimitExtendedAlert() {
    const isStoryMode = new URLSearchParams(window.location.search).get('interview') === 'story-template-v1';

    const alertElement = document.createElement('div');
    alertElement.id = 'timeLimitExtendedAlert';
    alertElement.className = 'fixed top-20 right-4 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 p-4 rounded-lg shadow-lg z-50 animate-fade-in border-l-4 border-blue-500 max-w-sm';

    const title = isStoryMode ? 'You\'re in the flow — keep going' : 'Goal Reached & Time Extended!';
    const body = isStoryMode
        ? 'You\'ve been sharing for 5 minutes. Stay with it as long as there\'s more to tell. End your session whenever the story feels complete.'
        : 'You\'ve met the initial 5-minute goal! The recording target has been extended by another 5 minutes. Feel free to continue, or generate your report now.';

    alertElement.innerHTML = `
        <div class="flex items-start">
            <div class="flex-shrink-0 text-blue-500">
                <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                </svg>
            </div>
            <div class="ml-3">
                <h3 class="text-sm font-medium">${title}</h3>
                <div class="mt-1 text-sm">
                    <p>${body}</p>
                </div>
                <div class="mt-2 flex space-x-2">
                    <button id="dismissExtendedAlertBtn" class="text-sm font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300">Got it!</button>
                </div>
            </div>
            <button id="closeExtendedAlertBtn" class="ml-auto text-gray-400 hover:text-gray-500 dark:hover:text-gray-300">
                <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </div>
    `;
    document.body.appendChild(alertElement);

    const dismissBtn = document.getElementById('dismissExtendedAlertBtn');
    const closeBtn = document.getElementById('closeExtendedAlertBtn');

    const removeAlert = () => {
        alertElement.style.opacity = '0';
        setTimeout(() => {
            if (alertElement.parentNode) {
                alertElement.parentNode.removeChild(alertElement);
            }
        }, 300);
    };

    if (dismissBtn) dismissBtn.addEventListener('click', removeAlert);
    if (closeBtn) closeBtn.addEventListener('click', removeAlert);

    // Auto-dismiss after 10 seconds
    setTimeout(() => {
        if (document.body.contains(alertElement)) {
            removeAlert();
        }
    }, 10000);
} 