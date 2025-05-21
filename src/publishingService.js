import { db } from '@/lib/firebase/admin';
import { publishTweet } from './utils.js';
import { Timestamp } from 'firebase-admin/firestore';
import { TweetStatus } from './constants.js';
import { uploadMediaToTwitter } from './mediaUpload';
import { processThreadTweet, refreshTwitterAccessToken } from './utils';
import { getTweetGroup } from './groups';
// Types for the service

/**
 * TwitterPublishingService - A service to handle all tweet publishing operations
 */
export class TwitterPublishingService {
  /**
   * Verify if a user has access to a project
   * @param userId The ID of the user
   * @param projectId The ID of the project
   * @returns ProjectVerificationResult
   */
  async verifyProjectAccess(userId, projectId) {
    try {
      // Verify the project exists
      const projectDoc = await db.collection('projects').doc(projectId).get();
      if (!projectDoc.exists) {
        return {
          isAuthorized: false,
          error: 'Project not found',
          statusCode: 404,
        };
      }

      const projectData = projectDoc.data();
      if (!projectData) {
        return {
          isAuthorized: false,
          error: 'Project data is empty',
          statusCode: 404,
        };
      }

      // Check if the project belongs to the user
      if (projectData.userId === userId) {
        return { isAuthorized: true };
      }

      // Check if the user is a member of the workspace
      if (projectData.workspaceId) {
        const workspaceDoc = await db
          .collection('workspaces')
          .doc(projectData.workspaceId)
          .get();

        if (!workspaceDoc.exists) {
          return {
            isAuthorized: false,
            error: 'Workspace not found',
            statusCode: 404,
          };
        }

        const workspaceData = workspaceDoc.data();
        if (!workspaceData) {
          return {
            isAuthorized: false,
            error: 'Workspace data is empty',
            statusCode: 404,
          };
        }

        const isMember =
          workspaceData.members?.includes(userId) ||
          workspaceData.ownerId === userId;

        if (isMember) {
          return { isAuthorized: true };
        }
      }

      // User doesn't have access
      return {
        isAuthorized: false,
        error: 'You do not have permission to access this project',
        statusCode: 403,
      };
    } catch (error) {
      console.error('Error verifying project access:', error);
      return {
        isAuthorized: false,
        error: 'Error verifying project access',
        statusCode: 500,
      };
    }
  }

  /**
   * Get user's Twitter credentials
   * @param userId The ID of the user
   * @returns TwitterCredentials or null if not found
   */
  async getTwitterCredentials(userId) {
    try {
      const twitterDoc = await db
        .collection('twitter_credentials')
        .doc(userId)
        .get();

      if (!twitterDoc.exists) {
        console.error('Twitter credentials not found for user:', userId);
        return null;
      }

      const twitterData = twitterDoc.data();

      if (!twitterData?.oauthCredentials?.accessToken) {
        console.error('Twitter credentials are incomplete for user:', userId);
        return null;
      }

      return twitterData;
    } catch (error) {
      console.error('Error fetching Twitter credentials:', error);
      return null;
    }
  }

  /**
   * Update Twitter credentials after token refresh
   * @param userId The ID of the user
   * @param accessToken The new access token
   * @param refreshToken The new refresh token
   */
  async updateTwitterCredentials(userId, accessToken, refreshToken) {
    await db.collection('twitter_credentials').doc(userId).update({
      'oauthCredentials.accessToken': accessToken,
      'oauthCredentials.refreshToken': refreshToken,
      'oauthCredentials.updatedAt': Timestamp.now(),
    });
  }

  /**
   * Uploads media from a URL to Twitter, with token refresh and retry logic
   * @param imageUrl The URL of the image to upload
   * @param twitterCredentials The user's Twitter credentials
   * @param retryCount Number of retries attempted (default 0)
   * @returns Promise with the media ID
   */
  async uploadMedia(imageUrl, twitterCredentials, retryCount = 0) {
    const accessToken = twitterCredentials.oauthCredentials.accessToken;
    try {
      // Use our streaming upload function
      const mediaId = await uploadMediaToTwitter(imageUrl, accessToken);
      return { media_id_string: mediaId };
    } catch (error) {
      const isAuthError =
        error?.code === 401 ||
        error?.status === 401 ||
        error?.statusCode === 401 ||
        error?.message?.toString().includes('401');
      if (
        isAuthError &&
        twitterCredentials.oauthCredentials.refreshToken &&
        retryCount < 2
      ) {
        console.log(
          '[uploadMedia] Auth error detected, attempting token refresh...'
        );
        try {
          const { accessToken: newAccessToken, refreshToken: newRefreshToken } =
            await refreshTwitterAccessToken(twitterCredentials);
          if (!twitterCredentials.userId) {
            throw new Error('User ID is required for token refresh');
          }
          await this.updateTwitterCredentials(
            twitterCredentials.userId,
            newAccessToken,
            newRefreshToken
          );
          // Update credentials in memory for retry
          twitterCredentials.oauthCredentials.accessToken = newAccessToken;
          twitterCredentials.oauthCredentials.refreshToken = newRefreshToken;
          console.log(
            '[uploadMedia] Retrying media upload with refreshed token...'
          );
          return this.uploadMedia(imageUrl, twitterCredentials, retryCount + 1);
        } catch (refreshError) {
          console.error(
            '[uploadMedia] Failed to refresh token during media upload:',
            refreshError
          );
          throw new Error('Error refreshing Twitter token during media upload');
        }
      }
      console.error('Error uploading media:', error);
      throw new Error('Error uploading media');
    }
  }

  /**
   * Helper method to prepare tweet payload for the Twitter API
   * @param options Tweet options (text, mediaIds, etc.)
   * @returns Prepared tweet payload for the Twitter API
   * @private
   */
  async prepareTweetPayload(options) {
    console.log('Preparing tweet payload with options:', options);
    if (options.imageUrl && options.accessToken && options.twitterCredentials) {
      const media = await this.uploadMedia(
        options.imageUrl,
        options.twitterCredentials
      );
      options.mediaIds = [media.media_id_string];
      if (!media.media_id_string) {
        throw new Error('Failed to upload media');
      }
    }
    const payload = {
      text: options.text,
    };

    // Add media if provided
    if (options.mediaIds && options.mediaIds.length > 0) {
      payload.media = { media_ids: options.mediaIds };
    }

    // Add reply if provided
    if (options.replyToTweetId) {
      payload.reply = { in_reply_to_tweet_id: options.replyToTweetId };
    }

    return payload;
  }

  /**
   * Publish a tweet with token refresh handling
   * @param twitterCredentials The user's Twitter credentials
   * @param options Tweet options (text, mediaIds, etc.)
   * @returns PublishResult
   */
  async publishTweetWithRefresh(twitterCredentials, options) {
    const accessToken = twitterCredentials.oauthCredentials.accessToken;
    try {
      console.log(
        'Publishing tweet with text:',
        options.text.substring(0, 30) + '...'
      );

      // Prepare the tweet payload using the helper method with userId
      const tweetPayload = await this.prepareTweetPayload({
        ...options,
        accessToken,
        twitterCredentials,
      });

      // Attempt to publish the tweet
      const publishedTweet = await publishTweet(accessToken, tweetPayload);

      console.log('Tweet published successfully:', {
        tweetId: publishedTweet.data.id,
        text: options.text.substring(0, 30) + '...',
      });

      return {
        success: true,
        twitterTweetId: publishedTweet.data.id,
        publishedTweetId: publishedTweet.data.id,
        message: 'Tweet published successfully',
      };
    } catch (publishError) {
      console.error(
        'Error publishing tweet to Twitter:',
        JSON.stringify(publishError)
      );

      // Check if it might be an auth error and we have a refresh token
      const isAuthError =
        publishError.code === 401 ||
        publishError.message?.includes('401') ||
        publishError.status === 401 ||
        publishError.statusCode === 401;

      if (isAuthError && twitterCredentials.oauthCredentials?.refreshToken) {
        console.log('Attempting to refresh Twitter OAuth token...');
        try {
          // Refresh the token with better error handling
          const { accessToken: newAccessToken, refreshToken: newRefreshToken } =
            await refreshTwitterAccessToken(twitterCredentials);
          if (!twitterCredentials.userId) {
            throw new Error('User ID is required for token refresh');
          }
          await this.updateTwitterCredentials(
            twitterCredentials.userId,
            newAccessToken,
            newRefreshToken
          );

          console.log(
            'Successfully refreshed Twitter OAuth token, trying to publish again...'
          );

          // Prepare the tweet payload again using the helper method
          const tweetPayload = await this.prepareTweetPayload({
            ...options,
            accessToken: newAccessToken,
            twitterCredentials,
          });

          // Try again with the new access token
          const publishedTweet = await publishTweet(
            newAccessToken,
            tweetPayload
          );

          console.log('Tweet published successfully after token refresh:', {
            tweetId: publishedTweet.data.id,
            text: options.text.substring(0, 30) + '...',
          });

          return {
            success: true,
            twitterTweetId: publishedTweet.data.id,
            message:
              'Tweet published successfully after refreshing credentials',
          };
        } catch (refreshError) {
          console.error('Failed to refresh Twitter OAuth token:', refreshError);
          return {
            success: false,
            message: 'Twitter authentication failed',
            error: {
              details:
                'Your Twitter connection has expired. Please reconnect your Twitter account.',
              code: 'token_expired',
              originalError: refreshError.message,
            },
          };
        }
      }

      // Handle other Twitter API errors
      return {
        success: false,
        message: 'Failed to publish tweet',
        error: {
          details:
            publishError.message ||
            'An error occurred while publishing to Twitter',
          code: 'api_error',
          status: publishError.status || publishError.statusCode,
        },
      };
    }
  }

  /**
   * Update tweet status in Firestore after publishing
   * @param projectId The ID of the project
   * @param tweetId The ID of the tweet
   * @param publishedTweetId The ID of the published tweet on Twitter
   * @param publishedText The text of the published tweet
   */
  async updateTweetStatus(projectId, tweetId, publishedTweetId, publishedText) {
    await db
      .collection('projects')
      .doc(projectId)
      .collection('tweets')
      .doc(tweetId)
      .update({
        status: 'published',
        publishedAt: Timestamp.now(),
        publishedTweetId: publishedTweetId,
        publishedText: publishedText,
        scheduledFor: null,
        scheduledTweetId: null,
      });
  }

  /**
   * The main method to publish a tweet
   * @param userId The ID of the user
   * @param options The publish options
   * @returns PublishResult
   */
  async publishTweet(userId, options) {
    try {
      // Validate inputs
      if (!options.tweetId || !options.projectId || !options.text) {
        return {
          success: false,
          message: 'Missing required fields',
          error: { details: 'tweetId, projectId, and text are required' },
        };
      }

      // 1. Verify the user has access to the project
      const projectAccess = await this.verifyProjectAccess(
        userId,
        options.projectId
      );
      if (!projectAccess.isAuthorized) {
        return {
          success: false,
          message: projectAccess.error || 'Unauthorized',
          error: {
            details: projectAccess.error,
            code: projectAccess.statusCode,
          },
        };
      }

      // 1.5. Check if the group is enabled (if groupId is present)
      if (options['groupId']) {
        const group = await getTweetGroup(options['groupId']);
        if (group && group.isEnabled === false) {
          return {
            success: false,
            message: 'Group is disabled. Tweet will not be published.',
            error: { details: 'Group is disabled.' },
          };
        }
      }

      // 2. Get user's Twitter credentials
      const twitterCredentials = await this.getTwitterCredentials(userId);
      if (!twitterCredentials) {
        return {
          success: false,
          message: 'Twitter credentials not found',
          error: {
            details: 'Please connect your Twitter account in settings',
            code: 'credentials_not_found',
          },
        };
      }

      // 3. Verify the tweet exists in Firestore
      const tweetDoc = await db
        .collection('projects')
        .doc(options.projectId)
        .collection('tweets')
        .doc(options.tweetId)
        .get();

      if (!tweetDoc.exists) {
        return {
          success: false,
          message: 'Tweet not found',
          error: { details: 'The specified tweet does not exist' },
        };
      }

      // Add userId to credentials for updating later
      twitterCredentials.userId = userId;

      // 4. Attempt to publish the tweet
      const publishResult = await this.publishTweetWithRefresh(
        twitterCredentials,
        {
          text: options.text,
          mediaIds: options.mediaIds,
          replyToTweetId: options.replyToTweetId,
          imageUrl: options.imageUrl,
          ...tweetDoc.data(),
        }
      );

      // 5. If successful, update the tweet status in Firestore
      if (publishResult.success && publishResult.twitterTweetId) {
        await this.updateTweetStatus(
          options.projectId,
          options.tweetId,
          publishResult.twitterTweetId,
          options.text
        );
      }

      return publishResult;
    } catch (error) {
      console.error('Error in publishTweet service:', error);
      return {
        success: false,
        message: 'Internal server error',
        error: { details: error.message },
      };
    }
  }

  /**
   * Publish a tweet that was scheduled
   * @param tweet The tweet object with project ID
   * @param twitterCredentials The user's Twitter credentials
   * @returns Boolean indicating success
   */
  async publishScheduledTweet(tweet, twitterCredentials) {
    try {
      // 0. Check if the group is enabled (if groupId is present)
      if (tweet.groupId) {
        const group = await getTweetGroup(tweet.groupId);
        if (group && group.isEnabled === false) {
          console.warn(
            `Group ${tweet.groupId} is disabled. Skipping tweet ${tweet.id}.`
          );
          return false;
        }
      }

      // Add userId to credentials for updating later
      twitterCredentials.userId = tweet.userId;

      // 1. Attempt to publish the tweet
      const publishResult = await this.publishTweetWithRefresh(
        twitterCredentials,
        {
          ...tweet,
          text: tweet.text,
          mediaIds: tweet.mediaIds,
          // Include any other options like replyToTweetId if needed
        }
      );

      // 2. If successful, update the tweet status in Firestore
      if (publishResult.success && publishResult.twitterTweetId) {
        await this.updateTweetStatus(
          tweet.projectId,
          tweet.id,
          publishResult.twitterTweetId,
          tweet.text
        );
        return true;
      }

      return false;
    } catch (error) {
      console.error(`Error publishing scheduled tweet ${tweet.id}:`, error);
      return false;
    }
  }

  /**
   * Group tweets by user ID for batch processing
   * @param tweets Array of tweets with their project IDs
   * @returns Record of userIds to their tweets
   */
  groupTweetsByUser(tweets) {
    const tweetsByUser = {};

    for (const tweet of tweets) {
      if (!tweet.userId) continue;

      if (!tweetsByUser[tweet.userId]) {
        tweetsByUser[tweet.userId] = [];
      }

      tweetsByUser[tweet.userId].push(tweet);
    }

    return tweetsByUser;
  }

  /**
   * Process all scheduled tweets that are due
   * @returns Object with counts of processed tweets and any errors
   */
  async processAllScheduledTweets(tweets, threads, userId, projectId) {
    try {
      if (tweets.length) {
        for (let i = 0; i < tweets.length; i++) {
          await this.publishTweet(userId, {
            ...tweets[i],
            tweetId: tweets[i].id,
          });
        }
      }
      if (threads?.length) {
        await this.publishThreadTweets(
          userId,
          projectId,
          threads.map(processThreadTweet)
        );
      }

      return;
    } catch (error) {
      console.error('Error processing scheduled tweets:', error);
      throw error;
    }
  }

  /**
   * Publishes multiple tweets as a thread
   * @param userId The ID of the user
   * @param projectId The ID of the project
   * @param threadTweets Array of tweets to publish as a thread, should be sorted by threadPosition
   * @returns Results of the thread publishing operation
   */
  async publishThreadTweets(userId, projectId, threadTweets) {
    try {
      // Verify the user has access to the project
      const projectAccess = await this.verifyProjectAccess(userId, projectId);
      if (!projectAccess.isAuthorized) {
        return {
          success: false,
          message:
            projectAccess.error || 'Not authorized to access this project',
          error: {
            statusCode: projectAccess.statusCode || 403,
            details: projectAccess.error,
          },
        };
      }

      // Get the user's Twitter credentials
      const twitterCredentials = await this.getTwitterCredentials(userId);
      if (!twitterCredentials) {
        return {
          success: false,
          message: 'Twitter credentials not found',
          error: {
            statusCode: 404,
            details: 'No Twitter credentials available for this user',
          },
        };
      }

      // Verify we have tweets to publish
      if (!threadTweets || threadTweets.length === 0) {
        return {
          success: false,
          message: 'No tweets provided for the thread',
          error: {
            statusCode: 400,
            details: 'Thread must contain at least one tweet',
          },
        };
      }

      // Sort tweets by threadPosition if they're not already sorted
      const sortedTweets = [...threadTweets].sort((a, b) => {
        const posA = a.threadPosition || 0;
        const posB = b.threadPosition || 0;
        return posA - posB;
      });

      console.log(`Publishing thread with ${sortedTweets.length} tweets...`);

      // Track results and the previous tweet ID for threading
      const results = [];

      let previousTweetId = undefined;

      // Publish each tweet in the thread
      for (const tweet of sortedTweets) {
        if (tweet.status === TweetStatus.PUBLISHED) {
          previousTweetId = tweet.publishedTweetId;
          continue;
        }
        try {
          // Prepare publish options, linking to the previous tweet if it exists
          const publishOptions = {
            ...tweet,
            tweetId: tweet.tweetId,
            projectId,
            text: tweet.text,
            mediaIds: tweet.mediaIds,
          };

          // If we have a previous tweet ID, set it as the reply ID to create the thread
          if (previousTweetId) {
            publishOptions.replyToTweetId = previousTweetId;
          }

          console.log('publishOptions', publishOptions);

          // Publish the tweet
          const result = await this.publishTweetWithRefresh(
            twitterCredentials,
            publishOptions
          );

          // Store the result
          results.push({
            tweetId: tweet.tweetId,
            publishedTweetId: result.twitterTweetId,
            success: result.success,
            message: result.message,
          });

          // If successful, update the previous tweet ID for the next iteration
          if (result.success && result.twitterTweetId) {
            previousTweetId = result.twitterTweetId;

            // Update the tweet status in Firestore
            await this.updateTweetStatus(
              projectId,
              tweet.tweetId,
              result.twitterTweetId,
              tweet.text
            );
          } else {
            // If a tweet fails, stop the thread publishing process to preserve thread integrity
            console.error(
              `Failed to publish tweet in thread: ${result.message}`
            );
            console.log(
              'Stopping thread publishing to maintain order integrity'
            );
            break; // Stop processing more tweets
          }
        } catch (error) {
          console.error(`Error publishing tweet in thread:`, error);
          results.push({
            tweetId: tweet.tweetId,
            success: false,
            message: 'Tweet publishing failed',
          });
          // Stop processing if any error occurs
          console.log('Stopping thread publishing due to error');
          break; // Stop processing more tweets
        }
      }

      // Determine overall success based on individual tweet results
      const allSucceeded = results.every(r => r.success);
      const publishedCount = results.filter(r => r.success).length;
      const totalCount = sortedTweets.length;
      const stoppedEarly = publishedCount < totalCount && publishedCount > 0;

      return {
        success: allSucceeded,
        message: allSucceeded
          ? `Thread published successfully (${publishedCount} tweets)`
          : stoppedEarly
            ? `Thread publishing stopped after ${publishedCount}/${totalCount} tweets to maintain thread integrity`
            : 'Failed to publish thread',
        results,
      };
    } catch (error) {
      console.error('Error publishing thread:', error);
      return {
        success: false,
        message: 'Failed to publish thread',
        error: {
          details: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * Schedule a thread of tweets for future publication
   * @param userId The ID of the user
   * @param projectId The ID of the project
   * @param threadTweets The array of tweets in the thread
   * @param scheduledFor ISO 8601 date string when the thread should be published
   * @returns Promise with scheduling result
   */
  async scheduleThreadTweets(
    userId,
    projectId,
    threadTweets,
    scheduledFor // ISO date string
  ) {
    try {
      // Verify project access
      const projectAccess = await this.verifyProjectAccess(userId, projectId);
      if (!projectAccess.isAuthorized) {
        return {
          success: false,
          message: projectAccess.error || 'Project access denied',
          error: {
            statusCode: projectAccess.statusCode || 403,
            details:
              projectAccess.error || 'Not authorized to access this project',
          },
        };
      }

      // Get Twitter credentials
      const twitterCredentials = await this.getTwitterCredentials(userId);
      if (!twitterCredentials) {
        return {
          success: false,
          message: 'Twitter credentials not found',
          error: {
            statusCode: 404,
            details: 'Twitter credentials not found for this user',
          },
        };
      }

      // Validate scheduled time is in the future
      const scheduledDateTime = new Date(scheduledFor);
      const now = new Date();
      if (scheduledDateTime <= now) {
        return {
          success: false,
          message: 'Scheduled time must be in the future',
          error: {
            statusCode: 400,
            details: 'Cannot schedule tweets for a time in the past',
          },
        };
      }

      // Validate we have tweets to schedule
      if (!threadTweets || threadTweets.length === 0) {
        return {
          success: false,
          message: 'No tweets provided for scheduling',
          error: {
            statusCode: 400,
            details: 'Thread must contain at least one tweet',
          },
        };
      }

      // Sort tweets by thread position
      const sortedTweets = [...threadTweets].sort((a, b) => {
        const posA = a.threadPosition !== undefined ? a.threadPosition : 0;
        const posB = b.threadPosition !== undefined ? b.threadPosition : 0;
        return posA - posB;
      });

      // Prepare batch update
      const batch = db.batch();
      const results = [];

      // Update all tweets in the thread
      for (const tweet of sortedTweets) {
        const tweetRef = db
          .collection('projects')
          .doc(projectId)
          .collection('tweets')
          .doc(tweet.tweetId);

        batch.update(tweetRef, {
          status: TweetStatus.SCHEDULED,
          scheduledFor: scheduledDateTime,
          groupId: null, // Set null group id since we are scheduling a thread since time is already given
          isThread: true,
          threadPosition: tweet.threadPosition || sortedTweets.indexOf(tweet),
          imageUrl: tweet.imageUrl,
        });

        results.push({
          tweetId: tweet.tweetId,
          scheduledFor: scheduledFor,
          success: true,
          message: 'Scheduled successfully',
        });
      }

      // Commit all updates
      await batch.commit();

      console.log(
        `Successfully scheduled thread with ${sortedTweets.length} tweets for ${scheduledFor}`
      );

      return {
        success: true,
        message: `Thread of ${sortedTweets.length} tweets scheduled for ${new Date(
          scheduledFor
        ).toLocaleString()}`,
        results,
      };
    } catch (error) {
      console.error('Error scheduling thread tweets:', error);
      return {
        success: false,
        message: 'Failed to schedule thread',
        error: {
          statusCode: 500,
          details:
            error.message || 'Unknown error occurred while scheduling thread',
        },
      };
    }
  }
}

// Export a singleton instance
export const twitterPublishingService = new TwitterPublishingService();
