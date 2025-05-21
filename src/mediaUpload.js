import fetch from 'node-fetch';
import FormData from 'form-data';

const TWITTER_UPLOAD_API = 'https://api.twitter.com/2/media/upload';
// mediaUpload.js
export async function uploadMediaToTwitter(imageUrl, accessToken) {
  try {
    console.log('Uploading media to Twitter', imageUrl);
    // Fetch the image headers first to get content type and size
    const headResponse = await fetch(imageUrl, { method: 'HEAD' });
    if (!headResponse.ok) {
      throw new Error(
        `Failed to get image headers: ${headResponse.status} ${headResponse.statusText}`
      );
    }

    const contentType =
      headResponse.headers.get('content-type') || 'image/jpeg';
    const contentLength = headResponse.headers.get('content-length');

    if (!contentLength) {
      throw new Error(
        'Content length not available, cannot proceed with streaming upload'
      );
    }

    const totalBytes = parseInt(contentLength, 10);

    console.log('Image info:', {
      contentType,
      totalBytes,
    });

    // 1. INIT phase
    console.log('Initializing media upload');
    const initFormData = new FormData();
    initFormData.append('command', 'INIT');
    initFormData.append('total_bytes', totalBytes.toString());
    initFormData.append('media_type', contentType);

    const initResponse = await fetch(TWITTER_UPLOAD_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: initFormData,
    });
    console.log('before initResponse', initResponse);

    if (!initResponse.ok) {
      const errorData = await initResponse.text();
      console.log('errorData', errorData, initResponse);
      throw new Error(`Media upload initialization failed: ${errorData}`);
    }

    console.log('initResponse', initResponse);

    const initData = await initResponse.json();
    console.log('initData', initData);

    // Check if we have media_id_string
    if (!initData || !initData.data.id) {
      throw new Error('Invalid media upload response from Twitter');
    }

    const mediaId = initData.data.id;

    // 2. APPEND phase - Stream the image directly to Twitter

    console.log('Media upload initialized with ID:', mediaId);
    console.log('streaming the upload');
    // Fetch the image as a stream
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(
        `Failed to fetch image: ${imageResponse.status} ${imageResponse.statusText}`
      );
    }

    // For smaller files, we can use a single APPEND command
    // This is more efficient for most profile images and small media
    const appendFormData = new FormData();
    appendFormData.append('command', 'APPEND');
    appendFormData.append('media_id', mediaId);
    appendFormData.append('segment_index', '0');

    // Get image as buffer for appending - using buffer instead of blob for Node.js compatibility
    const arrayBuffer = await imageResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Append buffer with filename and content type for proper multipart/form-data handling
    appendFormData.append('media', buffer, {
      filename: 'media.jpg',
      contentType: contentType,
    });

    const appendResponse = await fetch(TWITTER_UPLOAD_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: appendFormData,
    });

    if (!appendResponse.ok) {
      const errorText = await appendResponse.text();
      throw new Error(`Media upload append failed: ${errorText}`);
    }

    // 3. FINALIZE phase
    const finalizeFormData = new FormData();
    finalizeFormData.append('command', 'FINALIZE');
    finalizeFormData.append('media_id', mediaId);

    const finalizeResponse = await fetch(TWITTER_UPLOAD_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: finalizeFormData,
    });

    if (!finalizeResponse.ok) {
      const errorText = await finalizeResponse.text();
      throw new Error(`Media upload finalization failed: ${errorText}`);
    }

    const finalizeData = await finalizeResponse.json();
    console.log('Media upload finalized:', finalizeData);

    // Check if we need to wait for processing (for videos and animated GIFs)
    if (finalizeData.processing_info) {
      await checkMediaProcessingStatus(
        mediaId,
        accessToken,
        finalizeData.processing_info
      );
    }

    return mediaId;
  } catch (error) {
    console.error('Error in streaming media upload:', error);
    throw error instanceof Error
      ? error
      : new Error('Failed to upload media to Twitter');
  }
}

/**
 * Checks media processing status for videos and animated GIFs
 *
 * @param mediaId The media ID to check
 * @param accessToken Twitter OAuth access token
 * @param processingInfo Initial processing info
 */
async function checkMediaProcessingStatus(
  mediaId,
  accessToken,
  processingInfo
) {
  if (processingInfo.state === 'succeeded') {
    return;
  }

  const checkAfterSecs = processingInfo.check_after_secs || 1;

  console.log(
    `Media still processing. Checking again in ${checkAfterSecs} seconds...`
  );

  // Wait for the specified amount of time
  await new Promise(resolve => setTimeout(resolve, checkAfterSecs * 1000));

  // Check the status
  const statusUrl = `${TWITTER_UPLOAD_API}?command=STATUS&media_id=${mediaId}`;
  const statusResponse = await fetch(statusUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!statusResponse.ok) {
    throw new Error(
      `Failed to check media status: ${statusResponse.status} ${statusResponse.statusText}`
    );
  }

  const statusData = await statusResponse.json();

  if (statusData.processing_info) {
    // Recursively check again if still processing
    return checkMediaProcessingStatus(
      mediaId,
      accessToken,
      statusData.processing_info
    );
  }

  return;
}
