import { getStore } from '@netlify/blobs';

export default async (req) => {
  const store = getStore('yt-videos');
  const { blobs } = await store.list();

  if (blobs.length === 0) {
    return Response.json(
      { error: 'No videos found. Please upload a channel first.' },
      { status: 404 }
    );
  }

  // Pick a random channel document
  const randomBlob = blobs[Math.floor(Math.random() * blobs.length)];
  const channelData = await store.get(randomBlob.key, { type: 'json' });

  if (!channelData || !channelData.videoIds || channelData.videoIds.length === 0) {
    return Response.json(
      { error: 'No video IDs found in store.' },
      { status: 404 }
    );
  }

  // Pick a random video from that channel
  const randomVideoId =
    channelData.videoIds[Math.floor(Math.random() * channelData.videoIds.length)];

  return Response.json({
    videoId: randomVideoId,
    url: `https://youtu.be/${randomVideoId}`,
    channel: randomBlob.key,
  });
};

export const config = {
  path: '/api/random-video',
};
