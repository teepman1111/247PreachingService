let cachedToken;
let tokenRequest;

export function captionsConfigured(env) {
  return Boolean(env.YOUTUBE_OAUTH_CLIENT_ID && env.YOUTUBE_OAUTH_CLIENT_SECRET && env.YOUTUBE_OAUTH_REFRESH_TOKEN);
}

async function accessToken(env) {
  if (cachedToken?.refreshToken === env.YOUTUBE_OAUTH_REFRESH_TOKEN &&
      cachedToken.clientId === env.YOUTUBE_OAUTH_CLIENT_ID && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }
  if (tokenRequest?.refreshToken === env.YOUTUBE_OAUTH_REFRESH_TOKEN &&
      tokenRequest.clientId === env.YOUTUBE_OAUTH_CLIENT_ID) {
    return tokenRequest.result;
  }
  const result = (async () => {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: env.YOUTUBE_OAUTH_CLIENT_ID,
        client_secret: env.YOUTUBE_OAUTH_CLIENT_SECRET,
        refresh_token: env.YOUTUBE_OAUTH_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error('YouTube caption authorization expired or was rejected. Check the production OAuth credentials.');
    const token = await response.json();
    if (typeof token.access_token !== 'string') throw new Error('YouTube did not return an access token.');
    cachedToken = {
      refreshToken: env.YOUTUBE_OAUTH_REFRESH_TOKEN,
      clientId: env.YOUTUBE_OAUTH_CLIENT_ID,
      value: token.access_token,
      expiresAt: Date.now() + (Number(token.expires_in) - 60) * 1000,
    };
    return token.access_token;
  })();
  tokenRequest = { refreshToken: env.YOUTUBE_OAUTH_REFRESH_TOKEN, clientId: env.YOUTUBE_OAUTH_CLIENT_ID, result };
  try {
    return await result;
  } finally {
    if (tokenRequest?.result === result) tokenRequest = null;
  }
}

async function captionsRequest(path, token, signal) {
  const response = await fetch('https://www.googleapis.com/youtube/v3/captions' + path, {
    headers: { Authorization: 'Bearer ' + token },
    signal,
  });
  if (response.ok) return response;
  const reason = (await response.json().catch(() => ({}))).error?.errors?.[0]?.reason;
  if (response.status === 404 || (response.status === 403 && reason === 'forbidden')) return null;
  if (response.status === 429 || ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)) {
    throw new Error('YouTube caption quota is exhausted. Indexing can resume when the Google quota resets.');
  }
  if (response.status === 401 || response.status === 403) {
    cachedToken = null;
    throw new Error('YouTube rejected the caption authorization. Check access and the youtube.force-ssl scope.');
  }
  throw new Error('YouTube could not retrieve captions. Try again.');
}

function captionText(srt) {
  return srt.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    .split(/\n\n+/)
    .map(block => {
      const lines = block.split('\n');
      const timing = lines.findIndex(line => /\d\d:\d\d:\d\d[,.]\d+\s+-->\s+\d\d:/.test(line));
      return timing < 0 ? '' : lines.slice(timing + 1).join(' ').replace(/<[^>]*>/g, '').trim();
    })
    .filter(Boolean)
    .join('\n');
}

export async function readYouTubeTranscript(env, videoId) {
  const token = await accessToken(env);
  const signal = AbortSignal.timeout(35000);
  const query = new URLSearchParams({ part: 'snippet', videoId });
  const response = await captionsRequest('?' + query, token, signal);
  if (!response) return { reason: 'access' };
  const { items } = await response.json();
  if (!Array.isArray(items)) throw new Error('YouTube returned incomplete caption information.');
  // Prefer human-authored tracks over automatic tracks.
  const candidates = items.filter(item => item.id && item.snippet?.status === 'serving' && !item.snippet.isDraft);
  const rank = item => Number(Boolean(item.snippet.isAutoSynced)) + 2 * Number(item.snippet.trackKind === 'ASR');
  candidates.sort((left, right) => rank(left) - rank(right));
  if (!candidates.length) return { reason: 'missing' };
  for (const track of candidates) {
    const caption = await captionsRequest('/' + encodeURIComponent(track.id) + '?tfmt=srt', token, signal);
    if (!caption) continue;
    const text = captionText(await caption.text());
    if (text) return { transcript: text };
  }
  return { reason: 'access' };
}
