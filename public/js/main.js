// Main entry point - initializes the application and ties all modules together
import { config, getSessionStorageKey } from './config.js';
import { state, setCustomInterviewData } from './state.js';
import { elements } from './dom.js';
// Use window functions since utils.js is not a module anymore
const formatTime = window.formatTime;
const showError = window.showError;
const clearError = window.clearError;
// logPerformanceSummary doesn't exist in utils.js, define a stub
const logPerformanceSummary = (state) => console.log('Performance summary:', state);
import { initializeSocket } from './socket/events.js';
import { setupMicrophone, toggleRecording, togglePause } from './audio/recorder.js';
import { setupVideoStream, toggleVideo, cleanupVideo } from './audio/video-recorder.js';
import { updateRecordingProgressUI, updateQuestionCounter } from './ui/controls.js';
import { initializeFileUpload, validatePastedResume, switchTab } from './ui/fileUpload.js';
import { initializeContextUpload } from './ui/context-upload.js';
import { initializeTheme } from './ui/theme.js';
import { startInterview } from './interview/flow.js';
import { initializeKeyboardHandlers } from './ui/keyboard.js';
// import { initializeTTSControls } from './ui/tts-controls.js'; // TTS disabled

// Display admin/organization info
function displayAdminInfo(adminName, organization) {
    const adminInfoDiv = document.getElementById('adminInfo');
    const adminNameSpan = document.getElementById('adminName');
    const adminOrgSpan = document.getElementById('adminOrg');
    const adminOrgText = document.getElementById('adminOrgText');
    
    if (adminInfoDiv && adminNameSpan) {
        adminNameSpan.textContent = adminName || 'Unknown';
        adminInfoDiv.classList.remove('hidden');
        
        if (organization && adminOrgSpan && adminOrgText) {
            adminOrgText.textContent = organization;
            adminOrgSpan.classList.remove('hidden');
        }
    }
}

// Initialize the application
async function initializeApp() {
    console.log("===== APPLICATION INITIALIZATION =====");
    
    // Expose config to window for non-module scripts
    window.config = config;
    
    // Debug: Check if critical DOM elements exist
    console.log("DOM Elements Check:");
    console.log("- recordBtn:", elements.recordBtn ? "✓ Found" : "✗ Missing");
    console.log("- pauseBtn:", elements.pauseBtn ? "✓ Found" : "✗ Missing");
    console.log("- startChatBtn:", elements.startChatBtn ? "✓ Found" : "✗ Missing");
    console.log("- userNameInput:", elements.userNameInput ? "✓ Found" : "✗ Missing");
    console.log("- userEmailInput:", elements.userEmailInput ? "✓ Found" : "✗ Missing");
    
    // Debug: Check if critical functions are imported
    console.log("Function Imports Check:");
    console.log("- toggleRecording:", typeof toggleRecording === 'function' ? "✓ Function" : "✗ Missing");
    console.log("- togglePause:", typeof togglePause === 'function' ? "✓ Function" : "✗ Missing");
    console.log("- startInterview:", typeof startInterview === 'function' ? "✓ Function" : "✗ Missing");
    console.log("- setupMicrophone:", typeof setupMicrophone === 'function' ? "✓ Function" : "✗ Missing");
    
    // Initialize socket connection
    const socket = initializeSocket();
    
    // Set up initial UI state
    initializeUI();
    
    // Always use the enhanced context upload with tabs (file, paste, scrape)
    // This provides more options for users to add context
    initializeContextUpload();
    
    // Initialize theme handling - Force light mode
    initializeTheme();
    console.log("Theme initialized - should be light mode");
    
    // Initialize keyboard handlers
    initializeKeyboardHandlers();
    
    // Initialize TTS controls - DISABLED
    // initializeTTSControls();
    
    // Set up event listeners
    setupEventListeners();
    
    // Check for interview ID in URL and handle custom interviews
    await handleCustomInterview();
    
    // Check for session restoration
    handleSessionRestoration();
    
    // Set initial target time display
    if (elements.targetRecordingTimeElem) {
        elements.targetRecordingTimeElem.textContent = formatTime(config.recording.initialTargetDurationSeconds);
    }
    
    // Check for autofilled fields on load
    setTimeout(() => {
        if (elements.userNameInput && elements.userNameInput.value.trim() !== '') {
            state.form.isNameFilled = true;
        }
        if (elements.userEmailInput && elements.userEmailInput.value.trim() !== '') {
            const emailVal = elements.userEmailInput.value.trim();
            state.form.isEmailFilled = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal);
        }
        checkFormCompletion();
    }, 100);
    
    console.log("===== APPLICATION INITIALIZATION COMPLETE =====");
}

// Initialize UI state
function initializeUI() {
    // Hide status messages initially
    if (elements.uploadStatus) elements.uploadStatus.classList.add('hidden');
    if (elements.pasteStatus) elements.pasteStatus.classList.add('hidden');
    if (elements.uploadedFile) elements.uploadedFile.classList.add('hidden');
    if (elements.errorMessage) elements.errorMessage.classList.add('hidden');
    
    // Set initial question counter
    updateQuestionCounter();
    
    // Set initial recording progress
    updateRecordingProgressUI();
    
    // Set default tab
    switchTab('upload');
    
    // Set header title
    if (elements.headerTitle) {
        elements.headerTitle.innerHTML = `<img src="saylogo.png" alt="PAIRR Logo" class="inline-block align-middle mr-2" width="28" height="28" style="border-radius: 4px;"> <span>Say Research</span>`;
    }
}

// Set up main event listeners
function setupEventListeners() {
    console.log("Setting up event listeners...");
    console.log("[setupEventListeners] Adding click listener to document for audio play buttons...");
    
    // Two-step form navigation
    const nextToStep2Btn = document.getElementById('nextToStep2Btn');
    const backToStep1Btn = document.getElementById('backToStep1Btn');
    const step1Container = document.getElementById('step1Container');
    const step2Container = document.getElementById('step2Container');
    
    if (nextToStep2Btn) {
        nextToStep2Btn.addEventListener('click', () => {
            // Re-check form values in case of autofill
            state.form.isNameFilled = elements.userNameInput && elements.userNameInput.value.trim() !== '';
            const emailVal = elements.userEmailInput ? elements.userEmailInput.value.trim() : '';
            state.form.isEmailFilled = emailVal !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal);
            
            // Validate step 1 fields
            if (!state.form.isNameFilled || !state.form.isEmailFilled) {
                if (!state.form.isNameFilled && elements.nameError) {
                    elements.nameError.classList.remove('hidden');
                }
                if (!state.form.isEmailFilled && elements.emailError) {
                    elements.emailError.classList.remove('hidden');
                }
                return;
            }
            
            // Hide step 1, show step 2
            step1Container.classList.add('hidden');
            step2Container.classList.remove('hidden');
            
            // Keep intro text visible but hide the description and admin info
            const introTextSubheading = document.getElementById('introTextSubheading');
            if (introTextSubheading) {
                introTextSubheading.classList.add('hidden');
            }
            const adminInfo = document.getElementById('adminInfo');
            if (adminInfo) {
                adminInfo.classList.add('hidden');
            }
            
            // Show back button container
            const backButtonContainer = document.getElementById('backButtonContainer');
            if (backButtonContainer) {
                backButtonContainer.classList.remove('hidden');
            }
            
            // Context upload is always visible on step 2 - no need to check requiresDocument
            const uploadSection = document.getElementById('uploadSection');
            if (uploadSection) {
                uploadSection.classList.remove('hidden');
            }
            
            // Show start button if context is optional or already provided
            if (!state.interview.requiresDocument || state.form.fileUploaded) {
                if (elements.startButtonContainer) {
                    elements.startButtonContainer.classList.remove('hidden');
                }
                
                // Also show video toggle
                const videoToggleSection = document.getElementById('videoToggleSection');
                if (videoToggleSection) {
                    videoToggleSection.classList.remove('hidden');
                }
                
                // Call checkFormCompletion to ensure button state is correct
                checkFormCompletion();
            }
        });
    }
    
    if (backToStep1Btn) {
        backToStep1Btn.addEventListener('click', () => {
            // Show step 1, hide step 2
            step2Container.classList.add('hidden');
            step1Container.classList.remove('hidden');
            
            // Show the description and admin info again on step 1
            const introTextSubheading = document.getElementById('introTextSubheading');
            if (introTextSubheading) {
                introTextSubheading.classList.remove('hidden');
            }
            const adminInfo = document.getElementById('adminInfo');
            if (adminInfo) {
                adminInfo.classList.remove('hidden');
            }
            
            // Hide back button container
            const backButtonContainer = document.getElementById('backButtonContainer');
            if (backButtonContainer) {
                backButtonContainer.classList.add('hidden');
            }
            
            // Hide start button when going back
            if (elements.startButtonContainer) {
                elements.startButtonContainer.classList.add('hidden');
            }
        });
    }
    
    // Delegated event listener for audio summary buttons
    document.addEventListener('click', async function(e) {
        console.log('[Click Event] Clicked element:', e.target);
        console.log('[Click Event] Element classes:', e.target.className);
        console.log('[Click Event] Parent classes:', e.target.parentElement?.className);
        console.log('[Click Event] Closest .create-video-summary:', e.target.closest('.create-video-summary'));
        console.log('[Click Event] Closest .audio-quote-play-btn:', e.target.closest('.audio-quote-play-btn'));
        
        if (e.target.closest('.create-audio-summary')) {
            console.log('[Audio Summary Button] Click detected!');
            e.preventDefault();
            const messageElement = e.target.closest('.message');
            console.log('[Audio Summary Button] Message element:', messageElement);
            if (messageElement) {
                await handleCreateAudioSummary(messageElement);
            } else {
                console.error('[Audio Summary Button] Could not find parent message element');
            }
        }
        
        // Handle create video summary button
        if (e.target.closest('.create-video-summary')) {
            console.log('[Video Summary Button] Click detected!');
            console.log('[Video Summary Button] Target:', e.target);
            console.log('[Video Summary Button] Closest button:', e.target.closest('.create-video-summary'));
            e.preventDefault();
            e.stopPropagation();
            const messageElement = e.target.closest('.message');
            console.log('[Video Summary Button] Message element:', messageElement);
            if (messageElement) {
                console.log('[Video Summary Button] Calling handleCreateVideoSummary...');
                await handleCreateVideoSummary(messageElement);
            } else {
                console.error('[Video Summary Button] Could not find parent message element');
            }
        }
        
        // Handle clicks on audio quote play buttons
        if (e.target.closest('.audio-quote-play-btn')) {
            console.log('[Audio Play Button] Click detected!');
            e.preventDefault();
            const button = e.target.closest('.audio-quote-play-btn');
            console.log('[Audio Play Button] Button element:', button);
            const blockquote = button.closest('blockquote[data-audio-id]');
            console.log('[Audio Play Button] Blockquote element:', blockquote);
            const audioId = blockquote ? blockquote.getAttribute('data-audio-id') : null;
            console.log('[Audio Play Button] Audio ID:', audioId);
            if (audioId) {
                console.log('[Audio Play Button] Calling playAudioClip...');
                await playAudioClip(audioId, blockquote, button);
            } else {
                console.error('[Audio Play Button] No audio ID found!');
            }
        }
        
        // Handle clicks on audio citations
        if (e.target.closest('.audio-citation')) {
            console.log('[Audio Citation] Click detected!');
            e.preventDefault();
            const citation = e.target.closest('.audio-citation');
            const audioId = citation.getAttribute('data-audio-id');
            console.log('[Audio Citation] Audio ID:', audioId);
            if (audioId) {
                console.log('[Audio Citation] Calling playAudioClip...');
                await playAudioClip(audioId, citation, null);
            } else {
                console.error('[Audio Citation] No audio ID found!');
            }
        }
        
        // Handle clicks on transcript video play buttons
        if (e.target.closest('.play-transcript-video-btn')) {
            console.log('[Video Play Button] Click detected!');
            e.preventDefault();
            const button = e.target.closest('.play-transcript-video-btn');
            const videoUrl = button.dataset.videoUrl;
            
            if (videoUrl) {
                // Create and show video modal
                const modal = document.createElement('div');
                modal.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50';
                modal.innerHTML = `
                    <div class="relative max-w-4xl w-full mx-4">
                        <button class="absolute top-4 right-4 text-white hover:text-gray-300 z-10" onclick="this.closest('.fixed').remove()">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                        <video controls autoplay class="w-full rounded-lg shadow-2xl" style="max-height: 80vh;">
                            <source src="${videoUrl}" type="video/mp4">
                            Your browser does not support the video tag.
                        </video>
                    </div>
                `;
                
                // Add click handler to close on background click
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) {
                        modal.remove();
                    }
                });
                
                document.body.appendChild(modal);
            }
        }
    });
    
    // Main action buttons
    if (elements.startChatBtn) {
        console.log("✓ Setting up startChatBtn event listener");
        elements.startChatBtn.addEventListener('click', startInterview);
    } else {
        console.error("✗ startChatBtn not found!");
    }
    
    if (elements.recordBtn) {
        console.log("✓ Setting up recordBtn event listener");
        elements.recordBtn.addEventListener('click', () => {
            console.log("Record button clicked! Calling toggleRecording...");
            toggleRecording();
        });
    } else {
        console.error("✗ recordBtn not found!");
    }
    
    if (elements.pauseBtn) {
        console.log("✓ Setting up pauseBtn event listener");
        elements.pauseBtn.addEventListener('click', () => {
            console.log("Pause button clicked! Calling togglePause...");
            togglePause();
        });
    } else {
        console.warn("⚠ pauseBtn not found (this is normal if hidden initially)");
    }
    
    // Video toggle button (only if video is enabled)
    const toggleVideoBtn = document.getElementById('toggleVideoBtn');
    const videoPreviewContainer = document.getElementById('videoPreviewContainer');
    
    if (state.video.isEnabled) {
        // Show video UI elements
        if (videoPreviewContainer) {
            videoPreviewContainer.classList.remove('hidden');
        }
        
        if (toggleVideoBtn) {
            console.log("✓ Setting up toggleVideoBtn event listener");
            toggleVideoBtn.addEventListener('click', () => {
                console.log("Video toggle button clicked!");
                toggleVideo();
            });
        }
    } else {
        // Hide video UI elements when video is disabled
        if (videoPreviewContainer) {
            videoPreviewContainer.classList.add('hidden');
        }
        console.log("Video recording is disabled for this interview - video UI hidden");
    }
    
    // Generate report button
    if (elements.generateReportBtn) {
        elements.generateReportBtn.addEventListener('click', function() {
            if (state.recording.accumulatedTime >= config.recording.initialTargetDurationSeconds) {
                state.socket.instance.emit('stopInterview');
                
                // Hide UI elements and disable buttons
                if (elements.thinkingTraceDisplay) {
                    elements.thinkingTraceDisplay.classList.remove('expanded');
                }
                
                // Visualization cleanup removed - using thinking panel instead
                
                const canvas = document.getElementById('thinkingCanvas');
                if (canvas) canvas.style.display = 'none';
                
                document.body.classList.remove('thinking-active');
                
                if (elements.viewThinkingToggle) {
                    elements.viewThinkingToggle.classList.add('hidden');
                }
                
                elements.recordBtn.disabled = true;
                elements.generateReportBtn.disabled = true;
            }
        });
    }
    
    // Example report button
    const generateExampleBtn = document.getElementById('generateExampleBtn');
    if (generateExampleBtn) {
        generateExampleBtn.addEventListener('click', () => {
            console.log('Requesting example report generation...');
            generateExampleBtn.textContent = 'Preparing example...';
            generateExampleBtn.disabled = true;
            state.socket.instance.emit('requestExampleReportGeneration');
        });
    }
    
    // Test report button (dev mode)
    const testReportBtn = document.getElementById('testReportBtn');
    if (testReportBtn) {
        testReportBtn.addEventListener('click', () => {
            console.log('[TEST] Simulating interview completion...');
            
            // First ensure we have a session
            if (!state.socket.instance || !state.socket.instance.connected) {
                console.error('[TEST] Socket not connected!');
                alert('Socket not connected. Please refresh the page.');
                return;
            }
            
            // Set minimal interview state
            state.recording.accumulatedTime = 300; // 5 minutes
            state.recording.targetDurationSeconds = 300; // Set target to match accumulated
            state.ui.questionCount = 1;
            state.interview.inProgress = true;
            state.interview.startTime = Date.now() - 300000; // 5 minutes ago
            
            // Ensure we have the generate report button visible
            if (!elements.generateReportBtn) {
                console.error('[TEST] Generate report button not found!');
                // Try to find it directly
                const btn = document.getElementById('generateReportBtn');
                console.log('[TEST] Direct search for button:', btn);
                if (!btn) {
                    console.error('[TEST] Button truly not in DOM');
                    return;
                }
                elements.generateReportBtn = btn;
            }
            
            // Update UI to show we can generate report
            updateRecordingProgressUI();
            
            // Close any existing alerts
            const alerts = document.querySelectorAll('#reportReadyAlert, #timeLimitExtendedAlert');
            alerts.forEach(alert => alert.remove());
            
            // Make sure button is visible and enabled
            elements.generateReportBtn.disabled = false;
            elements.generateReportBtn.classList.remove('hidden');
            
            console.log('[TEST] Test setup complete. You can now click "Submit Interview" button.');
            console.log('[TEST] Button classes:', elements.generateReportBtn.className);
            console.log('[TEST] Button disabled:', elements.generateReportBtn.disabled);
            testReportBtn.textContent = 'Setup Complete - Click Submit Interview';
            testReportBtn.style.background = '#27ae60';
        });
    }
    
    // Form validation listeners
    if (elements.userNameInput) {
        console.log("✓ Setting up userNameInput event listener");
        elements.userNameInput.addEventListener('input', () => {
            state.form.isNameFilled = elements.userNameInput.value.trim() !== '';
            if (elements.nameError) {
                elements.nameError.classList.toggle('hidden', state.form.isNameFilled);
            }
            checkFormCompletion();
        });
    } else {
        console.error("✗ userNameInput not found!");
    }
    
    if (elements.userEmailInput) {
        console.log("✓ Setting up userEmailInput event listener");
        elements.userEmailInput.addEventListener('input', () => {
            const emailVal = elements.userEmailInput.value.trim();
            const emailIsValid = emailVal !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal);
            state.form.isEmailFilled = emailIsValid;
            
            if (elements.emailError) {
                elements.emailError.classList.toggle('hidden', emailIsValid || emailVal === '');
                elements.emailError.textContent = emailVal !== '' && !emailIsValid ? 
                    'Please enter a valid email.' : 'Please enter your email.';
            }
            checkFormCompletion();
        });
    } else {
        console.error("✗ userEmailInput not found!");
    }
    
    // Pasted resume validation
    if (elements.pastedResumeText) {
        elements.pastedResumeText.addEventListener('input', validatePastedResume);
    }
    
    console.log("Event listeners setup complete");
}

// Handle custom interview setup from URL
async function handleCustomInterview() {
    const urlParams = new URLSearchParams(window.location.search);
    const interviewId = urlParams.get('interview');
    
    if (interviewId) {
        state.interview.id = interviewId;
        console.log("Interview ID detected in URL:", interviewId);
        
        let interviewFound = false;
        
        try {
            // Try to fetch interview data from Firestore first
            if (typeof db !== 'undefined' && db && typeof db.collection === 'function') {
                console.log("Attempting Firestore fetch for:", interviewId);
                const interviewDoc = await db.collection('interviews').doc(interviewId).get();
                
                if (interviewDoc && interviewDoc.exists) {
                    const data = interviewDoc.data();
                    data.id = interviewId; // Add the document ID to the data
                    console.log("Interview data loaded from Firestore:", data.title);
                    setCustomInterviewData(data);
                    state.interview.spec = data;
                    interviewFound = true;
                    
                    // Check if this is the Interview Designer in design mode
                    const INTERVIEW_DESIGNER_ID = '5dbb409d-fade-4ece-ae9d-0bfb8ff34097';
                    const urlParams = new URLSearchParams(window.location.search);
                    const isDesignMode = urlParams.get('designMode') === 'true';
                    
                    if (interviewId === INTERVIEW_DESIGNER_ID && window.parent && window.parent !== window && isDesignMode) {
                        console.log("Interview Designer detected in iframe with design mode - enabling completion handling");
                        // Set flag that we'll check when report completes
                        state.isInterviewDesigner = true;
                    }
                    
                    // Reinitialize context upload with custom data now available
                    initializeContextUpload();
                    
                    // Fetch creator information
                    if (data.createdBy) {
                        try {
                            const userDoc = await db.collection('users').doc(data.createdBy).get();
                            if (userDoc.exists) {
                                const userData = userDoc.data();
                                displayAdminInfo(userData.displayName || userData.email, userData.organization);
                            }
                        } catch (error) {
                            console.error("Error fetching creator information:", error);
                        }
                    }
                } else {
                    console.log("Interview not found in Firestore, trying API fallback.");
                    interviewFound = await fetchFromServerAPI(interviewId);
                }
            } else {
                console.log("Firebase db not available. Proceeding to API fallback.");
                interviewFound = await fetchFromServerAPI(interviewId);
            }
            
            // If interview not found, redirect to 404 page
            if (!interviewFound) {
                console.log("Interview not found, redirecting to 404 page");
                window.location.href = '/interview-404.html';
                return;
            }
            
            // Process the interview specification
            await processInterviewSpec(interviewId);
            
        } catch (error) {
            console.error("Error during interview data loading:", error);
            // Redirect to 404 on error
            window.location.href = '/interview-404.html';
        }
    } else {
        // No interview ID provided - redirect to 404
        console.log("No interview ID provided, redirecting to 404 page");
        window.location.href = '/interview-404.html';
    }
}

// Fetch interview data from server API
async function fetchFromServerAPI(interviewId) {
    try {
        console.log("Calling server API for interview ID:", interviewId);
        const response = await fetch(`/api/interview/${interviewId}`);
        
        if (response.ok) {
            const data = await response.json();
            console.log("Interview data received from API:", data);
            console.log("API response - ID:", data.id, "Title:", data.title);
            if (!data.id && interviewId) data.id = interviewId;
            setCustomInterviewData(data);
            state.interview.spec = data;
            
            // Check if this is the Interview Designer in design mode
            const INTERVIEW_DESIGNER_ID = '5dbb409d-fade-4ece-ae9d-0bfb8ff34097';
            const urlParams = new URLSearchParams(window.location.search);
            const isDesignMode = urlParams.get('designMode') === 'true';
            
            if (interviewId === INTERVIEW_DESIGNER_ID && window.parent && window.parent !== window && isDesignMode) {
                console.log("Interview Designer detected in iframe with design mode - enabling completion handling");
                // Set flag that we'll check when report completes
                state.isInterviewDesigner = true;
            }
            
            // Reinitialize context upload with custom data now available
            initializeContextUpload();
            
            // Display creator information if available
            if (data.creatorInfo) {
                displayAdminInfo(data.creatorInfo.displayName, data.creatorInfo.organization);
            }
            
            return true; // Interview found
        } else {

            console.warn("Failed to fetch interview data from server:", await response.text());
            return false; // Interview not found

        }
    } catch (error) {
        console.error("Error fetching interview data from server:", error);
        return false; // Error, treat as not found
    }
}

// Process interview specification and handle admin auto-start
async function processInterviewSpec(interviewId) {
    const currentSpec = state.interview.spec || state.interview.customData;
    
    if (!currentSpec) {
        console.error("Critical: No interview specification found for ID:", interviewId);
        state.interview.requiresDocument = true;
        updateUploaderVisibility();
        checkFormCompletion();
        return;
    }
    
    if (!currentSpec.id) {
        console.warn("Warning: Interview specification missing ID, adding it:", interviewId);
        currentSpec.id = interviewId;
        // Update both spec references
        if (state.interview.spec) state.interview.spec.id = interviewId;
        if (state.interview.customData) state.interview.customData.id = interviewId;
    }
    
    console.log("Processing valid spec:", currentSpec.title);
    
    // Apply interview theme if specified
    if (currentSpec.interviewTheme) {
        console.log("Interview has theme specified:", currentSpec.interviewTheme);
        // Skip applying interview theme to maintain light mode
        // const { setTheme } = await import('./ui/theme.js');
        // setTheme(currentSpec.interviewTheme);
        // console.log("Applied interview theme:", currentSpec.interviewTheme);
    }
    
    // Update page title and meta tags
    document.title = currentSpec.title || currentSpec.indexHeader || 'Say Interviews';
    
    // Update meta description
    const metaDescription = document.querySelector('meta[name="description"]');
    if (metaDescription && currentSpec.description) {
        metaDescription.setAttribute('content', currentSpec.description);
    }
    
    // Update Open Graph meta tags
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && currentSpec.title) {
        ogTitle.setAttribute('content', currentSpec.title);
    }
    
    const ogDescription = document.querySelector('meta[property="og:description"]');
    if (ogDescription && currentSpec.description) {
        ogDescription.setAttribute('content', currentSpec.description);
    }
    
    if (elements.interviewTitleElement) {
        elements.interviewTitleElement.textContent = currentSpec.title || currentSpec.indexHeader || 'Say Interviews';
    }
    
    // Check if we're going to auto-start (urlParams will be declared later)
    const searchParams = new URLSearchParams(window.location.search);
    const hasName = searchParams.has('name');
    const hasEmail = searchParams.has('email');
    const hasVideo = searchParams.has('video');
    const hasLink = searchParams.has('link');
    const hasContextStringId = searchParams.has('contextStringId');
    const willAutoStart = hasName && hasEmail && hasVideo && 
                         (currentSpec.hasExternalDocuments === false || hasLink || hasContextStringId);
    
    // Hide initial calling screen (always do this regardless of auto-start)
    const initialCallingScreen = document.getElementById('initialCallingScreen');
    if (initialCallingScreen) {
        setTimeout(() => {
            initialCallingScreen.style.opacity = '0';
            initialCallingScreen.style.transition = 'opacity 0.5s ease';
            setTimeout(() => {
                initialCallingScreen.remove();
            }, 500);
        }, 1500); // Show calling screen for at least 1.5 seconds
    }
    
    // Only update UI if we're NOT auto-starting
    if (!willAutoStart) {
        // Update intro text with title and description from spec
        if (elements.introTextHeadingElem && typeof currentSpec.title === 'string' && currentSpec.title.trim() !== '') {
            elements.introTextHeadingElem.textContent = currentSpec.title;
        }
        
        if (elements.introTextSubheadingElem && typeof currentSpec.description === 'string') {
            elements.introTextSubheadingElem.innerHTML = currentSpec.description;
        }
        
        // Show form fields
        const formFieldsContainer = document.getElementById('formFieldsContainer');
        if (formFieldsContainer) {
            formFieldsContainer.classList.remove('hidden');
        }
        // Don't show start button on step 1 - it will be shown after step 2
    }
    
    // Set document requirement
    state.interview.requiresDocument = currentSpec.hasExternalDocuments !== undefined ? 
        currentSpec.hasExternalDocuments : true;
    console.log("'requiresDocument' determined as:", state.interview.requiresDocument);
    updateUploaderVisibility();
    
    // Handle admin URL parameters for auto-fill
    const urlParams = new URLSearchParams(window.location.search);
    const adminEmail = urlParams.get('adminEmail');
    const adminName = urlParams.get('adminName');
    const userEmail = urlParams.get('email');
    const userName = urlParams.get('name');
    const videoParam = urlParams.get('video');
    const linkParam = urlParams.get('link');
    const contextStringId = urlParams.get('contextStringId');
    const firstQuestionParam = urlParams.get('firstQuestion');
    
    // Handle email parameter (prioritize regular email param over adminEmail)
    if (userEmail && elements.userEmailInput) {
        elements.userEmailInput.value = decodeURIComponent(userEmail);
        console.log("Pre-filled email:", elements.userEmailInput.value);
        // Update form state
        const emailVal = elements.userEmailInput.value.trim();
        state.form.isEmailFilled = emailVal !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal);
    } else if (adminEmail && elements.userEmailInput) {
        elements.userEmailInput.value = decodeURIComponent(adminEmail);
        console.log("Pre-filled admin email:", elements.userEmailInput.value);
        // Update form state
        const emailVal = elements.userEmailInput.value.trim();
        state.form.isEmailFilled = emailVal !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal);
    }
    
    // Handle name parameter (prioritize regular name param over adminName)
    if (userName && elements.userNameInput) {
        elements.userNameInput.value = decodeURIComponent(userName);
        console.log("Pre-filled name:", elements.userNameInput.value);
        // Update form state
        state.form.isNameFilled = elements.userNameInput.value.trim() !== '';
    } else if (adminName && elements.userNameInput) {
        elements.userNameInput.value = decodeURIComponent(adminName);
        console.log("Pre-filled admin name:", elements.userNameInput.value);
        // Update form state
        state.form.isNameFilled = elements.userNameInput.value.trim() !== '';
    }
    
    // Handle video parameter
    if (videoParam !== null && elements.enableVideoRecording) {
        elements.enableVideoRecording.checked = videoParam === 'true';
        console.log("Pre-set video recording:", elements.enableVideoRecording.checked);
    }
    
    // Store custom first question if provided
    if (firstQuestionParam) {
        state.customFirstQuestion = decodeURIComponent(firstQuestionParam);
        console.log("Custom first question set:", state.customFirstQuestion);
    }
    
    // Auto-navigate to step 2 if name and email are provided
    if ((userName || adminName) && (userEmail || adminEmail) && !willAutoStart) {
        console.log("Name and email provided in URL - auto-navigating to step 2");
        
        // Get the step containers
        const step1Container = document.getElementById('step1Container');
        const step2Container = document.getElementById('step2Container');
        const formFieldsContainer = document.getElementById('formFieldsContainer');
        
        if (step1Container && step2Container && formFieldsContainer) {
            // Show form fields container first
            formFieldsContainer.classList.remove('hidden');
            
            // Small delay to ensure DOM is ready
            setTimeout(() => {
                // Hide step 1, show step 2
                step1Container.classList.add('hidden');
                step2Container.classList.remove('hidden');
                
                // Hide the description and admin info
                const introTextSubheading = document.getElementById('introTextSubheading');
                if (introTextSubheading) {
                    introTextSubheading.classList.add('hidden');
                }
                const adminInfo = document.getElementById('adminInfo');
                if (adminInfo) {
                    adminInfo.classList.add('hidden');
                }
                
                // Show back button container
                const backButtonContainer = document.getElementById('backButtonContainer');
                if (backButtonContainer) {
                    backButtonContainer.classList.remove('hidden');
                }
                
                // Show upload section
                const uploadSection = document.getElementById('uploadSection');
                if (uploadSection) {
                    uploadSection.classList.remove('hidden');
                }
                
                // Show start button if context is optional or already provided
                if (!state.interview.requiresDocument || state.form.fileUploaded) {
                    if (elements.startButtonContainer) {
                        elements.startButtonContainer.classList.remove('hidden');
                    }
                    
                    // Also show video toggle
                    const videoToggleSection = document.getElementById('videoToggleSection');
                    if (videoToggleSection) {
                        videoToggleSection.classList.remove('hidden');
                    }
                    
                    // Call checkFormCompletion to ensure button state is correct
                    checkFormCompletion();
                }
            }, 100);
        }
    }

    checkFormCompletion();

    const redirectBtn = document.getElementById('completionRedirectBtn');
    if (redirectBtn) {
        redirectBtn.onclick = () => {
            window.location.href = currentSpec.completionRedirectUrl || '/';
        };
    }

    // If auto-starting, keep the loading state visible while we start
    if (willAutoStart) {
        console.log("Will auto-start - keeping loading state during initialization");
        // Small delay to ensure smooth transition
        setTimeout(() => {
            checkAutoStartConditions();
        }, 100);
    } else {
        // Not auto-starting, check conditions normally
        checkAutoStartConditions();
    }
    
    // Handle link parameter in parallel (non-blocking)
    if (linkParam) {
        console.log("Processing link parameter in background...");
        handleLinkParameter(linkParam).then(() => {
            console.log("Link processing completed successfully");
            // Update form completion status after link processing
            checkFormCompletion();
        }).catch(error => {
            console.error("Link processing failed:", error);
        });
    }
    
    // Handle contextStringId parameter in parallel (non-blocking)
    if (contextStringId) {
        console.log("Processing context string ID in background...");
        handleContextStringId(contextStringId).then(() => {
            console.log("Context string processing completed successfully");
            // Update form completion status after context processing
            checkFormCompletion();
        }).catch(error => {
            console.error("Context string processing failed:", error);
        });
    }
}

// Check and execute auto-start if all conditions are met
function checkAutoStartConditions() {
    // Get the current spec from state.interview.customData which is set when loading from Firestore
    const currentSpec = state.interview.customData || state.interview.spec || window.appState?.interviewSpec;
    
    // Get URL parameters to check if link or contextStringId is provided
    const urlParams = new URLSearchParams(window.location.search);
    const hasLinkParam = urlParams.has('link');
    const hasContextStringId = urlParams.has('contextStringId');
    
    // Check for admin auto-start conditions
    // If a link parameter or contextStringId is provided, we can auto-start even if the interview normally requires documents
    const canAutoStart = currentSpec && 
                        (currentSpec.hasExternalDocuments === false || hasLinkParam || hasContextStringId) && 
                        elements.startChatBtn && !elements.startChatBtn.disabled;
    
    if (canAutoStart) {
        console.log("Admin auto-start: All conditions met. Starting interview.");
        // Small delay to ensure everything is initialized
        setTimeout(() => {
            startInterview();
        }, 100);
    } else {
        console.log("Admin auto-start: Conditions not met. Waiting for user input.");
        if (!currentSpec) console.log("- No interview spec found in any location");
        if (currentSpec?.hasExternalDocuments !== false && !hasLinkParam) console.log("- Interview requires documents and no link provided");
        if (!elements.startChatBtn) console.log("- Start button not found");
        if (elements.startChatBtn?.disabled) console.log("- Start button is disabled");
    }
}

// Handle link parameter for file download or website scraping
async function handleLinkParameter(link) {
    const decodedLink = decodeURIComponent(link);
    console.log("Processing link parameter:", decodedLink);
    
    try {
        // Check if it's a valid URL
        const url = new URL(decodedLink);
        
        // Determine if it's likely a file or a webpage
        const fileExtensions = ['.pdf', '.doc', '.docx', '.txt', '.md', '.csv', '.json', '.xml', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
        const isLikelyFile = fileExtensions.some(ext => url.pathname.toLowerCase().endsWith(ext));
        
        if (isLikelyFile) {
            // Handle as file download
            console.log("Detected file URL, attempting to download...");
            await downloadAndProcessFile(decodedLink);
        } else {
            // Handle as website scraping
            console.log("Detected website URL, attempting to scrape...");
            await scrapeWebsiteFromUrl(decodedLink);
        }
    } catch (error) {
        console.error("Error processing link parameter:", error);
        // If URL parsing fails, try to determine type by content
        if (decodedLink.includes('.') && !decodedLink.includes('/')) {
            // Might be a file path
            console.log("Invalid URL but might be a file, attempting download...");
            await downloadAndProcessFile(decodedLink);
        }
    }
}

// Download file from URL and process it
async function downloadAndProcessFile(fileUrl) {
    try {
        // Show loading state - always show if we're processing a link
        if (elements.uploadSection) {
            elements.uploadSection.classList.remove('hidden');
        }
        
        // Import the context upload module
        const contextUploadModule = await import('./ui/context-upload.js');
        contextUploadModule.initializeContextUpload();
        
        // Show progress
        const uploadStatus = document.getElementById('uploadStatus');
        const uploadStatusText = document.getElementById('uploadStatusText');
        const uploadStatusIcon = document.getElementById('uploadStatusIcon');
        
        if (uploadStatus && uploadStatusText && uploadStatusIcon) {
            uploadStatus.classList.remove('hidden');
            uploadStatusText.textContent = 'Downloading file...';
            uploadStatusIcon.innerHTML = '<div class="spinner"></div>';
        }
        
        // Fetch the file
        const response = await fetch(fileUrl);
        if (!response.ok) {
            throw new Error(`Failed to download file: ${response.statusText}`);
        }
        
        // Get the filename from URL or content-disposition header
        let filename = 'downloaded-file';
        const contentDisposition = response.headers.get('content-disposition');
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i);
            if (filenameMatch) {
                filename = filenameMatch[1];
            }
        } else {
            // Extract from URL
            const urlPath = new URL(fileUrl).pathname;
            const pathSegments = urlPath.split('/');
            if (pathSegments.length > 0 && pathSegments[pathSegments.length - 1]) {
                filename = pathSegments[pathSegments.length - 1];
            }
        }
        
        // Create a blob and File object
        const blob = await response.blob();
        const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
        
        // Process the file using the existing upload handler
        const formData = new FormData();
        formData.append('file', file);
        
        uploadStatusText.textContent = 'Processing file...';
        
        const uploadResponse = await fetch('/api/universal/upload', {
            method: 'POST',
            body: formData
        });
        
        if (!uploadResponse.ok) {
            const error = await uploadResponse.json();
            throw new Error(error.error || 'Failed to process file');
        }
        
        const data = await uploadResponse.json();
        
        // Update state
        state.uploadedFile = data.file;
        if (data.extractedText) {
            state.form.resumeText = data.extractedText;
        } else if (data.file.isImage) {
            state.form.resumeText = `[Image: ${data.file.name}]`;
        }
        state.form.fileUploaded = true;
        
        // Show success
        if (uploadStatus) {
            uploadStatus.classList.add('hidden');
        }
        
        const uploadedFile = document.getElementById('uploadedFile');
        const fileNameEl = document.getElementById('fileName');
        const fileSizeEl = document.getElementById('fileSize');
        
        if (uploadedFile && fileNameEl && fileSizeEl) {
            fileNameEl.textContent = filename;
            fileSizeEl.textContent = formatFileSize(file.size);
            uploadedFile.classList.remove('hidden');
        }
        
        checkFormCompletion();
        
    } catch (error) {
        console.error('Error downloading and processing file:', error);
        
        const uploadStatus = document.getElementById('uploadStatus');
        const uploadStatusText = document.getElementById('uploadStatusText');
        const uploadStatusIcon = document.getElementById('uploadStatusIcon');
        
        if (uploadStatus && uploadStatusText && uploadStatusIcon) {
            uploadStatus.classList.remove('hidden');
            uploadStatusText.textContent = error.message || 'Failed to download file';
            uploadStatusIcon.innerHTML = `<svg class="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>`;
            uploadStatus.classList.add('error');
        }
    }
}

// Scrape website from URL parameter
async function scrapeWebsiteFromUrl(websiteUrl) {
    try {
        // Show loading state - always show if we're processing a link
        if (elements.uploadSection) {
            elements.uploadSection.classList.remove('hidden');
        }
        
        // Import the context upload module
        const contextUploadModule = await import('./ui/context-upload.js');
        contextUploadModule.initializeContextUpload();
        
        // Show progress
        const uploadStatus = document.getElementById('uploadStatus');
        const uploadStatusText = document.getElementById('uploadStatusText');
        const uploadStatusIcon = document.getElementById('uploadStatusIcon');
        
        if (uploadStatus && uploadStatusText && uploadStatusIcon) {
            uploadStatus.classList.remove('hidden');
            uploadStatusText.textContent = 'Scraping website...';
            uploadStatusIcon.innerHTML = '<div class="spinner"></div>';
        }
        
        // Get auth token if available
        let token = null;
        if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
            token = await firebase.auth().currentUser.getIdToken();
        }
        
        // Call the scraping API
        const response = await fetch('/api/scrape-website', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': token ? `Bearer ${token}` : ''
            },
            body: JSON.stringify({ url: websiteUrl, depth: 1 })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'Failed to scrape website');
        }
        
        const result = await response.json();
        
        // Update state
        state.form.resumeText = result.content;
        state.form.fileUploaded = true;
        state.uploadedFile = {
            name: new URL(websiteUrl).hostname + '_scraped.txt',
            size: result.content.length,
            type: 'text/plain'
        };
        
        // Show success
        if (uploadStatus) {
            uploadStatus.classList.add('hidden');
        }
        
        const uploadedFile = document.getElementById('uploadedFile');
        const fileNameEl = document.getElementById('fileName');
        const fileSizeEl = document.getElementById('fileSize');
        
        if (uploadedFile && fileNameEl && fileSizeEl) {
            fileNameEl.textContent = new URL(websiteUrl).hostname;
            fileSizeEl.textContent = formatFileSize(result.content.length);
            uploadedFile.classList.remove('hidden');
        }
        
        checkFormCompletion();
        
    } catch (error) {
        console.error('Error scraping website:', error);
        
        const uploadStatus = document.getElementById('uploadStatus');
        const uploadStatusText = document.getElementById('uploadStatusText');
        const uploadStatusIcon = document.getElementById('uploadStatusIcon');
        
        if (uploadStatus && uploadStatusText && uploadStatusIcon) {
            uploadStatus.classList.remove('hidden');
            uploadStatusText.textContent = error.message || 'Failed to scrape website';
            uploadStatusIcon.innerHTML = `<svg class="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>`;
            uploadStatus.classList.add('error');
        }
    }
}

// Handle context string ID parameter
async function handleContextStringId(contextStringId) {
    console.log("Fetching context string:", contextStringId);
    
    try {
        const response = await fetch(`/api/context-strings/${contextStringId}`);
        
        if (!response.ok) {
            throw new Error('Failed to fetch context string');
        }
        
        const data = await response.json();
        console.log("Context string fetched successfully");
        
        // Store the context content
        state.form.resumeText = data.content;
        state.form.hasDocument = true;
        
        // Update UI to show the context
        const uploadStatus = document.getElementById('uploadStatus');
        const uploadStatusText = document.getElementById('uploadStatusText');
        const uploadStatusIcon = document.getElementById('uploadStatusIcon');
        
        if (uploadStatus && uploadStatusText && uploadStatusIcon) {
            uploadStatus.classList.remove('hidden');
            
            // Show metadata if available
            const source = data.metadata?.source || 'Context';
            const company = data.metadata?.company || '';
            
            uploadStatusText.textContent = company ? 
                `${source} context loaded: ${company}` : 
                `${source} context loaded successfully`;
                
            uploadStatusIcon.innerHTML = `<svg class="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>`;
            uploadStatus.classList.remove('error');
        }
        
        // Update the paste textarea if it exists
        const pasteTextarea = document.getElementById('pasteTextarea');
        if (pasteTextarea) {
            pasteTextarea.value = data.content;
            pasteTextarea.classList.add('bg-green-50', 'dark:bg-green-900/20');
            pasteTextarea.classList.remove('bg-red-50', 'dark:bg-red-900/20');
        }
        
        // Update character count
        const charCount = document.getElementById('charCount');
        if (charCount) {
            charCount.textContent = `${data.content.length.toLocaleString()} characters`;
        }
        
    } catch (error) {
        console.error('Error fetching context string:', error);
        
        const uploadStatus = document.getElementById('uploadStatus');
        const uploadStatusText = document.getElementById('uploadStatusText');
        const uploadStatusIcon = document.getElementById('uploadStatusIcon');
        
        if (uploadStatus && uploadStatusText && uploadStatusIcon) {
            uploadStatus.classList.remove('hidden');
            uploadStatusText.textContent = 'Failed to load context';
            uploadStatusIcon.innerHTML = `<svg class="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>`;
            uploadStatus.classList.add('error');
        }
    }
}

// Format file size helper
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' bytes';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Handle session restoration on page load
function handleSessionRestoration() {
    const urlParams = new URLSearchParams(window.location.search);
    const preliminaryInterviewId = urlParams.get('interview');
    
    // Temporarily set interview ID for session key if needed
    const originalInterviewId = state.interview.id;
    if (!state.interview.id && preliminaryInterviewId) {
        state.interview.id = preliminaryInterviewId;
    }
    
    state.session.previousId = localStorage.getItem(getSessionStorageKey(state.interview.id));
    
    // Restore original interview ID
    state.interview.id = originalInterviewId;
    
    if (state.session.previousId) {
        console.log('Found previous session ID:', state.session.previousId);
        state.session.attemptingRejoin = true;
    }
}

// Check form completion and enable/disable start button
function checkFormCompletion() {
    // Re-check form state
    state.form.isNameFilled = elements.userNameInput && elements.userNameInput.value.trim() !== '';
    
    const emailVal = elements.userEmailInput ? elements.userEmailInput.value.trim() : '';
    state.form.isEmailFilled = emailVal !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal);
    
    if (elements.startChatBtn) {
        // Basic requirements are always name and email
        const basicRequirementsMet = state.form.isNameFilled && state.form.isEmailFilled;
        
        // Context is only required if requiresDocument is true
        const contextRequirementMet = !state.interview.requiresDocument || state.form.fileUploaded;
        
        const canStart = basicRequirementsMet && contextRequirementMet;
        
        // Check if we're on step 2
        const step2Container = document.getElementById('step2Container');
        const isOnStep2 = step2Container && !step2Container.classList.contains('hidden');
        
        // Debug logging
        console.log("checkFormCompletion - Form state:", {
            isNameFilled: state.form.isNameFilled,
            nameValue: elements.userNameInput?.value,
            isEmailFilled: state.form.isEmailFilled,
            emailValue: elements.userEmailInput?.value,
            fileUploaded: state.form.fileUploaded,
            requiresDocument: state.interview.requiresDocument,
            basicRequirementsMet: basicRequirementsMet,
            contextRequirementMet: contextRequirementMet,
            canStart: canStart,
            isOnStep2: isOnStep2,
            startButtonContainerVisible: elements.startButtonContainer && !elements.startButtonContainer.classList.contains('hidden')
        });
        
        if (canStart) {
            elements.startChatBtn.disabled = false;
            elements.startChatBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            elements.startChatBtn.classList.add('hover:bg-accent-primary-darker');
            
            // Show the start button on step 2 if conditions are met
            if (isOnStep2 && elements.startButtonContainer) {
                elements.startButtonContainer.classList.remove('hidden');
                console.log("checkFormCompletion - Showing start button on step 2");
                
                // Also show video toggle when start button is shown
                const videoToggleSection = document.getElementById('videoToggleSection');
                if (videoToggleSection) {
                    videoToggleSection.classList.remove('hidden');
                }
            }
        } else {
            elements.startChatBtn.disabled = true;
            elements.startChatBtn.classList.add('opacity-50', 'cursor-not-allowed');
            elements.startChatBtn.classList.remove('hover:bg-accent-primary-darker');
            
            // Hide start button if context is required but not provided
            if (isOnStep2 && elements.startButtonContainer && state.interview.requiresDocument && !state.form.fileUploaded) {
                elements.startButtonContainer.classList.add('hidden');
                console.log("checkFormCompletion - Hiding start button because context is required but not provided");
                
                // Also hide video toggle
                const videoToggleSection = document.getElementById('videoToggleSection');
                if (videoToggleSection) {
                    videoToggleSection.classList.add('hidden');
                }
            }
        }
    }
}

// Update uploader visibility based on document requirement
function updateUploaderVisibility() {
    // Context upload is always visible on step 2 - requiresDocument only controls if it's required
    // This function now only updates the form state based on existing content
    
    if (!state.interview.requiresDocument) {
        // If context is not required, we don't need to check for it
        // But we still track if something was uploaded
        state.form.fileUploaded = (state.form.resumeText && state.form.resumeText.trim() !== '');
    } else {
        // If context is required, check if we have content
        state.form.fileUploaded = (state.form.resumeText && state.form.resumeText.trim() !== '');
    }
    checkFormCompletion();
}

// Clean up function for page unload
function cleanup() {
    // Visualization cleanup removed - using thinking panel instead
    
    const thinkingCanvas = document.getElementById('thinkingCanvas');
    if (thinkingCanvas && thinkingCanvas.parentNode) {
        thinkingCanvas.parentNode.removeChild(thinkingCanvas);
    }
}

// Play individual audio clip
async function playAudioClip(audioId, element, button) {
    console.log('[playAudioClip] Attempting to play audio clip with ID:', audioId);
    try {
        // Show loading state if button exists
        if (button) {
            button.disabled = true;
            button.innerHTML = '<span class="loading-spinner"></span>';
        }
        
        // Fetch the audio URL and trimming info for this clip
        const response = await fetch(`/api/audio-clip/${audioId}?trimmed=true`);
        console.log('[playAudioClip] API response status:', response.status);
        if (!response.ok) {
            const errorData = await response.json();
            console.error('[playAudioClip] API error:', errorData);
            throw new Error('Failed to fetch audio clip');
        }
        
        const { audioUrl, trimmedUrl } = await response.json();
        console.log('[playAudioClip] Received URLs:', { audioUrl: audioUrl ? 'present' : 'missing', trimmedUrl: trimmedUrl ? 'present' : 'missing' });
        
        // Create or reuse audio element
        let audioElement = document.getElementById('clip-audio-player');
        if (!audioElement) {
            audioElement = document.createElement('audio');
            audioElement.id = 'clip-audio-player';
            audioElement.style.display = 'none';
            document.body.appendChild(audioElement);
        }
        
        // Stop any currently playing audio
        if (!audioElement.paused) {
            audioElement.pause();
            // Reset any other playing blockquotes
            document.querySelectorAll('.audio-quote.playing').forEach(el => {
                el.classList.remove('playing');
                const btn = el.querySelector('.audio-quote-play-btn');
                if (btn) {
                    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
                    btn.disabled = false;
                }
            });
            // Reset any playing citations
            document.querySelectorAll('.audio-citation.playing').forEach(el => {
                el.classList.remove('playing');
            });
        }
        
        // Add visual feedback
        element.classList.add('playing');
        if (button) {
            button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
        }
        
        // Set up audio element - use trimmed version if available
        audioElement.src = trimmedUrl || audioUrl;
        audioElement.onended = () => {
            element.classList.remove('playing');
            if (button) {
                button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
                button.disabled = false;
            }
        };
        
        audioElement.onerror = () => {
            element.classList.remove('playing');
            if (button) {
                button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
                button.disabled = false;
            }
            alert('Failed to play audio clip');
        };
        
        // Play the audio
        await audioElement.play();
        if (button) {
            button.disabled = false;
        }
        
    } catch (error) {
        console.error('Error playing audio clip:', error);
        if (button) {
            button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
            button.disabled = false;
        }
        alert('Failed to play audio clip');
    }
}

// Handle creating audio summary from analyst message
async function handleCreateAudioSummary(messageElement) {
    try {
        // Get the message content
        const messageContent = messageElement.querySelector('.message-content');
        if (!messageContent) {
            console.error('No message content found');
            return;
        }
        
        // Get the full message HTML content
        const fullContent = messageContent.innerHTML;
        
        // Show loading state
        const button = messageElement.querySelector('.create-audio-summary');
        const originalText = button.innerHTML;
        button.innerHTML = '<span class="loading-spinner"></span> Creating...';
        button.disabled = true;
        
        // Use the new analyst message audio endpoint
        const response = await fetch('/api/analyst/create-message-audio', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messageContent: fullContent,
                interviewId: appState.currentEditingInterviewId,
                threadId: appState.currentAnalystThreadId
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create audio summary');
        }
        
        const result = await response.json();
        
        // Show success and add link to the message
        button.innerHTML = originalText;
        button.disabled = false;
        
        // Add a link to the audio summary
        const audioLink = document.createElement('a');
        audioLink.href = result.audioUrl;
        audioLink.target = '_blank';
        audioLink.className = 'audio-summary-link';
        audioLink.innerHTML = '🎧 Listen to Audio Summary';
        messageElement.querySelector('.message-actions').appendChild(audioLink);
        
        // Show success message
        const successMsg = document.createElement('div');
        successMsg.className = 'success-message fade-in';
        successMsg.textContent = 'Audio created successfully!';
        messageElement.appendChild(successMsg);
        
        setTimeout(() => successMsg.remove(), 3000);
        
    } catch (error) {
        console.error('Error creating audio summary:', error);
        alert('Failed to create audio summary: ' + error.message);
        
        // Reset button state
        const button = messageElement.querySelector('.create-audio-summary');
        if (button) {
            button.innerHTML = button.innerHTML.replace('<span class="loading-spinner"></span> Creating...', 'Audio Summary');
            button.disabled = false;
        }
    }
}

// Handle creating video summary from analyst message
async function handleCreateVideoSummary(messageElement) {
    console.log('[handleCreateVideoSummary] Function called with messageElement:', messageElement);
    try {
        // Get the button and original text first
        const button = messageElement.querySelector('.create-video-summary');
        const originalText = button ? button.innerHTML : 'Video Summary';

        // Get the message content
        const messageContent = messageElement.querySelector('.message-content');
        console.log('[handleCreateVideoSummary] Message content element:', messageContent);
        if (!messageContent) {
            console.error('[handleCreateVideoSummary] No message content found');
            return;
        }

        // Check if message content is empty or only has the user's prompt
        const contentText = messageContent.textContent.trim();
        if (!contentText || contentText.length < 100) {
            console.error('[handleCreateVideoSummary] Message content is empty or too short:', contentText.length);
            alert('This message doesn\'t have any content to create a video from. Please try a different message.');
            if (button) {
                button.innerHTML = originalText;
                button.disabled = false;
            }
            return;
        }

        // Check if audio clips are properly rendered with data-audio-id
        const audioQuotes = messageContent.querySelectorAll('blockquote.audio-quote[data-audio-id]');
        const plainBlockquotes = messageContent.querySelectorAll('blockquote:not([data-audio-id])');
        const citations = messageContent.querySelectorAll('.audio-citation[data-audio-id]');

        console.log('[handleCreateVideoSummary] Audio quotes with IDs:', audioQuotes.length);
        console.log('[handleCreateVideoSummary] Plain blockquotes without IDs:', plainBlockquotes.length);
        console.log('[handleCreateVideoSummary] Citations with IDs:', citations.length);

        // Check if we have NO audio references at all
        if (audioQuotes.length === 0 && citations.length === 0) {
            console.error('[handleCreateVideoSummary] No audio quotes or citations found in message');
            alert('This message doesn\'t contain any audio clips or citations. Please select a message from the AI with audio references.');
            if (button) {
                button.innerHTML = originalText;
                button.disabled = false;
            }
            return;
        }

        if (plainBlockquotes.length > 0 && audioQuotes.length === 0 && citations.length === 0) {
            console.warn('[handleCreateVideoSummary] Found blockquotes without data-audio-id attributes');
            alert('Audio clips are still loading. Please wait a moment and try again, or refresh the page first.');
            if (button) {
                button.innerHTML = originalText;
                button.disabled = false;
            }
            return;
        }

        // Get the full message HTML content
        const fullContent = messageContent.innerHTML;
        console.log('[handleCreateVideoSummary] Full HTML content being sent:', fullContent);

        // Show loading state
        button.innerHTML = '<span class="loading-spinner"></span> Creating...';
        button.disabled = true;
        
        // Get the current user ID - check multiple sources
        const userId = auth.currentUser?.uid || window.currentUserId || appState.userId;
        
        if (!userId) {
            console.error('No user ID available');
            button.innerHTML = originalText;
            button.disabled = false;
            alert('Please sign in to create video summaries');
            return;
        }
        
        // Show b-roll prompt review modal (check if function exists)
        let brollPrompts = [];
        if (window.showBrollPromptReview) {
            brollPrompts = await window.showBrollPromptReview(fullContent, messageElement, button, originalText);
            
            if (!brollPrompts) {
                // User cancelled
                button.innerHTML = originalText;
                button.disabled = false;
                return;
            }
        }
        
        // Use the new analyst message video endpoint
        const response = await fetch('/api/analyst/create-message-video', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messageContent: fullContent,
                brollPrompts: brollPrompts,
                interviewId: appState.currentEditingInterviewId,
                threadId: appState.currentAnalystThreadId,
                userId: userId
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create video summary');
        }
        
        const result = await response.json();
        
        // Reset button state
        button.innerHTML = originalText;
        button.disabled = false;
        
        // Check if video was queued or completed
        if (result.status === 'queued' || result.status === 'processing') {
            // Show processing message
            const processingMsg = document.createElement('div');
            processingMsg.className = 'info-message fade-in';
            processingMsg.innerHTML = '🎬 Video generation started! Check the Content tab in a few minutes.';
            messageElement.appendChild(processingMsg);
            
            setTimeout(() => processingMsg.remove(), 5000);
            
            // Remove the button and show processing status
            button.style.display = 'none';
            const statusSpan = document.createElement('span');
            statusSpan.className = 'video-processing-status';
            statusSpan.innerHTML = '⏳ Video processing...';
            button.parentElement.appendChild(statusSpan);
        } else if (result.status === 'completed' && result.message === 'Video already exists') {
            // Video already exists
            const existingMsg = document.createElement('div');
            existingMsg.className = 'info-message fade-in';
            existingMsg.innerHTML = '✅ Video already created! Check the Content tab.';
            messageElement.appendChild(existingMsg);
            
            setTimeout(() => existingMsg.remove(), 5000);
            
            // Update button to show completed state
            button.innerHTML = '✅ Video ready';
            button.disabled = true;
            
            // Refresh content tab if it's active
            if (window.isContentTabActive && window.isContentTabActive()) {
                if (window.fetchAndDisplayContent) {
                    window.fetchAndDisplayContent(appState.currentEditingInterviewId);
                }
            }
            
        } else if (result.videoUrl) {
            // Video was generated synchronously (old behavior)
            // Add a link to the video summary
            const videoLink = document.createElement('a');
            videoLink.href = result.videoUrl;
            videoLink.target = '_blank';
            videoLink.className = 'video-summary-link';
            videoLink.innerHTML = '🎬 Watch Video Summary';
            messageElement.querySelector('.message-actions').appendChild(videoLink);
            
            // Show success message
            const successMsg = document.createElement('div');
            successMsg.className = 'success-message fade-in';
            successMsg.textContent = 'Video created successfully!';
            messageElement.appendChild(successMsg);
            
            setTimeout(() => successMsg.remove(), 3000);
        }
        
    } catch (error) {
        console.error('Error creating video summary:', error);
        alert('Failed to create video summary: ' + error.message);
        
        // Reset button state
        const button = messageElement.querySelector('.create-video-summary');
        if (button) {
            button.innerHTML = button.innerHTML.replace('<span class="loading-spinner"></span> Creating...', 'Video Summary');
            button.disabled = false;
        }
    }
}

// Add performance summary to global scope for debugging
window.logPerformanceSummary = () => logPerformanceSummary(state);

// Add main functions to global scope for debugging and compatibility
window.toggleRecording = toggleRecording;
window.togglePause = togglePause;
window.startInterview = startInterview;
window.setupMicrophone = setupMicrophone;
window.checkFormCompletion = checkFormCompletion;
window.updateUploaderVisibility = updateUploaderVisibility;
window.handleCreateAudioSummary = handleCreateAudioSummary;

// Story-mode exit: ends interview immediately, bypassing the minimum-time gate
window.storyEndInterview = function () {
    const wasRecording = state.recording.isRecording;
    // Stop active recording first so the last answer is submitted
    if (wasRecording && elements.recordBtn && !elements.recordBtn.disabled) {
        elements.recordBtn.click();
    }
    const doEnd = function () {
        if (state.socket && state.socket.instance) {
            state.socket.instance.emit('stopInterview');
        }
        if (elements.recordBtn) elements.recordBtn.disabled = true;
        const genBtn = document.getElementById('generateReportBtn');
        if (genBtn) { genBtn.disabled = true; genBtn.classList.remove('hidden'); }
    };
    // Give the recording 600 ms to finish submitting before signalling end
    if (wasRecording) {
        setTimeout(doEnd, 600);
    } else {
        doEnd();
    }
};

// Set up page unload handler
window.addEventListener('beforeunload', cleanup);

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', initializeApp);

// Listen for video generation completion events
if (window.socket) {
    window.socket.on('reportVideoGenerationSuccess', (data) => {
        console.log('[main] Video generation completed:', data);
        
        // Update the processing status in analyst messages
        const processingButtons = document.querySelectorAll('.video-processing-status');
        processingButtons.forEach(status => {
            // Replace with completed message
            status.innerHTML = '✅ Video ready';
            status.className = 'video-completed-status text-green-400';
        });
    });
    
    window.socket.on('reportVideoGenerationError', (data) => {
        console.error('[main] Video generation failed:', data);
        
        // Update the processing status to show error
        const processingButtons = document.querySelectorAll('.video-processing-status');
        processingButtons.forEach(status => {
            status.innerHTML = '❌ Video failed';
            status.className = 'video-failed-status text-red-400';
        });
    });
}

// Export main functions for potential external use
export { initializeApp, checkFormCompletion, updateUploaderVisibility }; 