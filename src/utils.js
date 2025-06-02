export function processThreadTweet(data) {
  return {
    tweetId: data.id,
    text: data.text,
    threadPosition: data.threadPosition || 0,
    mediaIds: data.mediaIds,
    status: data.status,
    publishedTweetId: data.publishedTweetId,
    imageUrl: data.imageUrl,
  };
}

/**
 * Publishes a tweet using Twitter API v2
 */
export async function publishTweet(accessToken, options) {
  const response = await fetch('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const errorData = await response.json();
    const error = new Error(
      errorData.errors?.[0]?.message ||
        errorData.detail ||
        'Failed to publish tweet'
    );
    error.code = response.status;
    error.response = errorData;
    throw error;
  }

  return response.json();
}

export async function refreshOAuthToken(twitterData) {
  const refreshToken = twitterData.oauthCredentials.refreshToken;
  const basicAuth = Buffer.from(
    `${twitterData.credentials.clientId}:${twitterData.credentials.clientSecret}`
  ).toString('base64');

  const response = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    const errorData = await response.json();
    const error = new Error(
      errorData.error_description || 'Failed to refresh token'
    );
    error.code = response.status;
    error.response = errorData;
    throw error;
  }

  return response.json();
}

export async function refreshTwitterAccessToken(twitterCredentials) {
  console.log(
    '[refreshTwitterAccessToken] Attempting to refresh Twitter access token...'
  );
  try {
    const tokenResponse = await refreshOAuthToken(twitterCredentials);
    if (!tokenResponse || typeof tokenResponse !== 'object') {
      throw new Error('Invalid token refresh response format');
    }
    const accessToken = tokenResponse.access_token;
    const refreshToken = tokenResponse.refresh_token;
    const expiredIn = tokenResponse.expires_in;
    if (!accessToken || !refreshToken) {
      throw new Error('Missing tokens in refresh response');
    }
    console.log('[refreshTwitterAccessToken] Successfully refreshed token.');
    return { accessToken, refreshToken, expiresAt: expiredIn };
  } catch (error) {
    console.error(
      '[refreshTwitterAccessToken] Failed to refresh token:',
      error
    );
    const e = new Error(
      error?.message || 'Failed to refresh Twitter access token.'
    );
    // Preserve useful fields for callers
    if (error?.code) e.code = error.code;
    if (error?.status) e.status = error.status;
    if (error?.statusCode) e.statusCode = error.statusCode;
    if (error?.response) e.response = error.response;
    throw e;
  }
}

export function getExpiresAt(expireIn) {
  const now = new Date();
  return new Date(now.getTime() + expireIn * 1000);
}
