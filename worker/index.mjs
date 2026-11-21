import { getRandomVideo } from './get-random-video.mjs';
import { uploadChannel } from './upload-channel.mjs';
import page from '../public/church.html';
import sanctuaryArt from '../public/assets/sanctuary.webp';
import { programRequest, readPlaybackProgram } from './program.mjs';
import { approvedVideos, individuallyApprovedIds } from './approved-videos.mjs';

function catalog(bucket) {
  return {
    async list() {
      const blobs = [];
      let cursor;
      do {
        const result = await bucket.list({ cursor });
        blobs.push(...result.objects.filter(object => !object.key.startsWith('approved/') && !object.key.startsWith('program/')));
        cursor = result.truncated ? result.cursor : undefined;
      } while (cursor);
      return { blobs };
    },
    async get(key) {
      const object = await bucket.get(key);
      return object ? object.json() : null;
    },
    async setJSON(key, value) {
      await bucket.put(key, JSON.stringify(value), {
        httpMetadata: { contentType: 'application/json' },
      });
    },
  };
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/assets/sanctuary.webp' && request.method === 'GET') {
      return new Response(sanctuaryArt, {
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=3600' },
      });
    }
    if (pathname === '/api/playback' && request.method === 'GET') {
      const { videoIds, selection } = await readPlaybackProgram(env.BUCKET);
      const manual = selection ? [] : await individuallyApprovedIds(env.BUCKET);
      return Response.json({ videoIds: [...new Set([...videoIds, ...manual])], selection }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (pathname.startsWith('/api/program/')) {
      return programRequest(request, env, pathname.slice('/api/program/'.length));
    }
    if (pathname === '/api/approved-videos') return approvedVideos(request, env);

    if (['/', '/watch', '/signage'].includes(pathname)) {
      return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (pathname === '/api/random-video') {
      return getRandomVideo(request, catalog(env.BUCKET));
    }

    if (pathname === '/api/upload-channel') {
      return uploadChannel(request, {
        store: catalog(env.BUCKET),
        adminToken: env.ADMIN_TOKEN,
        apiKey: env.YOUTUBE_API_KEY,
        timingSafeEqual: (left, right) => crypto.subtle.timingSafeEqual(left, right),
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
