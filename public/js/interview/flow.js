// Interview flow module - handles interview start logic and flow management
import { state, setCustomInterviewData } from '../state.js';
import { elements } from '../dom.js';
import { config } from '../config.js';
// Use window functions since utils.js is not a module anymore
const showError = window.showError;
const clearError = window.clearError;
const formatTime = window.formatTime;
import { setupMicrophone } from '../audio/recorder.js';
import { setupVideoStream, toggleVideo } from '../audio/video-recorder.js';
import { updateRecordingProgressUI, updateQuestionCounter } from '../ui/controls.js';

// Start the interview
export async function startInterview() {
    state.interview.startTime = Date.now();
    console.log(`⏱️ CLIENT TIMING - Interview starting at ${new Date().toISOString()}`);
    
    // Clear any old session ID from localStorage to prevent conflicts
    const oldSessionId = localStorage.getItem('archiveSessionId');
    if (oldSessionId) {
        console.log('[startInterview] Clearing old session ID from localStorage:', oldSessionId);
        localStorage.removeItem('archiveSessionId');
    }
    
    // Validate form inputs
    if (!state.form.isNameFilled || !state.form.isEmailFilled) {
        alert('Please enter your name and a valid email address.');
        if (!state.form.isNameFilled && elements.nameError) {
            elements.nameError.classList.remove('hidden');
        }
        if (!state.form.isEmailFilled && elements.emailError) {
            elements.emailError.classList.remove('hidden');
        }
        return;
    }
    
    if (state.interview.requiresDocument && !state.form.fileUploaded) {
        alert('Please upload or paste your resume before starting.');
        return;
    }



    try {
        console.log('Starting interview...');
        clearError();
        
        // Set interview in progress
        state.interview.inProgress = true;
        
        // Update header title for the interview
        updateHeaderTitle();
        
        // Update interview context in time counter
        updateInterviewContext();
        
        // Show calling screen during transition
        showInterviewCallingScreen();
        
        // Update UI - hide upload area, show interview interface after delay
        if (elements.fileUploadArea) elements.fileUploadArea.classList.add('hidden');
        if (elements.introText) elements.introText.classList.add('hidden');
        
        // Delay showing interview interface to allow calling screen animation
        setTimeout(() => {
            if (elements.interviewInterface) elements.interviewInterface.classList.remove('hidden');
            hideInterviewCallingScreen();
        }, 2000);
        
        // Activate progress section
        const progressSection = document.querySelector('.progress-section');
        if (progressSection) {
            progressSection.classList.add('active');
        }
        
        const timeCounter = document.querySelector('.time-counter');
        if (timeCounter) timeCounter.classList.add('active');

        // Reset state variables
        state.ui.questionCount = 0;
        updateQuestionCounter();
        state.ui.currentThinkingTrace = '';
        hideThinkingModal();

        // Reset timer variables
        state.recording.accumulatedTime = 0;
        state.recording.targetDurationSeconds = config.recording.initialTargetDurationSeconds;
        state.recording.timeLimitExtended = false;
        
        if (elements.targetRecordingTimeElem) {
            elements.targetRecordingTimeElem.textContent = formatTime(state.recording.targetDurationSeconds);
        }
        updateRecordingProgressUI();

        // Reset UI elements
        // Priority: 1) Custom question from URL (already personalized)
        //           2) Template's initial question
        let initialQuestion = state.customFirstQuestion ||
                              state.interview.spec?.initialPrompt ||
                              state.interview.customData?.initialPrompt;

        // If the question contains placeholders, wait for server to personalize
        if (initialQuestion && initialQuestion.includes('{{')) {
            console.log('Initial question contains placeholders, waiting for server to personalize');
            initialQuestion = null;
        }

        if (elements.currentQuestionDisplay) {
            if (initialQuestion) {
                elements.currentQuestionDisplay.innerHTML = initialQuestion;
                console.log('Setting initial question:', initialQuestion);
            } else {
                elements.currentQuestionDisplay.innerHTML = '';
            }
        }
        if (elements.currentQuestionDisplayVideo) {
            if (initialQuestion) {
                elements.currentQuestionDisplayVideo.innerHTML = initialQuestion;
            } else {
                elements.currentQuestionDisplayVideo.innerHTML = '';
            }
        }
        if (elements.thinkingTraceDisplay) {
            elements.thinkingTraceDisplay.classList.remove('expanded');
        }
        // Visualization cleanup removed - using thinking panel instead
        if (elements.viewThinkingToggle) {
            elements.viewThinkingToggle.classList.add('hidden');
        }
        if (elements.recordingStatus) {
            elements.recordingStatus.textContent = 'Click Record to start answering';
        }
        if (elements.interviewInfoMessage) {
            elements.interviewInfoMessage.classList.add('hidden');
        }
        
        // Ensure thinking canvas is hidden and thinking state is cleared
        const thinkingCanvas = document.getElementById('thinkingCanvas');
        if (thinkingCanvas) thinkingCanvas.style.display = 'none';
        document.body.classList.remove('thinking-active');

        // Prepare interview data
        const interviewData = prepareInterviewData();
        
        console.log('Emitting startInterview event with params:', {
            resumeLength: interviewData.resume ? interviewData.resume.length : 0,
            userName: interviewData.userName,
            userEmail: interviewData.userEmail,
            interviewId: interviewData.interviewId || null
        });

        // Send interview data to server
        state.socket.instance.emit('startInterview', interviewData);
        
        // Set video state based on user preference (checkbox or template)
        state.video.isEnabled = interviewData.enableVideoRecording;
        console.log('Video recording enabled:', state.video.isEnabled);
        
        // Initialize microphone
        const micReady = await setupMicrophone();
        if (!micReady) {
            console.error("Microphone setup failed during interview start.");
            return;
        }
        
        // Try to initialize video (optional - don't fail interview if video setup fails)
        // Always attempt video setup to give users the option
        try {
            const videoEnabled = await setupVideoStream();
            if (videoEnabled) {
                console.log("Video stream initialized successfully");
                
                // Show video toggle button and set up event listener
                const toggleBtn = document.getElementById('toggleVideoBtn');
                const videoContainer = document.getElementById('videoPreviewContainer');
                
                // Make sure the video preview container is visible
                if (videoContainer) {
                    videoContainer.classList.remove('hidden');
                }
                
                if (toggleBtn) {
                    toggleBtn.style.display = 'block';
                    
                    // Add click event listener if not already added
                    if (!toggleBtn.hasAttribute('data-listener-added')) {
                        console.log("Setting up toggleVideoBtn event listener after video setup");
                        toggleBtn.addEventListener('click', () => {
                            console.log("Video toggle button clicked!");
                            toggleVideo();
                        });
                        toggleBtn.setAttribute('data-listener-added', 'true');
                    }
                }
                
                // Ensure focus remains on the document body after video setup
                setTimeout(() => {
                    if (document.activeElement && document.activeElement.id === 'videoPreview') {
                        console.log("Video element has focus, returning focus to body");
                        document.body.focus();
                    }
                }, 100);
            } else {
                console.log("Video setup not available, continuing with audio-only");
            }
        } catch (error) {
            console.log("Video setup failed, continuing with audio-only:", error.message);
        }
        
        // Ensure record button is enabled after microphone setup
        // Enable immediately if we have an initial question, otherwise wait for server
        if (elements.recordBtn && !state.ui.thinking) {
            if (initialQuestion) {
                elements.recordBtn.disabled = false;
                console.log("Record button enabled immediately - initial question available");
            } else {
                // Will be enabled when first question arrives from server
                console.log("Record button will be enabled when first question arrives");
            }
        }

    } catch (error) {
        console.error('Error starting interview:', error);
        showError('Error starting interview: ' + error.message);
    }
}

// Update header title for interview
function updateHeaderTitle() {
    const headerTitle = elements.headerTitle;
    if (headerTitle && state.interview.customData && state.interview.customData.indexHeader) {
        headerTitle.innerHTML = `<img src="saylogo.png" alt="Say Logo" class="inline-block align-middle mr-2" width="28" height="28" style="border-radius: 4px;"> <span>${state.interview.customData.indexHeader}</span>`;
    } else if (headerTitle) {
        headerTitle.innerHTML = `<img src="saylogo.png" alt="Say Logo" class="inline-block align-middle mr-2" width="28" height="28" style="border-radius: 4px;"> <span>Say Interviews</span>`;
    }
}

// Update interview context in time counter
function updateInterviewContext() {
    if (elements.interviewContextElem) {
        // Get interview title from custom data or use default
        const interviewTitle = state.interview.customData?.title || 'Interview';
        elements.interviewContextElem.textContent = `in ${interviewTitle}`;
    }
}

// Prepare interview data for server
function prepareInterviewData() {
    const interviewData = {
        // Send resume content if it exists (from document upload OR link scraping), regardless of requiresDocument setting
        resume: state.form.resumeText || "",
        uploadedFile: state.uploadedFile || null, // Include uploaded file metadata
        userName: elements.userNameInput ? elements.userNameInput.value.trim() : '',
        userEmail: elements.userEmailInput ? elements.userEmailInput.value.trim() : '',
        enableWebSearch: getCustomDataValue('enableWebSearch', true),
        // Use checkbox value if available, otherwise fall back to template setting
        enableThinking: window.appState?.interviewSpec?.enableThinking !== undefined ? 
            window.appState.interviewSpec.enableThinking : 
            getCustomDataValue('enableThinking', true),
        enableMemoryService: getCustomDataValue('enableMemoryService', true),
        followupModel: getCustomDataValue('followupModel', 'claude-opus-4-5'),
        // Get video preference from checkbox, fallback to template setting, then to false
        enableVideoRecording: elements.enableVideoRecording ? 
            elements.enableVideoRecording.checked : 
            getCustomDataValue('enableVideoRecording', false)
    };

    // Add userId if user is authenticated (for usage tracking)
    if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
        interviewData.userId = firebase.auth().currentUser.uid;
        console.log('Adding authenticated user ID for usage tracking:', interviewData.userId);
    } else {
        console.log('No authenticated user found - interview will not count towards usage limits');
    }


    // Add adminEmail if present in URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const adminEmail = urlParams.get('adminEmail');
    if (adminEmail) {
        interviewData.adminEmail = decodeURIComponent(adminEmail);
        console.log('Including adminEmail in interview data:', interviewData.adminEmail);
    }
    
    // Add campaign tracking if present in URL parameters
    const campaignEmailId = urlParams.get('ceid'); // Campaign Email ID
    if (campaignEmailId) {
        interviewData.campaignEmailId = campaignEmailId;
        console.log('Including campaign email ID for tracking:', campaignEmailId);
    }

    // Add UTM parameters if present in URL
    const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    const utmParams = {};
    utmKeys.forEach(key => {
        const value = urlParams.get(key);
        if (value) utmParams[key] = value;
    });
    if (Object.keys(utmParams).length > 0) {
        interviewData.utmParams = utmParams;
        console.log('Including UTM parameters:', utmParams);
    }

    // Add interviewId if available
    if (state.interview.customData && state.interview.customData.id) {
        interviewData.interviewId = state.interview.customData.id;
        console.log('Using interview ID from customInterviewData:', interviewData.interviewId);
    } else if (state.interview.id) {
        interviewData.interviewId = state.interview.id;
        console.log('Using interview ID from URL:', interviewData.interviewId);
    }
    
    // Pass storyId so server can detect story mode on stopInterview
    const storyId = urlParams.get('storyId');
    if (storyId) {
        interviewData.storyId = storyId;
        interviewData.mode = 'story';
    }

    // Add custom first question if provided via URL parameter
    if (state.customFirstQuestion) {
        interviewData.prompt = state.customFirstQuestion;
        console.log('Including custom first question from URL parameter');
    }

    return interviewData;
}

// Get value from custom interview data with fallback
function getCustomDataValue(key, defaultValue) {
    if (state.interview.customData && state.interview.customData[key] !== undefined) {
        return state.interview.customData[key];
    }
    return defaultValue;
}

// Hide thinking modal helper
function hideThinkingModal() {
    if (window.hideThinkingModal) {
        window.hideThinkingModal();
    }
}

// Show interview calling screen
function showInterviewCallingScreen() {
    // Create calling screen overlay
    const callingOverlay = document.createElement('div');
    callingOverlay.id = 'interviewCallingOverlay';
    callingOverlay.className = 'fixed inset-0 z-50 flex items-center justify-center';
    callingOverlay.innerHTML = `
        <div class="calling-screen">
            <div class="calling-avatar">
                <div class="avatar-ring"></div>
                <div class="avatar-ring"></div>
                <div class="avatar-ring"></div>
                <div class="avatar-inner">
                    <svg width="40" height="40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path>
                    </svg>
                </div>
            </div>
            <h2 class="calling-status">Connecting to your interviewer</h2>
            <div class="calling-dots">
                <span></span>
                <span></span>
                <span></span>
            </div>
        </div>
    `;
    
    // Add video-enabled class if video is enabled
    if (elements.enableVideoRecording && elements.enableVideoRecording.checked) {
        callingOverlay.classList.add('video-enabled');
    }
    
    document.body.appendChild(callingOverlay);
}

// Hide interview calling screen
function hideInterviewCallingScreen() {
    const callingOverlay = document.getElementById('interviewCallingOverlay');
    if (callingOverlay) {
        callingOverlay.style.opacity = '0';
        callingOverlay.style.transition = 'opacity 0.5s ease';
        setTimeout(() => {
            callingOverlay.remove();
        }, 500);
    }
}

// Export for global access
window.startInterview = startInterview;

 