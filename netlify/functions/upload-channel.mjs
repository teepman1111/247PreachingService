import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'POST required' }, { status: 405 });
  }

  const apiKey = Netlify.env.get('YOUTUBE_API_KEY');
  if (!apiKey) {
    return Response.json(
      { error: 'YOUTUBE_API_KEY environment variable is not set.' },
      { status: 500 }
    );
  }

  const { channelId } = await req.json();
  if (!channelId) {
    return Response.json(
      { error: 'channelId is required in the request body.' },
      { status: 400 }
    );
  }

  // Fetch channel details from YouTube API
  const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
  channelUrl.searchParams.set('part', 'snippet,contentDetails');
  channelUrl.searchParams.set('id', channelId);
  channelUrl.searchParams.set('key', apiKey);

  const channelRes = await fetch(channelUrl);
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
    const playlistData = await playlistRes.json();

    if (playlistData.items) {
      for (const item of playlistData.items) {
        videoIds.push(item.contentDetails.videoId);
      }
    }

    nextPageToken = playlistData.nextPageToken || null;
  } while (nextPageToken);

  // Store in Netlify Blobs
  const store = getStore('yt-videos');
  await store.setJSON(channelTitle, {
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
};

export const config = {
  path: '/api/upload-channel',
  method: 'POST',
};
