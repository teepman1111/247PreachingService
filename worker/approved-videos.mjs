const prefix = 'approved/';
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;

function videoIdFromInput(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (videoIdPattern.test(value)) return value;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    const [, first, second] = url.pathname.split('/');
    let id;
    if (url.hostname === 'youtu.be') id = first;
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
      if (first === 'watch') id = url.searchParams.get('v');
      if (['shorts', 'live', 'embed'].includes(first)) id = second;
    }
    return videoIdPattern.test(id ?? '') ? id : null;
  } catch {
    return null;
  }
}

export async function approvedVideos(request, env) {
  const respond = (body, status = 200) => Response.json(body, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
  if (request.method === 'GET') {
    const videos = [];
    let cursor;
    do {
      const page = await env.BUCKET.list({ prefix, cursor });
      for (const { key, uploaded } of page.objects) {
        videos.push({ id: key.slice(prefix.length), uploaded });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    videos.sort((a, b) => new Date(a.uploaded) - new Date(b.uploaded) || a.id.localeCompare(b.id));
    return respond({ videoIds: videos.map(video => video.id) });
  }

  if (!['POST', 'DELETE'].includes(request.method)) {
    return respond({ error: 'Method not allowed.' }, 405);
  }
  const email = request.headers.get('oai-authenticated-user-email');
  if (!env.SITE_ADMIN_EMAIL || email?.toLowerCase() !== env.SITE_ADMIN_EMAIL.toLowerCase()) {
    return respond({ error: 'Church admin access is required.' }, 403);
  }
  if (request.headers.get('Origin') !== new URL(request.url).origin ||
      !request.headers.get('Content-Type')?.startsWith('application/json')) {
    return respond({ error: 'Submit changes from the church admin page.' }, 403);
  }

  const body = await request.json().catch(() => null);
  const id = videoIdFromInput(body?.video);
  if (!id) return respond({ error: 'Enter a YouTube video link or video ID.' }, 400);
  const key = prefix + id;
  if (request.method === 'DELETE') {
    await env.BUCKET.delete(key);
  } else {
    await env.BUCKET.put(key, 'approved', { onlyIf: { etagDoesNotMatch: '*' } });
  }
  return respond({ id });
}
