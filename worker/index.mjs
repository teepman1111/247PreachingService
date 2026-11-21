import { broadcastState } from './broadcast.mjs';
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

function isOwner(request, env) {
  const id = request.headers.get('oai-authenticated-user-id');
  const email = request.headers.get('oai-authenticated-user-email');
  return Boolean(id && env.SITE_ADMIN_EMAIL && email?.toLowerCase() === env.SITE_ADMIN_EMAIL.toLowerCase());
}

function pageResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/assets/sanctuary.webp' && request.method === 'GET') {
      return new Response(sanctuaryArt, {
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=3600' },
      });
    }
    if (pathname === '/watch/' && request.method === 'GET') return Response.redirect(new URL('/watch', request.url), 308);
    if (pathname === '/watch' && request.method === 'GET') {
      return pageResponse(page.replace('<main>', '<main class="public-watch">')
        .replace('class="brand" href="/"', 'class="brand" href="/watch"'));
    }
    if (pathname === '/api/broadcast' && request.method === 'GET') {
      return Response.json(await broadcastState(env), { headers: { 'Cache-Control': 'no-store' } });
    }

    if (!isOwner(request, env)) {
      if (pathname === '/' || pathname === '/signage') {
        const message = request.headers.has('oai-authenticated-user-id')
          ? 'This page is for the site owner. Use the Watch link to join the broadcast.'
          : '<a href="/signin-with-chatgpt?return_to=' + encodeURIComponent(pathname) + '" target="_top">Sign in with ChatGPT</a> to access this page.';
        return pageResponse('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>24/7 Preaching</title><main><h1>24/7 Preaching</h1><p>' + message + '</p><a href="/watch">Watch the broadcast</a></main></html>', 403);
      }
      return Response.json({ error: 'Church admin access is required.' }, {
        status: 403, headers: { 'Cache-Control': 'no-store' },
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

    if ((pathname === '/' || pathname === '/signage') && request.method === 'GET') return pageResponse(page);

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
