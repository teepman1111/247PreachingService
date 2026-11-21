export async function uploadChannel(req, { store, adminToken, apiKey, timingSafeEqual }) {
  if (req.method !== 'POST') {
    return Response.json({ error: 'POST required' }, { status: 405 });
  }

  if (!adminToken) {
    return Response.json({ error: 'Channel imports are disabled. Configure an admin token and YouTube API key in hosting settings.' }, { status: 503 });
  }

  const encoder = new TextEncoder();
  const expected = encoder.encode('Bearer ' + adminToken);
  const supplied = encoder.encode(req.headers.get('Authorization') ?? '');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return Response.json({ error: 'Invalid admin token.' }, { status: 401 });
  }

  if (!apiKey) {
    return Response.json(
      { error: 'YOUTUBE_API_KEY environment variable is not set.' },
      { status: 500 }
    );
  }

  const body = await req.json().catch(() => null);
  const channelId = body?.channelId;
  if (typeof channelId !== 'string' || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    return Response.json(
      { error: 'Enter a valid YouTube channel ID.' },
      { status: 400 }
    );
  }

  // Fetch channel details from YouTube API
  const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
  channelUrl.searchParams.set('part', 'snippet,contentDetails');
  channelUrl.searchParams.set('id', channelId);
  channelUrl.searchParams.set('key', apiKey);

  const channelRes = await fetch(channelUrl);
  if (!channelRes.ok) {
    return Response.json({ error: 'YouTube could not look up the channel.' }, { status: 502 });
  }
  const channelData = await channelRes.json();

  if (!channelData.items || channelData.items.length === 0) {
    return Response.json(
      { error: 'Channel not found. Check the channel ID.' },
      { status: 404 }
    );
  }

  const channelTitle = channelData.items[0].snippet.title;
  const uploadsPlaylistId =
    channelData.items[0].contentDetails.relatedPlaylists.uploads;

  // Fetch all video IDs from the uploads playlist (handles pagination)
  const videoIds = [];
  let nextPageToken = null;

  do {
    const playlistUrl = new URL(
      'https://www.googleapis.com/youtube/v3/playlistItems'
    );
    playlistUrl.searchParams.set('part', 'contentDetails');
    playlistUrl.searchParams.set('playlistId', uploadsPlaylistId);
    playlistUrl.searchParams.set('maxResults', '50');
    playlistUrl.searchParams.set('key', apiKey);
    if (nextPageToken) {
      playlistUrl.searchParams.set('pageToken', nextPageToken);
    }

    const playlistRes = await fetch(playlistUrl);
    if (!playlistRes.ok) {
      return Response.json({ error: 'YouTube could not read the uploads playlist.' }, { status: 502 });
    }
    const playlistData = await playlistRes.json();

    if (playlistData.items) {
      for (const item of playlistData.items) {
        videoIds.push(item.contentDetails.videoId);
      }
    }

    nextPageToken = playlistData.nextPageToken || null;
  } while (nextPageToken);

  // Store in Netlify Blobs
  const legacyChannel = await store.get(channelTitle, { type: 'json' });
  const channelKey = legacyChannel?.channelId === channelId ? channelTitle : 'channel/' + channelId;
  await store.setJSON(channelKey, {
    channelId,
    channelTitle,
    videoIds,
    updatedAt: new Date().toISOString(),
  });

  return Response.json({
    message: `Stored ${videoIds.length} videos from "${channelTitle}"`,
    channelTitle,
    videoCount: videoIds.length,
  });
}
