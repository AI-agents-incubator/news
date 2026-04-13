import { publishToFacebook } from './facebook.js';
import { publishToTelegram } from './telegram.js';
import { publishToYouTube } from './youtube.js';
import { updateDigest } from '../../db/index.js';

/**
 * Publish a digest to all enabled platforms.
 * A platform is "enabled" when its required tokens/IDs are present in config.
 *
 * @param {Object} digest  - Digest record from DB (must have id and content)
 * @param {Object} config  - App config object
 * @returns {{ facebook, telegram, youtube }} results per platform (or null)
 */
export async function publishDigest(digest, config) {
  const results = {
    facebook: null,
    telegram: null,
    youtube: null,
  };

  const updateFields = {};

  // Facebook
  if (config.facebookPageAccessToken && config.facebookPageId) {
    results.facebook = await publishToFacebook(
      config.facebookPageAccessToken,
      config.facebookPageId,
      digest.content,
    );
    if (results.facebook?.postId) {
      updateFields.facebook_post_id = results.facebook.postId;
    }
  }

  // Telegram (publish to channel, not personal chat)
  const tgPublishChat = config.telegramPublishChatId || config.telegramChatId;
  if (config.telegramBotToken && tgPublishChat) {
    results.telegram = await publishToTelegram(
      config.telegramBotToken,
      tgPublishChat,
      digest.content,
    );
    if (results.telegram?.messageId) {
      updateFields.telegram_message_id = String(results.telegram.messageId);
    }
  }

  // YouTube (placeholder)
  if (config.youtubeAccessToken && config.youtubeChannelId) {
    results.youtube = await publishToYouTube(
      config.youtubeAccessToken,
      config.youtubeChannelId,
      digest.content,
    );
    if (results.youtube?.postId) {
      updateFields.youtube_post_id = results.youtube.postId;
    }
  }

  // Update digest record with post IDs and mark as published
  const hasAnyResult = Object.keys(updateFields).length > 0;
  if (hasAnyResult) {
    updateFields.status = 'published';
    updateFields.published_at = new Date().toISOString();
    updateDigest(digest.id, updateFields);
  }

  return results;
}
