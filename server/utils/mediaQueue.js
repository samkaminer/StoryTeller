const Queue = require('better-queue');
const ffmpeg = require('fluent-ffmpeg');
const { Storage } = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs').promises;

// These will be injected from the main server
let admin, db, storage, bucket, openai, generateAndStoreReportVideo, generateVideoThumbnail;

// Initialize function to be called from server.js
function initialize(firebaseAdmin, googleStorage, bucketName, openaiClient, videoModule) {
  admin = firebaseAdmin;
  db = admin.firestore();
  storage = googleStorage;
  bucket = storage.bucket(bucketName);
  openai = openaiClient;
  generateAndStoreReportVideo = videoModule?.generateAndStoreReportVideo;
  generateVideoThumbnail = videoModule?.generateVideoThumbnail;

  console.log(`[MediaQueue] Initialized with:`);
  console.log(`[MediaQueue] - Bucket name: ${bucketName}`);
  console.log(`[MediaQueue] - Storage project: ${storage.projectId}`);
  console.log(`[MediaQueue] - Bucket exists: ${bucket ? 'yes' : 'no'}`);
  console.log(`[MediaQueue] - OpenAI client: ${openai ? 'yes' : 'no'}`);
  console.log(`[MediaQueue] - Video module: ${generateAndStoreReportVideo ? 'yes' : 'no'}`);
  
  // Test bucket access
  bucket.exists()
    .then(([exists]) => {
      console.log(`[MediaQueue] Bucket accessibility check: ${exists ? 'accessible' : 'not accessible'}`);
    })
    .catch(err => {
      console.error(`[MediaQueue] Bucket accessibility check failed:`, err.message);
    });
}

// Create a queue with concurrency limit to prevent overwhelming the system
const mediaQueue = new Queue(async function (task, cb) {
  const { audioBuffer, videoBuffer, audioMimeType, responseDocId, reportId, socketId, storyId, isStoryFinalTelling } = task;
  
  console.log(`[MediaQueue] Processing media for response ${responseDocId}`);
  console.log(`[MediaQueue] Task details:`, {
    audioBufferSize: audioBuffer.length,
    videoBufferSize: videoBuffer.length,
    audioMimeType,
    reportId,
    responseDocId,
    socketId,
    bucketName: bucket ? bucket.name : 'NOT INITIALIZED',
    storageProject: storage ? storage.projectId : 'NOT INITIALIZED'
  });
  
  let audioPath, videoPath, convertedAudioPath, convertedVideoPath, thumbnailPath;
  
  try {
    // Check if storage is initialized
    if (!storage || !bucket) {
      throw new Error('Google Cloud Storage not initialized - check credentials configuration');
    }
    
    // Step 1: Write temporary files
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(7);
    
    // Determine file extensions based on mime type
    let audioExt = '.webm';
    let videoExt = '.webm';
    
    console.log(`[MediaQueue] Determining extensions - audioMimeType: "${audioMimeType}"`);
    
    if (audioMimeType) {
      if (audioMimeType.includes('mp4') || audioMimeType.includes('m4a')) {
        audioExt = '.m4a';
        console.log(`[MediaQueue] Using .m4a extension for audio`);
      } else if (audioMimeType.includes('wav')) {
        audioExt = '.wav';
        console.log(`[MediaQueue] Using .wav extension for audio`);
      } else if (audioMimeType.includes('mp3')) {
        audioExt = '.mp3';
        console.log(`[MediaQueue] Using .mp3 extension for audio`);
      } else {
        console.log(`[MediaQueue] Using default .webm extension for audio`);
      }
    }
    
    audioPath = `/tmp/temp_audio_${timestamp}_${randomStr}${audioExt}`;
    videoPath = `/tmp/temp_video_${timestamp}_${randomStr}${videoExt}`;
    
    await fs.writeFile(audioPath, audioBuffer);
    if (videoBuffer && videoBuffer.length > 0) {
      await fs.writeFile(videoPath, videoBuffer);
    }
    
    console.log(`[MediaQueue] Temp files written:`, {
      audioPath,
      videoPath,
      audioExists: await fs.stat(audioPath).then(() => true).catch(() => false),
      videoExists: await fs.stat(videoPath).then(() => true).catch(() => false),
      audioSize: audioBuffer.length,
      videoSize: videoBuffer.length,
      audioMimeType
    });
    
    // Get media info for debugging
    let videoWidth = 0, videoHeight = 0;
    await new Promise((resolve) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          console.error(`[MediaQueue] ffprobe error:`, err);
        } else {
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          if (videoStream) {
            videoWidth = videoStream.width || 0;
            videoHeight = videoStream.height || 0;
          }
          console.log(`[MediaQueue] Video metadata:`, JSON.stringify({
            format: metadata.format.format_name,
            duration: metadata.format.duration,
            bitrate: metadata.format.bit_rate,
            streams: metadata.streams.map(s => ({
              codec_name: s.codec_name,
              codec_type: s.codec_type,
              width: s.width,
              height: s.height
            }))
          }, null, 2));
        }
        resolve();
      });
    });
    
    // Step 2: Convert audio to MP3
    convertedAudioPath = audioPath.replace(/\.(webm|m4a|wav|mp3)$/, '.mp3');
    
    // Skip conversion if already MP3
    if (audioPath.endsWith('.mp3')) {
      convertedAudioPath = audioPath;
      console.log(`[MediaQueue] Audio already in MP3 format, skipping conversion`);
    } else {
      await new Promise((resolve, reject) => {
        const ffmpegCommand = ffmpeg(audioPath);
        
        // Add input options for m4a files
        if (audioPath.endsWith('.m4a')) {
          ffmpegCommand.inputOptions(['-f', 'mp4']);
        }
        
        ffmpegCommand
          .outputOptions([
            '-acodec libmp3lame',
            '-ab 128k',
            '-ar 44100',
            '-ac 2',
            '-threads 0' // Use all available CPU threads
          ])
          .output(convertedAudioPath)
          .on('start', (commandLine) => {
            console.log(`[MediaQueue] Audio FFmpeg command: ${commandLine}`);
          })
          .on('end', resolve)
          .on('error', (err, stdout, stderr) => {
            console.error(`[MediaQueue] Audio conversion error:`, err);
            console.error(`[MediaQueue] FFmpeg stdout:`, stdout);
            console.error(`[MediaQueue] FFmpeg stderr:`, stderr);
            reject(err);
          })
          .on('stderr', (stderrLine) => {
            if (stderrLine.includes('error') || stderrLine.includes('Error')) {
              console.error(`[MediaQueue] Audio FFmpeg ERROR:`, stderrLine);
            }
          })
          .run();
      });
    }
    
    // Step 3 & 4: Handle video processing only if video exists
    if (videoBuffer && videoBuffer.length > 0) {
      // Step 3: Convert video (remove audio track)
      const tempVideoNoAudio = videoPath.replace(/\.[^.]+$/, '_no_audio.mp4');
      const isLandscape = isStoryFinalTelling && videoWidth > 0 && videoHeight > 0 && videoWidth > videoHeight;
      if (isLandscape) {
        console.log(`[MediaQueue] Story final telling: landscape detected (${videoWidth}x${videoHeight}), applying 9:16 center-crop`);
      }
      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(videoPath);
        const outputOpts = [
          '-an',
          '-c:v libx264',
          '-preset ultrafast',
          '-crf 28',
          '-threads 0'
        ];
        if (isLandscape) {
          cmd.videoFilters('crop=ih*9/16:ih:(iw-ih*9/16)/2:0');
        }
        cmd
          .outputOptions(outputOpts)
          .output(tempVideoNoAudio)
          .on('start', (commandLine) => {
            console.log(`[MediaQueue] Video FFmpeg command: ${commandLine}`);
          })
          .on('end', resolve)
          .on('error', (err, stdout, stderr) => {
            console.error(`[MediaQueue] Video conversion error:`, err);
            console.error(`[MediaQueue] FFmpeg stdout:`, stdout);
            console.error(`[MediaQueue] FFmpeg stderr:`, stderr);
            reject(err);
          })
          .on('stderr', (stderrLine) => {
            if (stderrLine.includes('error') || stderrLine.includes('Error')) {
              console.error(`[MediaQueue] Video FFmpeg ERROR:`, stderrLine);
            }
          })
          .run();
      });
      
      // Step 4: Mux audio and video
      convertedVideoPath = videoPath.replace(/\.[^.]+$/, '.mp4');
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(tempVideoNoAudio)
          .input(convertedAudioPath)
          .outputOptions(['-c:v copy', '-c:a aac', '-strict experimental'])
          .output(convertedVideoPath)
          .on('start', (commandLine) => {
            console.log(`[MediaQueue] Mux FFmpeg command: ${commandLine}`);
          })
          .on('end', resolve)
          .on('error', (err, stdout, stderr) => {
            console.error(`[MediaQueue] Muxing error:`, err);
            console.error(`[MediaQueue] FFmpeg stdout:`, stdout);
            console.error(`[MediaQueue] FFmpeg stderr:`, stderr);
            reject(err);
          })
          .on('stderr', (stderrLine) => {
            if (stderrLine.includes('error') || stderrLine.includes('Error')) {
              console.error(`[MediaQueue] Mux FFmpeg ERROR:`, stderrLine);
            }
          })
          .run();
      });
      
      // Clean up temp video file
      await fs.unlink(tempVideoNoAudio).catch(() => {});

      // Generate thumbnail for story final tellings
      if (isStoryFinalTelling && generateVideoThumbnail) {
        try {
          thumbnailPath = convertedVideoPath.replace(/\.mp4$/, '_thumb.jpg');
          await generateVideoThumbnail(convertedVideoPath, thumbnailPath, 2);
          console.log(`[MediaQueue] Thumbnail generated for story final telling`);
        } catch (thumbErr) {
          console.warn(`[MediaQueue] Thumbnail generation failed (non-fatal):`, thumbErr.message);
          thumbnailPath = null;
        }
      }
    } else {
      console.log(`[MediaQueue] No video data provided, processing audio only`);
    }
    
    // Step 5: Upload to GCS
    const audioDestination = `audio_answers_full/${reportId}/${responseDocId}.mp3`;
    const videoDestination = `video_answers/${reportId}/${responseDocId}.mp4`;
    
    console.log(`[MediaQueue] Starting GCS uploads:`);
    console.log(`[MediaQueue] - Audio: ${convertedAudioPath} -> ${audioDestination}`);
    console.log(`[MediaQueue] - Video: ${convertedVideoPath} -> ${videoDestination}`);
    console.log(`[MediaQueue] - Bucket: ${bucket.name}`);
    
    // Check if files exist before upload
    const audioFileStats = await fs.stat(convertedAudioPath);
    console.log(`[MediaQueue] Audio file size: ${audioFileStats.size} bytes`);
    
    let videoFileStats = null;
    if (convertedVideoPath) {
      try {
        videoFileStats = await fs.stat(convertedVideoPath);
        console.log(`[MediaQueue] Video file size: ${videoFileStats.size} bytes`);
      } catch (e) {
        console.log(`[MediaQueue] No video file to upload`);
      }
    }
    
    // Upload with detailed error handling
    let audioUpload, videoUpload;
    
    try {
      console.log(`[MediaQueue] Uploading audio file...`);
      console.log(`[MediaQueue] Bucket details:`, {
        name: bucket.name,
        id: bucket.id,
        baseUrl: bucket.baseUrl,
        metadata: bucket.metadata
      });
      
      audioUpload = await bucket.upload(convertedAudioPath, {
        destination: audioDestination,
        metadata: { contentType: 'audio/mpeg' },
        resumable: true,
        validation: 'crc32c'
      });
      console.log(`[MediaQueue] Audio upload successful`);
    } catch (audioError) {
      console.error(`[MediaQueue] Audio upload failed:`, audioError);
      console.error(`[MediaQueue] Audio error details:`, {
        code: audioError.code,
        statusCode: audioError.statusCode,
        errors: audioError.errors,
        message: audioError.message
      });
      throw new Error(`Audio upload failed: ${audioError.message}`);
    }
    
    // Only upload video if it exists
    if (videoFileStats) {
      try {
        console.log(`[MediaQueue] Uploading video file...`);
        videoUpload = await bucket.upload(convertedVideoPath, {
          destination: videoDestination,
          metadata: { contentType: 'video/mp4' },
          resumable: true,
          validation: 'crc32c'
        });
        console.log(`[MediaQueue] Video upload successful`);
      } catch (videoError) {
        console.error(`[MediaQueue] Video upload failed:`, videoError);
        console.error(`[MediaQueue] Video error details:`, {
          code: videoError.code,
          statusCode: videoError.statusCode,
        errors: videoError.errors,
        message: videoError.message
        });
        throw new Error(`Video upload failed: ${videoError.message}`);
      }
    }
    
    const audioUrl = `gs://${bucket.name}/${audioDestination}`;
    const videoUrl = videoFileStats ? `gs://${bucket.name}/${videoDestination}` : null;

    // Upload thumbnail if generated
    let thumbnailUrl = null;
    if (thumbnailPath) {
      try {
        const thumbnailStats = await fs.stat(thumbnailPath).catch(() => null);
        if (thumbnailStats) {
          const thumbnailDestination = `story_thumbnails/${reportId}/${responseDocId}.jpg`;
          await bucket.upload(thumbnailPath, {
            destination: thumbnailDestination,
            metadata: { contentType: 'image/jpeg' },
            resumable: false,
          });
          thumbnailUrl = `gs://${bucket.name}/${thumbnailDestination}`;
          console.log(`[MediaQueue] Thumbnail uploaded: ${thumbnailUrl}`);
        }
      } catch (thumbUploadErr) {
        console.warn(`[MediaQueue] Thumbnail upload failed (non-fatal):`, thumbUploadErr.message);
      }
    }

    // Step 6: Update Firestore
    const updateData = {
      audio_gcs_url: audioUrl,
      mediaProcessedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    if (videoUrl) {
      updateData.video_gcs_url = videoUrl;
    }
    
    await db.collection('reports').doc(reportId)
      .collection('responses').doc(responseDocId)
      .update(updateData);

    await db.collection('reports').doc(reportId).update({
      take_response_doc_id: responseDocId,
      take_audio_gcs_url: audioUrl,
      take_video_gcs_url: videoUrl || null,
      take_thumbnail_gcs_url: thumbnailUrl || null,
      take_media_processed_at: admin.firestore.FieldValue.serverTimestamp(),
      take_media_processing_error: null,
      take_media_processing_failed_at: null,
      take_media_status: videoUrl ? 'ready' : 'audio_ready',
    });

    // Update stories doc with final video and thumbnail for story final tellings
    if (isStoryFinalTelling && storyId && videoUrl && db) {
      try {
        const storyUpdate = { final_video_gcs: videoUrl };
        if (thumbnailUrl) storyUpdate.thumbnail_gcs = thumbnailUrl;
        await db.collection('stories').doc(storyId).update(storyUpdate);
        console.log(`[MediaQueue] Updated stories/${storyId} with final_video_gcs${thumbnailUrl ? ' and thumbnail_gcs' : ''}`);

        // Send story completion email (non-fatal)
        try {
          const EmailService = require('../services/email-service');
          const storySnap = await db.collection('stories').doc(storyId).get();
          const storyData = storySnap.data() || {};
          if (storyData.userEmail) {
            const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
            let thumbSignedUrl = null;
            if (thumbnailUrl) {
              try {
                const thumbPath = thumbnailUrl.replace(`gs://${bucket.name}/`, '');
                const [tUrl] = await bucket.file(thumbPath).getSignedUrl({
                  version: 'v4', action: 'read', expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
                });
                thumbSignedUrl = tUrl;
              } catch (_) {}
            }
            await EmailService.sendStoryComplete({
              to: storyData.userEmail,
              userName: storyData.userName || null,
              thumbnailUrl: thumbSignedUrl,
              watchUrl: `${baseUrl}/story-result.html?storyId=${encodeURIComponent(storyId)}`,
              archiveUrl: `${baseUrl}/story-archive.html`,
            });
            console.log(`[MediaQueue] Story completion email sent to ${storyData.userEmail}`);
          }
        } catch (emailErr) {
          console.warn(`[MediaQueue] Story completion email failed (non-fatal):`, emailErr.message);
        }
      } catch (storyErr) {
        console.warn(`[MediaQueue] Failed to update stories doc (non-fatal):`, storyErr.message);
      }
    }

    console.log(`[MediaQueue] Successfully processed media for ${responseDocId}`);
    
    // Emit success event if socket still connected
    if (global.io && socketId) {
      const socket = global.io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('audioVideoStorageSuccess', {
          responseDocId,
          audioUrl,
          videoUrl
        });
      }
    }
    
    // Cleanup temp files
    const filesToClean = [
      audioPath, convertedAudioPath
    ];
    
    if (videoBuffer && videoBuffer.length > 0) {
      filesToClean.push(videoPath, convertedVideoPath);
      if (thumbnailPath) filesToClean.push(thumbnailPath);
    }

    await Promise.all(
      filesToClean.map(file => fs.unlink(file).catch(() => {}))
    );
    
    cb(null, { success: true, audioUrl, videoUrl });
    
  } catch (error) {
    console.error(`[MediaQueue] Error processing media for ${responseDocId}:`, error);
    console.error(`[MediaQueue] Error details:`, {
      name: error.name,
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      stack: error.stack,
      errors: error.errors
    });
    
    // Update Firestore with error status
    try {
      await db.collection('reports').doc(reportId)
        .collection('responses').doc(responseDocId)
        .update({
          mediaProcessingError: error.message,
          mediaProcessingFailedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      await db.collection('reports').doc(reportId).update({
        take_response_doc_id: responseDocId,
        take_media_processing_error: error.message,
        take_media_processing_failed_at: admin.firestore.FieldValue.serverTimestamp(),
        take_media_status: 'failed',
      });
    } catch (dbError) {
      console.error('[MediaQueue] Failed to update error status:', dbError);
    }
    
    // Emit error event if socket still connected
    if (global.io && socketId) {
      const socket = global.io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('audioVideoStorageError', {
          responseDocId,
          error: error.message
        });
      }
    }
    
    // Cleanup any temp files
    const filesToClean = [
      audioPath, convertedAudioPath
    ].filter(Boolean);
    
    if (videoPath) filesToClean.push(videoPath);
    if (convertedVideoPath) filesToClean.push(convertedVideoPath);
    if (thumbnailPath) filesToClean.push(thumbnailPath);

    await Promise.all(
      filesToClean.map(file => fs.unlink(file).catch(() => {}))
    );
    
    cb(error);
  }
}, {
  concurrent: process.env.MEDIA_QUEUE_CONCURRENCY ? parseInt(process.env.MEDIA_QUEUE_CONCURRENCY) : 2, // Default to 2 for local dev
  maxRetries: 2,
  retryDelay: 5000,
  afterProcessDelay: 100,
  maxTimeout: 300000, // 5 minute timeout per task
  store: {
    type: 'memory',
    max: 1000
  },
  priority: function (task, cb) {
    // Prioritize tasks with smaller video files first for faster processing
    const priority = task.videoBuffer ? -task.videoBuffer.length : 0;
    cb(null, priority);
  }
});

// better-queue's getStats() exposes lifetime counters (total, average, successRate, peak),
// not live queue depth. Track waiting/in-progress ourselves via events.
const mediaQueueCounters = { waiting: 0, inProgress: 0, completed: 0, failed: 0 };
const MEDIA_QUEUE_CONCURRENCY = parseInt(process.env.MEDIA_QUEUE_CONCURRENCY) || 2;

mediaQueue.on('task_queued', (taskId, task) => {
  mediaQueueCounters.waiting++;
  console.log(`[MediaQueue] Task queued: ${task.responseDocId} | Waiting: ${mediaQueueCounters.waiting} | Processing: ${mediaQueueCounters.inProgress}`);
});

mediaQueue.on('task_started', (taskId) => {
  mediaQueueCounters.waiting = Math.max(0, mediaQueueCounters.waiting - 1);
  mediaQueueCounters.inProgress++;
  console.log(`[MediaQueue] Task started: ${taskId} | Processing: ${mediaQueueCounters.inProgress}/${MEDIA_QUEUE_CONCURRENCY}`);
});

mediaQueue.on('task_finish', (taskId, result, stats) => {
  mediaQueueCounters.inProgress = Math.max(0, mediaQueueCounters.inProgress - 1);
  mediaQueueCounters.completed++;
  console.log(`[MediaQueue] Task completed: ${taskId} | Duration: ${stats.elapsed}ms | Waiting: ${mediaQueueCounters.waiting} | Processing: ${mediaQueueCounters.inProgress}`);
});

mediaQueue.on('task_failed', (taskId, error, stats) => {
  mediaQueueCounters.inProgress = Math.max(0, mediaQueueCounters.inProgress - 1);
  mediaQueueCounters.failed++;
  const retries = stats && stats.retries !== undefined ? stats.retries : '?';
  console.error(`[MediaQueue] Task failed: ${taskId} | Attempts: ${retries} | Error: ${error.message}`);
});

// Add queue health monitoring — warns on real backlog, not lifetime throughput
setInterval(() => {
  const depth = mediaQueueCounters.waiting + mediaQueueCounters.inProgress;
  if (depth > 10) {
    console.warn(`[MediaQueue] Queue backlog detected: ${mediaQueueCounters.waiting} waiting, ${mediaQueueCounters.inProgress} processing (${mediaQueueCounters.completed} completed, ${mediaQueueCounters.failed} failed since start)`);
  }
}, 30000); // Check every 30 seconds

// Create a separate queue for report video generation with longer timeout
const reportVideoQueue = new Queue(async function (task, cb) {
  const { reportId, videoContent, responsesWithTimestamps, brollPrompts, socketId, userId, threadId, interviewId } = task;
  let { contentId } = task; // Use let instead of const so we can reassign it later
  
  console.log(`[ReportVideoQueue] Processing report video for ${reportId}`);
  console.log(`[ReportVideoQueue] Task details:`, {
    reportId,
    contentLength: videoContent?.length || 0,
    responsesCount: responsesWithTimestamps?.length || 0,
    brollPromptsCount: brollPrompts?.length || 0,
    socketId,
    userId,
    threadId,
    interviewId,
    contentId,
    hasVideoModule: !!generateAndStoreReportVideo
  });
  
  try {
    // Check if video module is initialized
    if (!generateAndStoreReportVideo) {
      throw new Error('Video generation module not initialized');
    }
    
    if (!storage || !bucket) {
      throw new Error('Google Cloud Storage not initialized');
    }
    
    if (!openai) {
      throw new Error('OpenAI client not initialized');
    }
    
    // Call the video generation function
    console.log(`[ReportVideoQueue] Starting video generation for report ${reportId}`);
    const startTime = Date.now();
    
    const videoResult = await generateAndStoreReportVideo(
      reportId,
      videoContent,
      responsesWithTimestamps,
      db,
      storage,
      bucket.name,
      openai,
      brollPrompts // Pass b-roll prompts to video generation
    );
    
    const processingTime = Date.now() - startTime;
    console.log(`[ReportVideoQueue] Video generation completed in ${processingTime}ms`);
    
    if (!videoResult) {
      throw new Error('Video generation returned null');
    }
    
    // Handle both old format (string) and new format (object with videoUrl and thumbnailUrl)
    const videoGcsUrl = typeof videoResult === 'string' ? videoResult : videoResult.videoUrl;
    const thumbnailGcsUrl = typeof videoResult === 'object' ? videoResult.thumbnailUrl : null;
    
    // Update the report document with video URL if this is a real report
    if (reportId && !reportId.startsWith('analyst_')) {
      const updateData = {
        video_gcs_url: videoGcsUrl,
        video_generated_at: admin.firestore.FieldValue.serverTimestamp()
      };
      if (thumbnailGcsUrl) {
        updateData.thumbnail_gcs_url = thumbnailGcsUrl;
      }
      await db.collection('reports').doc(reportId).update(updateData);
      console.log(`[ReportVideoQueue] Updated report ${reportId} with video URL and thumbnail`);
    }
    
    // For analyst videos, update or create content document
    if (reportId && reportId.startsWith('analyst_')) {
      try {
        // Get signed URLs for both video and thumbnail
        const videoPath = videoGcsUrl.replace(`gs://${bucket.name}/`, '');
        const file = bucket.file(videoPath);
        const [signedUrl] = await file.getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        });
        
        let signedThumbnailUrl = null;
        if (thumbnailGcsUrl) {
          try {
            const thumbnailPath = thumbnailGcsUrl.replace(`gs://${bucket.name}/`, '');
            const thumbnailFile = bucket.file(thumbnailPath);
            const [thumbUrl] = await thumbnailFile.getSignedUrl({
              version: 'v4',
              action: 'read',
              expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
            });
            signedThumbnailUrl = thumbUrl;
          } catch (thumbError) {
            console.error(`[ReportVideoQueue] Error getting thumbnail signed URL:`, thumbError);
          }
        }
        
        // Check if we have a content ID to update
        if (contentId) {
          // Update existing content document
          const updateData = {
            videoUrl: signedUrl,
            gcsVideoUrl: videoGcsUrl,
            status: 'completed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            completedAt: admin.firestore.FieldValue.serverTimestamp()
          };
          if (signedThumbnailUrl) {
            updateData.thumbnailUrl = signedThumbnailUrl;
            updateData.gcsThumbnailUrl = thumbnailGcsUrl;
          }
          await db.collection('content').doc(contentId).update(updateData);
          console.log(`[ReportVideoQueue] Updated content document ${contentId} with completed video`);
        } else {
          // Always create a new content document
          console.log(`[ReportVideoQueue] No contentId provided, creating new content document`);
          
          if (threadId && interviewId) {
            // Debug brollPrompts structure
            console.log(`[ReportVideoQueue] brollPrompts structure:`, JSON.stringify(brollPrompts, null, 2));
            
            // Flatten broll prompts to simple strings array
            let flattenedPrompts = [];
            if (brollPrompts && Array.isArray(brollPrompts)) {
              brollPrompts.forEach((segment, index) => {
                if (Array.isArray(segment)) {
                  segment.forEach((prompt, optionIndex) => {
                    flattenedPrompts.push(`Segment ${index + 1} Option ${optionIndex + 1}: ${String(prompt)}`);
                  });
                } else {
                  flattenedPrompts.push(`Segment ${index + 1}: ${String(segment)}`);
                }
              });
            }
            
            const contentDoc = {
              type: 'video',
              subtype: 'analyst_summary',
              userId: userId,
              interviewIds: [interviewId], // Array to support multiple interviews in future
              threadId: threadId,
              title: 'Video Summary',
              videoUrl: signedUrl,
              gcsVideoUrl: videoGcsUrl,
              status: 'completed',
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              reportId: reportId || '',
              videoContent: videoContent ? String(videoContent).substring(0, 1000) : '', // Store first 1000 chars for reference
              responsesCount: parseInt(responsesWithTimestamps?.length || 0),
              brollPrompts: flattenedPrompts // Store as flat array of strings
            };
            
            // Add thumbnail if available
            if (signedThumbnailUrl) {
              contentDoc.thumbnailUrl = signedThumbnailUrl;
              contentDoc.gcsThumbnailUrl = thumbnailGcsUrl;
            }
            
            // Save to content collection
            const contentRef = await db.collection('content').add(contentDoc);
            contentId = contentRef.id;
            console.log(`[ReportVideoQueue] Created content document ${contentRef.id} for analyst video`);
          } else {
            console.log(`[ReportVideoQueue] Missing threadId or interviewId, cannot create content document`);
          }
        }
        
        // Also update the original message to mark it as having a video (for backwards compatibility)
        if (threadId && interviewId && userId) {
          try {
            const messagesSnapshot = await db.collection('analystThreads')
              .doc(userId)
              .collection('interviews')
              .doc(interviewId)
              .collection('threads')
              .doc(threadId)
              .collection('messages')
              .where('videoStatus', '==', 'processing')
              .orderBy('timestamp', 'desc')
              .limit(1)
              .get();
            
            if (!messagesSnapshot.empty) {
              const messageDoc = messagesSnapshot.docs[0];
              await messageDoc.ref.update({
                videoStatus: 'completed',
                contentId: contentId, // Reference to the content document
                videoCreatedAt: new Date().toISOString()
              });
              console.log(`[ReportVideoQueue] Updated analyst message ${messageDoc.id} with content reference`);
            }
          } catch (msgError) {
            console.log(`[ReportVideoQueue] Could not update original message:`, msgError.message);
          }
        }
      } catch (updateError) {
        console.error(`[ReportVideoQueue] Error creating content document:`, updateError);
        // Don't fail the whole process if content creation fails
      }
    }
    
    // Emit success event if socket still connected
    if (global.io && socketId) {
      const socket = global.io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('reportVideoGenerationSuccess', {
          reportId,
          videoUrl: videoGcsUrl,
          threadId
        });
      }
    }
    
    cb(null, { success: true, videoUrl: videoGcsUrl });
    
  } catch (error) {
    console.error(`[ReportVideoQueue] Error processing video for ${reportId}:`, error);
    console.error(`[ReportVideoQueue] Error details:`, {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    
    // Emit error event if socket still connected
    if (global.io && socketId) {
      const socket = global.io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('reportVideoGenerationError', {
          reportId,
          error: error.message,
          threadId
        });
      }
    }
    
    cb(error);
  }
}, {
  concurrent: 1, // Process 1 report video at a time
  maxRetries: 1,
  retryDelay: 10000,
  afterProcessDelay: 1000
});

// Add monitoring for report video queue
reportVideoQueue.on('task_queued', (taskId, task) => {
  console.log(`[ReportVideoQueue] Task queued: ${task.reportId}`);
});

reportVideoQueue.on('task_started', (taskId) => {
  console.log(`[ReportVideoQueue] Task started: ${taskId}`);
});

reportVideoQueue.on('task_finish', (taskId, result) => {
  console.log(`[ReportVideoQueue] Task completed: ${taskId}`);
});

reportVideoQueue.on('task_failed', (taskId, error) => {
  console.error(`[ReportVideoQueue] Task failed: ${taskId}`, error);
});

module.exports = { mediaQueue, reportVideoQueue, initialize };
