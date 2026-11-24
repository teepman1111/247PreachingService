import { musicApi, musicIsPublished, musicPage } from './music.mjs';
import { brandingRequest, brandingStyles, customPalette, escapeHtml, logoResponse, readBranding } from './branding.mjs';
import { invitation, pilotEvent, pilotReport } from './pilot.mjs';
import { broadcastState } from './broadcast.mjs';
import { getRandomVideo } from './get-random-video.mjs';
import { uploadChannel } from './upload-channel.mjs';
import { pastorDashboard } from './dashboard.mjs';
import { accountId, createTenant, findTenant, resolveTenant, tenantBase, tenantBucket, tenantId } from './tenants.mjs';
import page from '../public/church.html';
import sanctuaryArt from '../public/assets/sanctuary.webp';
import { programRequest, readPlaybackProgram } from './program.mjs';
import { approvedVideos, individuallyApprovedIds } from './approved-videos.mjs';

const noStore = { 'Cache-Control': 'no-store' };
const broadcastCache = new Map();

function catalog(bucket) {
  return {
    async list() {
      const blobs = [];
      let cursor;
      do {
        const result = await bucket.list({ cursor });
        blobs.push(...result.objects.filter(object =>
          !['approved/', 'program/', 'channels/'].some(prefix => object.key.startsWith(prefix))));
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

function legacyOwner(request, env, account) {
  const email = request.headers.get('oai-authenticated-user-email');
  return Boolean(account && env.SITE_ADMIN_EMAIL && email?.toLowerCase() === env.SITE_ADMIN_EMAIL.toLowerCase());
}

function pageResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { ...noStore, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function channelPage(mode, base, branding, hasMusic) {
  const attributes = mode === 'watch' ? ' class="public-watch' +
    (customPalette(branding) ? ' customized-watch' : '') + '" style="' + escapeHtml(brandingStyles(branding)) + '"' : '';
  const branded = page.replace('<main>', '<main' + attributes + ' data-channel-base="' + base + '" data-mode="' + mode + '">')
    .replace(/href="\/(watch|signage|invite|programming|music\/manage)"/g, (_, path) => 'href="' + base + '/' + path + '"');
  return pageResponse(mode === 'watch'
    ? branded.replace('class="brand" href="/"', 'class="brand" href="' + base + '/watch"')
      .replace('<!-- church-logo -->', branding.logoUrl
        ? '<img class="church-logo" src="' + escapeHtml(branding.logoUrl) + '" alt="">' : '')
      .replace('<!-- church-tagline -->', () => escapeHtml(branding.tagline))
      .replace('<!-- public-music-link -->', hasMusic ? '<a class="music-link" href="' + base + '/music">Worship playlist</a>' : '')
    : branded);
}

function authRequired(request, account) {
  if (!account) {
    const returnPath = new URL(request.url).pathname;
    return Response.redirect(new URL('/signin-with-chatgpt?return_to=' + encodeURIComponent(returnPath), request.url), 303);
  }
  return pageResponse('<!doctype html><html lang="en"><meta charset="utf-8"><title>Church programming</title><main><h1>Church administrator access required</h1><a href="/">Return to the pastor dashboard</a></main></html>', 403);
}

function notFound() {
  return new Response('Channel or page not found.', { status: 404, headers: noStore });
}

async function onAir(env, base) {
  if (!base) return broadcastState(env);
  const now = Date.now();
  let cached = broadcastCache.get(base);
  if (!cached || cached.expires <= now) {
    if (broadcastCache.size >= 128) broadcastCache.delete(broadcastCache.keys().next().value);
    cached = { expires: now + 5000, result: broadcastState(env) };
    broadcastCache.set(base, cached);
  }
  try {
    let result = await cached.result;
    if (result.state === 'live' && result.endsAt <= Date.now()) {
      broadcastCache.delete(base);
      result = await broadcastState(env);
    }
    return result.state === 'live' ? { ...result, serverNow: Date.now() } : result;
  } catch (error) {
    if (broadcastCache.get(base) === cached) broadcastCache.delete(base);
    throw error;
  }
}

async function channelRequest(request, env, { path, base, authorized, account }) {
  const { method } = request;
  if ((path === '/watch/' || (base && path === '/')) && method === 'GET') {
    return Response.redirect(new URL(base + '/watch', request.url), 308);
  }
  if (path === '/watch' && method === 'GET') {
    const [branding, hasMusic] = await Promise.all([readBranding(env.BUCKET, base), musicIsPublished(env.BUCKET)]);
    return channelPage('watch', base, branding, hasMusic);
  }
  if (['/music', '/music/manage'].includes(path) && method === 'GET') {
    return musicPage(request, env.BUCKET, base, { manage: path === '/music/manage', owner: authorized, account });
  }
  if (path === '/api/music') return musicApi(request, env.BUCKET, authorized, account);
  if (path === '/logo' && method === 'GET') return logoResponse(request, env.BUCKET);
  if (path === '/api/pilot/event' && method === 'POST') return pilotEvent(request, env);
  if (path === '/api/broadcast' && method === 'GET') {
    return Response.json(await onAir(env, base), { headers: noStore });
  }

  if (!authorized) {
    if (['/programming', '/signage', '/invite'].includes(path) && method === 'GET') return authRequired(request, account);
    return Response.json({ error: 'Church admin access is required.' }, { status: 403, headers: noStore });
  }

  if (path === '/invite' && method === 'GET') return invitation(request, env, base);
  if (path === '/api/program/branding') return brandingRequest(request, env.BUCKET, base);
  if (path === '/api/pilot/report' && method === 'GET') return pilotReport(env);
  if (path === '/api/playback' && method === 'GET') {
    const { videoIds, selection, excluded } = await readPlaybackProgram(env.BUCKET);
    const manual = selection ? [] : await individuallyApprovedIds(env.BUCKET);
    return Response.json({ videoIds: [...new Set([...videoIds, ...manual])].filter(id => !excluded.includes(id)), selection }, {
      headers: noStore,
    });
  }
  if (path.startsWith('/api/program/') || path === '/api/approved-videos') {
    const response = path === '/api/approved-videos'
      ? await approvedVideos(request, env)
      : await programRequest(request, env, path.slice('/api/program/'.length));
    if (method !== 'GET' && response.ok) broadcastCache.delete(base);
    return response;
  }
  if ((path === '/programming' || path === '/signage') && method === 'GET') return channelPage(path.slice(1), base);

  // These endpoints serve the original single-channel pilot.
  if (!base && path === '/api/random-video') return getRandomVideo(request, catalog(env.BUCKET));
  if (!base && path === '/api/upload-channel') {
    return uploadChannel(request, {
      store: catalog(env.BUCKET),
      adminToken: env.ADMIN_TOKEN,
      apiKey: env.YOUTUBE_API_KEY,
      timingSafeEqual: (left, right) => crypto.subtle.timingSafeEqual(left, right),
    });
  }
  return notFound();
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/assets/sanctuary.webp' && request.method === 'GET') {
      return new Response(sanctuaryArt, {
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=3600' },
      });
    }
    const account = accountId(request);
    const originalOwner = legacyOwner(request, env, account);
    if (pathname === '/' && request.method === 'GET') {
      const tenant = account ? await findTenant(env.BUCKET, await tenantId(account)) : null;
      return pageResponse(pastorDashboard(account, tenant, originalOwner));
    }
    if (pathname === '/api/channels' && request.method === 'POST') return createTenant(request, env.BUCKET, account);
    if (pathname.startsWith('/c/')) {
      const route = await resolveTenant(env.BUCKET, pathname);
      if (!route) return notFound();
      const { tenant, path } = route;
      const base = tenantBase(tenant);
      const authorized = account && tenant.id === await tenantId(account);
      return channelRequest(request, { ...env, BUCKET: tenantBucket(env.BUCKET, tenant) }, { path, base, authorized, account });
    }
    return channelRequest(request, env, { path: pathname, base: '', authorized: originalOwner, account });
  },
};
