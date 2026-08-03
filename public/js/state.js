// State management module - contains all global state variables for the interview interface

export const state = {
    // Socket connection state
    socket: {
        connected: false,
        retryCount: 0,
        instance: null,
        heartbeatInterval: null
    },
    
    // Interview state
    interview: {
        inProgress: false,
        startTime: null,
        id: null,
        customData: null,
        spec: null,
        requiresDocument: true
    },
    
    // Recording state
    recording: {
        isRecording: false,
        isPaused: false,
        duration: 0,
        accumulatedTime: 0,
        currentAnswerDuration: 0,
        startTime: null,
        timer: null,
        progressTimer: null,
        targetDurationSeconds: 300,
        timeLimitExtended: false
    },
    
    // Audio state
    audio: {
        mediaRecorder: null,
        stream: null,
        chunks: [],
        recordedBlob: null,
        pendingData: null
    },
    
    // Video state
    video: {
        stream: null,
        mediaRecorder: null,
        chunks: [],
        recordedBlob: null,
        isEnabled: false,
        previewElement: null
    },
    
    // Media Source Extensions state
    mse: {
        mediaSource: null,
        sourceBuffer: null,
        queue: [],
        element: new Audio(),
        isSourceBufferReady: false,
        currentStreamId: null
    },
    
    // Deepgram state
    deepgram: {
        streamActive: false,
        interimTranscriptDisplay: null,
        accumulatedTranscript: '',  // Track all transcripts received during recording
        transcribedWordCount: 0     // Track number of words transcribed
    },
    
    // UI state
    ui: {
        thinking: false,
        currentThinkingTrace: '',
        currentStreamedResponse: '',
        isStreamingResponse: false,
        typewriterTimeout: null,
        thinkingTimeout: null,
        questionCount: 0,
        hideInterviewNotes: false, // Remember if user dismissed interview notes
        minimizeInterviewNotes: false, // Remember if user minimized interview notes
        thinkingCharacterHistory: [], // Track actual character counts from previous thinking sessions
        averageThinkingChars: 4096 // Start with assumption of 1024 tokens * 4 chars/token
    },
    
    // Form state
    form: {
        resumeText: '',
        fileUploaded: false,
        isNameFilled: false,
        isEmailFilled: false
    },
    
    // Session state
    session: {
        previousId: null,
        attemptingRejoin: false,
        hasAttemptedRestore: false
    },
    
    // Timing state (for performance tracking)
    timing: {
        questionStartTime: null,
        transcriptionStartTime: null
    }
};

// Helper functions to update state
export function setCustomInterviewData(value) {
    if (value) {
        // Ensure the interview data has an ID
        const interviewId = value.id || state.interview.id;
        if (interviewId) {
            value.id = interviewId;
        }
        console.log("customInterviewData being set to:", `object with ID ${value.id || 'undefined'} and title "${value.title || 'untitled'}"`);
        
        // Set video enabled flag from interview configuration
        if (value.enableVideoRecording !== undefined) {
            state.video.isEnabled = value.enableVideoRecording;
            console.log("Video recording enabled:", state.video.isEnabled);
        }
    } else {
        console.log("customInterviewData being set to: null");
    }
    
    state.interview.customData = value;
}

export function resetRecordingState() {
    state.recording.isRecording = false;
    state.recording.isPaused = false;
    state.recording.duration = 0;
    state.recording.currentAnswerDuration = 0;
    
    if (state.recording.timer) {
        clearInterval(state.recording.timer);
        state.recording.timer = null;
    }
    
    if (state.recording.progressTimer) {
        clearInterval(state.recording.progressTimer);
        state.recording.progressTimer = null;
    }
}

export function resetAudioState() {
    state.audio.chunks = [];
    state.audio.recordedBlob = null;
}

export function resetVideoState() {
    // Don't clear chunks here - they are managed by the video recorder
    // Chunks should only be cleared when starting a new recording
    state.video.recordedBlob = null;
}

export function resetDeepgramState() {
    state.deepgram.streamActive = false;
    state.deepgram.interimTranscriptDisplay = null;
    state.deepgram.accumulatedTranscript = '';
    state.deepgram.transcribedWordCount = 0;
} 