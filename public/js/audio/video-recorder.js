// Video recorder module - handles webcam recording functionality
import { state, resetVideoState } from '../state.js';
import { elements } from '../dom.js';
const showError = window.showError;
const showInfo = window.showInfo;

// Initialize video stream and preview
export async function setupVideoStream() {
    try {
        console.log('Setting up video stream...');
        console.log('Video enabled state:', state.video.isEnabled);
        
        // Check if video is enabled by user preference
        if (!state.video.isEnabled) {
            console.log('Video recording disabled by user preference');
            return false;
        }
        
        // Check if browser supports video recording
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            console.warn('Video recording not supported in this browser');
            return false;
        }
        
        // Detect mobile device
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
        
        console.log('Device detection:', { isMobile, isIOS, userAgent: navigator.userAgent });
        
        // Story mode requests portrait 9:16 constraints natively.
        // Desktop webcams that can't deliver portrait will be center-cropped server-side (M5).
        const isStoryMode = document.documentElement.classList.contains('story-mode');

        const constraints = {
            video: isStoryMode ? {
                width: { ideal: 1080, min: 480 },
                height: { ideal: 1920, min: 720 },
                frameRate: { ideal: 30, min: 15 },
                facingMode: 'user',
                aspectRatio: { ideal: 9 / 16 }
            } : isMobile ? {
                width: { ideal: 1280, min: 480 },
                height: { ideal: 720, min: 360 },
                frameRate: { ideal: 30, min: 15 },
                facingMode: 'user'
            } : {
                width: { ideal: 1920, min: 1280 },
                height: { ideal: 1080, min: 720 },
                frameRate: { ideal: 30, min: 24 },
                facingMode: 'user'
            },
            audio: false // We already have audio from the main recorder
        };
        
        console.log('Using video constraints:', constraints);
        
        // Request video permission with adaptive settings
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        state.video.stream = stream;
        
        // Set up preview
        const videoPreview = document.getElementById('videoPreview');
        if (videoPreview) {
            videoPreview.srcObject = stream;
            state.video.previewElement = videoPreview;
            
            // Prevent video element from stealing focus
            videoPreview.setAttribute('tabindex', '-1');
            
            // Prevent mobile fullscreen behavior
            videoPreview.setAttribute('playsinline', 'true');
            videoPreview.setAttribute('webkit-playsinline', 'true');
            videoPreview.playsInline = true;
            
            // Prevent video element from capturing keyboard events
            videoPreview.addEventListener('keydown', (event) => {
                event.stopPropagation();
                // Re-dispatch the event to the document so our keyboard handler can catch it
                document.dispatchEvent(new KeyboardEvent('keydown', event));
            }, true);
            
            // Ensure video doesn't steal focus when it starts playing
            videoPreview.addEventListener('play', () => {
                // If the video stole focus, return it to the document body
                if (document.activeElement === videoPreview) {
                    document.body.focus();
                }
            });
        }
        
        // Show video preview container
        const container = document.getElementById('videoPreviewContainer');
        if (container) {
            container.classList.remove('hidden');
            // Add class to body for video-specific styling
            document.body.classList.add('video-enabled');
        }
        
        // Set up MediaRecorder for video with balanced quality/size
        const mimeType = getVideoMimeType(isMobile);
        
        // Use lower bitrate for mobile to ensure smooth recording
        const videoBitrate = isMobile ? 1500000 : 3500000; // 1.5 Mbps mobile, 3.5 Mbps desktop
        
        const options = {
            mimeType,
            videoBitsPerSecond: videoBitrate,
            audioBitsPerSecond: 128000   // 128 kbps for audio (if included)
        };
        
        console.log('MediaRecorder options:', options);
        
        state.video.mediaRecorder = new MediaRecorder(stream, options);
        state.video.chunks = [];
        
        state.video.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                state.video.chunks.push(event.data);
            }
        };
        
        state.video.mediaRecorder.onstop = () => {
            console.log('Video MediaRecorder stopped. Chunks:', state.video.chunks.length);
            
            if (state.video.chunks.length > 0) {
                const mimeType = state.video.chunks[0].type || getVideoMimeType();
                state.video.recordedBlob = new Blob(state.video.chunks, { type: mimeType });
                console.log(`Video blob created. Size: ${state.video.recordedBlob.size}, Type: ${state.video.recordedBlob.type}`);
            } else {
                state.video.recordedBlob = null;
            }
        };
        
        state.video.isEnabled = true;
        console.log('Video recording setup complete');
        return true;
        
    } catch (error) {
        console.error('Error setting up video:', error);
        
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            if (isMobile) {
                showInfo('Camera access denied. Please check your browser settings and reload the page to enable video.');
            } else {
                showInfo('Camera access denied. You can still use voice-only interviews.');
            }
        } else if (error.name === 'NotFoundError') {
            showInfo('No camera found. You can still use voice-only interviews.');
        } else if (error.name === 'OverconstrainedError' || error.constraint) {
            // This often happens on mobile when constraints are too strict
            console.warn('Video constraints too strict, trying with basic constraints...');
            
            try {
                // Try again with minimal constraints
                const basicStream = await navigator.mediaDevices.getUserMedia({ 
                    video: true,
                    audio: false 
                });
                
                state.video.stream = basicStream;
                
                // Continue with the rest of the setup
                const videoPreview = document.getElementById('videoPreview');
                if (videoPreview) {
                    videoPreview.srcObject = basicStream;
                    state.video.previewElement = videoPreview;
                    videoPreview.setAttribute('tabindex', '-1');
                }
                
                const container = document.getElementById('videoPreviewContainer');
                if (container) {
                    container.classList.remove('hidden');
                    // Add class to body for video-specific styling
                    document.body.classList.add('video-enabled');
                }
                
                // Set up MediaRecorder with detected mobile settings
                const mimeType = getVideoMimeType(true);
                const options = {
                    mimeType,
                    videoBitsPerSecond: 1000000, // 1 Mbps for basic mobile
                };
                
                state.video.mediaRecorder = new MediaRecorder(basicStream, options);
                state.video.chunks = [];
                
                state.video.mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        state.video.chunks.push(event.data);
                    }
                };
                
                state.video.mediaRecorder.onstop = () => {
                    console.log('Video MediaRecorder stopped. Chunks:', state.video.chunks.length);
                    
                    if (state.video.chunks.length > 0) {
                        const mimeType = state.video.chunks[0].type || getVideoMimeType(true);
                        state.video.recordedBlob = new Blob(state.video.chunks, { type: mimeType });
                        console.log(`Video blob created. Size: ${state.video.recordedBlob.size}, Type: ${state.video.recordedBlob.type}`);
                    } else {
                        state.video.recordedBlob = null;
                    }
                };
                
                state.video.isEnabled = true;
                console.log('Video recording setup complete with basic constraints');
                showInfo('Video enabled with basic quality settings');
                return true;
                
            } catch (basicError) {
                console.error('Failed with basic constraints too:', basicError);
                showError('Camera setup failed. Please try refreshing the page.');
            }
        } else {
            showError('Camera setup failed: ' + error.message);
        }
        
        // Hide video preview if setup failed
        const container = document.getElementById('videoPreviewContainer');
        if (container) {
            container.classList.add('hidden');
        }
        
        return false;
    }
}

// Get supported video MIME type (prefer high quality codecs)
function getVideoMimeType(isMobile = false) {
    // Check if iOS specifically (needs MP4)
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    
    // iOS only supports MP4
    if (isIOS) {
        const iosTypes = [
            'video/mp4;codecs=h264',     // H.264 MP4 for iOS
            'video/mp4'                   // Generic MP4
        ];
        
        for (const type of iosTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
                console.log('Using video MIME type:', type);
                return type;
            }
        }
    }
    
    // Mobile browsers often have limited codec support
    const types = isMobile ? [
        'video/webm;codecs=vp8',        // VP8 is widely supported on mobile
        'video/webm',                    // Generic WebM
        'video/mp4;codecs=h264',         // H.264 MP4 for iOS
        'video/mp4',                     // Generic MP4
        'video/webm;codecs=vp9',         // VP9 if supported
        'video/webm;codecs=h264'         // H.264 in WebM container
    ] : [
        'video/webm;codecs=vp9,opus',    // Best quality with VP9 video and Opus audio
        'video/webm;codecs=vp9',         // VP9 video only
        'video/webm;codecs=h264,opus',   // H.264 with Opus audio
        'video/webm;codecs=h264',        // H.264 video only
        'video/webm;codecs=vp8,opus',    // VP8 with Opus audio
        'video/webm;codecs=vp8',         // VP8 video only
        'video/webm',                     // Generic WebM
        'video/mp4'                       // MP4 fallback
    ];
    
    for (const type of types) {
        if (MediaRecorder.isTypeSupported(type)) {
            console.log('Using video MIME type:', type);
            return type;
        }
    }
    
    console.warn('No supported video MIME type found, using default');
    return 'video/webm';
}

// Start video recording (synchronized with audio)
export function startVideoRecording() {
    if (!state.video.isEnabled || !state.video.mediaRecorder) {
        return;
    }
    
    try {
        state.video.chunks = [];
        state.video.mediaRecorder.start(1000); // Collect data every second
        console.log('Video recording started');
    } catch (error) {
        console.error('Error starting video recording:', error);
        state.video.isEnabled = false;
    }
}

// Stop video recording
export function stopVideoRecording() {
    if (!state.video.isEnabled || !state.video.mediaRecorder) {
        return;
    }
    
    try {
        if (state.video.mediaRecorder.state === 'recording' || state.video.mediaRecorder.state === 'paused') {
            state.video.mediaRecorder.stop();
            console.log('Video recording stopped');
        }
    } catch (error) {
        console.error('Error stopping video recording:', error);
    }
}

// Pause video recording
export function pauseVideoRecording() {
    if (!state.video.isEnabled || !state.video.mediaRecorder || state.video.mediaRecorder.state !== 'recording') {
        return;
    }
    
    try {
        state.video.mediaRecorder.pause();
        console.log('Video recording paused');
    } catch (error) {
        console.error('Error pausing video recording:', error);
    }
}

// Resume video recording
export function resumeVideoRecording() {
    if (!state.video.isEnabled || !state.video.mediaRecorder || state.video.mediaRecorder.state !== 'paused') {
        return;
    }
    
    try {
        state.video.mediaRecorder.resume();
        console.log('Video recording resumed');
    } catch (error) {
        console.error('Error resuming video recording:', error);
    }
}

// Toggle video on/off
export function toggleVideo() {
    const toggleBtn = document.getElementById('toggleVideoBtn');
    const container = document.getElementById('videoPreviewContainer');
    
    if (state.video.isEnabled && state.video.stream) {
        // Turn off video
        state.video.stream.getTracks().forEach(track => track.stop());
        state.video.stream = null;
        state.video.mediaRecorder = null;
        state.video.isEnabled = false;
        
        if (container) {
            container.classList.add('hidden');
        }
        
        // Remove video-enabled class from body
        document.body.classList.remove('video-enabled');
        
        if (toggleBtn) {
            toggleBtn.classList.add('video-off');
            toggleBtn.title = 'Turn On Video';
        }
        
        console.log('Video disabled');
    } else {
        // Turn on video
        setupVideoStream().then(success => {
            if (success && toggleBtn) {
                toggleBtn.classList.remove('video-off');
                toggleBtn.title = 'Turn Off Video';
            }
        });
    }
}

// Clean up video resources
export function cleanupVideo() {
    if (state.video.stream) {
        state.video.stream.getTracks().forEach(track => track.stop());
        state.video.stream = null;
    }
    
    if (state.video.previewElement) {
        state.video.previewElement.srcObject = null;
    }
    
    state.video.mediaRecorder = null;
    state.video.isEnabled = false;
    resetVideoState();
    
    const container = document.getElementById('videoPreviewContainer');
    if (container) {
        container.classList.add('hidden');
    }
    
    // Remove video-enabled class from body
    document.body.classList.remove('video-enabled');
    
    console.log('Video resources cleaned up');
}

// Get video blob for upload
export function getVideoBlob() {
    return state.video.recordedBlob;
}

// Check if video is available
export function isVideoAvailable() {
    return state.video.isEnabled && state.video.recordedBlob && state.video.recordedBlob.size > 0;
}