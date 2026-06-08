const { getSocialPublishJob } = require('../utils/social-store');
const {
  scheduleTikTokPublishJob,
  syncTikTokPublishJob,
} = require('./tiktok-publish-service');
const {
  scheduleInstagramPublishJob,
  syncInstagramPublishJob,
} = require('./instagram-publish-service');

async function syncSocialPublishJob(options) {
  const { db, publishJobId } = options;
  const publishJob = await getSocialPublishJob(db, publishJobId);
  if (!publishJob) return null;

  if (publishJob.data.platform === 'tiktok' && publishJob.data.publishMode === 'tiktok_draft') {
    return syncTikTokPublishJob(options);
  }

  if (publishJob.data.platform === 'instagram' && publishJob.data.publishMode === 'instagram_reel') {
    return syncInstagramPublishJob(options);
  }

  return publishJob.serialized;
}

function scheduleSocialPublishJob(options) {
  const { db, publishJobId } = options;
  getSocialPublishJob(db, publishJobId)
    .then((publishJob) => {
      if (!publishJob) return;

      if (publishJob.data.platform === 'tiktok' && publishJob.data.publishMode === 'tiktok_draft') {
        scheduleTikTokPublishJob(options);
        return;
      }

      if (publishJob.data.platform === 'instagram' && publishJob.data.publishMode === 'instagram_reel') {
        scheduleInstagramPublishJob(options);
      }
    })
    .catch((error) => {
      console.error('[SocialPublishJobScheduler]', error.message);
    });
}

module.exports = {
  scheduleSocialPublishJob,
  syncSocialPublishJob,
};
