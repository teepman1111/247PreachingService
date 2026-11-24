import template from '../public/music.html';
import { brandingStyles, escapeHtml, headingFontLink, readBranding } from './branding.mjs';
import { readChannel } from './program.mjs';
import { videoIdFromInput } from './approved-videos.mjs';

const key = 'program/music.json';
const emptyPlaylist = { title: 'Worship playlist', note: '', songs: [] };
const noStore = { 'Cache-Control': 'no-store' };
const clean = (value, max) => typeof value === 'string' && value.length <= max ? value.trim() : null;

function access(owner, identity, music) {
  if (owner) return 'owner';
  return identity?.email && identity.email === music.directorEmail ? 'director' : null;
}

async function readMusic(bucket) {
  const object = await bucket.get(key);
  return object
    ? { music: await object.json(), revision: object.etag }
    : { music: { draft: emptyPlaylist, published: null, directorEmail: '' }, revision: '' };
}

export async function musicIsPublished(bucket) {
  return (await bucket.head(key))?.customMetadata?.published === 'true';
}

function trackUrl(value, provider) {
  const text = clean(value, 512);
  if (text === '') return '';
  try {
    if (!text) throw new Error();
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error();
    if (provider === 'spotify' && url.hostname === 'open.spotify.com' &&
        /^\/(?:intl-[a-z-]+\/)?track\/[A-Za-z0-9]{22}\/?$/.test(url.pathname)) {
      return 'https://open.spotify.com/track/' + url.pathname.split('/').filter(Boolean).at(-1);
    }
    if (provider === 'apple' && url.hostname === 'music.apple.com' &&
        /^\/[a-z]{2}\/(?:album|song)\/(?:[^/]+\/)?\d+\/?$/i.test(url.pathname)) {
      const songId = url.searchParams.get('i');
      if (url.pathname.split('/')[2].toLowerCase() === 'album' && !/^\d+$/.test(songId ?? '')) throw new Error();
      url.search = songId && /^\d+$/.test(songId) ? '?i=' + songId : '';
      url.hash = '';
      return url.href;
    }
  } catch {}
  throw new Error('Choose a direct ' + (provider === 'spotify' ? 'Spotify' : 'Apple Music') + ' song link.');
}

function validatePlaylist(input) {
  const title = clean(input?.title, 80);
  const note = clean(input?.note, 300);
  if (!title || note === null) throw new Error('Enter a playlist title and keep the note to 300 characters.');
  if (!Array.isArray(input.songs) || input.songs.length > 25) throw new Error('Add up to 25 songs.');
  const songs = input.songs.map((song, index) => {
    try {
      const name = clean(song?.title, 100);
      const artist = clean(song?.artist, 100);
      const youtubeInput = clean(song?.youtube, 512);
      const youtube = youtubeInput ? videoIdFromInput(youtubeInput) : '';
      if (!name || artist === null) throw new Error('Enter a song title and keep the artist to 100 characters.');
      if (youtubeInput === null || youtube === null) throw new Error('Enter a YouTube video link or ID.');
      const spotify = trackUrl(song.spotify, 'spotify');
      const apple = trackUrl(song.apple, 'apple');
      if (!youtube && !spotify && !apple) throw new Error('Add at least one listening link.');
      return { title: name, artist, youtube, spotify, apple };
    } catch (error) {
      throw new Error('Song ' + (index + 1) + '. ' + error.message);
    }
  });
  return { title, note, songs };
}

async function readUpdate(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Choose a playlist update first.');
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 65536) {
      await reader.cancel();
      throw new Error('The playlist update is too large.');
    }
    chunks.push(value);
  }
  return JSON.parse(await new Blob(chunks).text());
}

function editorState(music, revision, role) {
  return {
    role, revision, draft: music.draft, publishedAt: music.published?.at ?? null,
    ...(role === 'owner' ? { directorEmail: music.directorEmail } : {}),
  };
}

export async function musicApi(request, bucket, owner, identity) {
  const respond = (body, status = 200) => Response.json(body, { status, headers: noStore });
  const { music, revision } = await readMusic(bucket);
  const role = access(owner, identity, music);
  if (!role) return respond({ error: 'Music playlist access is required.' }, identity ? 403 : 401);
  if (request.method === 'GET') return respond(editorState(music, revision, role));
  if (request.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);
  if (request.headers.get('Origin') !== new URL(request.url).origin ||
      request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
    return respond({ error: 'Make changes from the playlist editor.' }, 403);
  }
  try {
    const input = await readUpdate(request);
    if (input?.revision !== revision) return respond({ error: 'The playlist changed in another tab. Reload to see the latest version.' }, 409);
    switch (input.action) {
      case 'director': {
        if (role !== 'owner') return respond({ error: 'Only the church owner can grant access.' }, 403);
        const email = clean(input.email, 254)?.toLowerCase();
        if (email === undefined || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
          throw new Error('Enter the email the music director uses to sign in.');
        }
        music.directorEmail = email;
        break;
      }
      case 'save':
      case 'publish':
        music.draft = validatePlaylist(input.playlist);
        if (input.action === 'publish') {
          if (!music.draft.songs.length) throw new Error('Add a song before publishing.');
          music.published = { ...music.draft, at: new Date().toISOString() };
        }
        break;
      case 'unpublish':
        music.published = null;
        break;
      default:
        return respond({ error: 'Choose an available playlist action.' }, 400);
    }
  } catch (error) {
    return respond({ error: error instanceof SyntaxError ? 'Could not read the playlist update.' : error.message }, 400);
  }

  // The nonce changes the storage revision even if an editor submits the same values.
  const saved = await bucket.put(key, JSON.stringify({ ...music, nonce: crypto.randomUUID() }), {
    onlyIf: revision ? { etagMatches: revision } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { published: String(Boolean(music.published)) },
  });
  return saved
    ? respond(editorState(music, saved.etag, role))
    : respond({ error: 'The playlist changed while you were editing. Reload to see the latest version.' }, 409);
}

function songList(songs) {
  return '<ol class="songs">' + songs.map(song => {
    const title = escapeHtml(song.title);
    return `<li class="song">
      <div><h2>${title}</h2>${song.artist ? '<p>' + escapeHtml(song.artist) + '</p>' : ''}</div>
      <div class="song-links">
        ${song.youtube ? `<button type="button" data-video="${song.youtube}" data-name="${title}" aria-label="Open player for ${title}">Play here</button>
        <a href="https://www.youtube.com/watch?v=${song.youtube}" target="_blank" rel="noopener">YouTube</a>` : ''}
        ${song.spotify ? '<a href="' + escapeHtml(song.spotify) + '" target="_blank" rel="noopener">Spotify</a>' : ''}
        ${song.apple ? '<a href="' + escapeHtml(song.apple) + '" target="_blank" rel="noopener">Apple Music</a>' : ''}
      </div>
    </li>`;
  }).join('') + '</ol>';
}

export async function musicPage(request, bucket, base, { manage = false, owner, identity } = {}) {
  const { music } = await readMusic(bucket);
  const role = manage ? access(owner, identity, music) : null;
  if (manage && !role && !identity) {
    return Response.redirect(new URL('/auth/login?return_to=' + encodeURIComponent(base + '/music/manage'), request.url), 303);
  }
  const [channel, branding] = await Promise.all([readChannel(bucket), readBranding(bucket, base)]);
  const published = music.published;
  const title = manage ? 'Manage worship playlist' : published?.title ?? emptyPlaylist.title;
  const note = manage
    ? (role ? 'Prepare songs for your congregation and publish when the list is ready.' : 'Ask your pastor to grant access to the email you use to sign in.')
    : published ? published.note : 'The church hasn’t published a playlist yet.';
  const fragments = {
    'font-link': headingFontLink,
    'title': escapeHtml(title + ' · ' + channel.name),
    'theme': escapeHtml(brandingStyles(branding)),
    'church': escapeHtml(channel.name),
    'logo': branding.logoUrl ? '<img src="' + escapeHtml(branding.logoUrl) + '" alt="">' : '',
    'watch': base + '/watch',
    'link': base + '/music',
    'music-nav': manage ? '<a href="' + base + '/music">Public playlist</a>' : '',
    'mode': manage && role ? 'manage' : 'listen',
    'base': base,
    'heading': escapeHtml(title),
    'note': note ? '<p class="intro">' + escapeHtml(note) + '</p>' : '',
    'songs': !manage && published ? songList(published.songs) : '',
    'editor': manage && role ? '' : ' hidden',
    'owner-fields': role === 'owner' ? '' : ' hidden',
    'access-link': manage && !role
      ? '<a href="/auth/logout">Switch account</a>' : '',
  };
  const html = template.replace(/<!-- music:([\w-]+) -->/g, (_, name) => fragments[name] ?? '');
  return new Response(html, {
    status: manage && !role ? 403 : 200,
    headers: { ...noStore, 'Content-Type': 'text/html; charset=utf-8' },
  });
}
