export async function getRandomVideo(req, store) {
  const query = new URL(req.url).searchParams;
  const previous = query.get('previous');
  const skipped = new Set(query.getAll('skip'));
  let replay;

  const { blobs } = await store.list();
  // Sample channels without replacement so an empty or exhausted channel
  // does not stop playback when another channel still has videos.
  while (blobs.length) {
    const index = Math.floor(Math.random() * blobs.length);
    const [blob] = blobs.splice(index, 1);
    const channel = await store.get(blob.key, { type: 'json' });
    const videoIds = channel?.videoIds ?? [];
    const channelTitle = channel?.channelTitle ?? blob.key;
    const candidates = videoIds.filter(id => id !== previous && !skipped.has(id));

    if (candidates.length) {
      const videoId = candidates[Math.floor(Math.random() * candidates.length)];
      return Response.json({ videoId, url: `https://youtu.be/${videoId}`, channel: channelTitle });
    }

    if (previous && !skipped.has(previous) && videoIds.includes(previous)) {
      replay = { videoId: previous, url: `https://youtu.be/${previous}`, channel: channelTitle };
    }
  }

  if (replay) return Response.json(replay);
  return Response.json(
    { error: 'No available videos. Add a channel or select Next Video to retry.' },
    { status: 404 },
  );
}
