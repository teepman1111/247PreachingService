import { getRandomVideo } from './get-random-video.mjs';
import { uploadChannel } from './upload-channel.mjs';
import page from '../public/index.html';

function catalog(bucket) {
  return {
    async list() {
      const blobs = [];
      let cursor;
      do {
        const result = await bucket.list({ cursor });
        blobs.push(...result.objects);
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
    if (pathname === '/') {
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
