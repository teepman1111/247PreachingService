import { defaultChannel, validateChannel } from './channel.mjs';
import { individuallyApprovedIds } from './approved-videos.mjs';
import { loadSourcePage, parseSource, resolveSource } from './youtube-sources.mjs';
import { titleMatchesTopic, topicsForTitle } from './title-topics.mjs';

const programKey = 'program/catalog.json';
const week = 7 * 24 * 60 * 60 * 1000;

class ProgramError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function respond(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function readProgram(bucket) {
  const object = await bucket.get(programKey);
  return object
    ? { program: await object.json(), etag: object.etag }
    : { program: { sources: [], selection: null, channel: bucket.channelDefaults ?? defaultChannel }, etag: null };
}

async function changeProgram(bucket, change) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { program, etag } = await readProgram(bucket);
    const result = change(program);
    const saved = await bucket.put(programKey, JSON.stringify(program), {
      onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
    });
    if (saved) return result;
  }
  throw new ProgramError('The catalog changed at the same time. Try again.', 409);
}

function catalog(program) {
  const videos = new Map();
  for (const source of program.sources) {
    for (const id of source.videoIds) {
      const previous = videos.get(id);
      const title = source.titles && Object.hasOwn(source.titles, id) ? source.titles[id] : '';
      if (!previous || (title && (!previous.title || source.syncedAt >= previous.syncedAt))) {
        videos.set(id, { title, syncedAt: source.syncedAt });
      }
    }
  }
  return videos;
}

function currentSelection(program) {
  return program.selection && Date.parse(program.selection.endsAt) > Date.now() ? program.selection : null;
}

function describeProgram(program, env) {
  const videos = catalog(program);
  const counts = new Map();
  let matched = 0;
  let titlesAvailable = 0;
  for (const { title } of videos.values()) {
    if (!title) continue;
    titlesAvailable++;
    const tags = topicsForTitle(title);
    if (tags.length) matched++;
    for (const topic of tags) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  return {
    sources: program.sources.map(({ key, type, title, videoIds, titles, syncedAt, pending }) => ({
      key, type, title, syncedAt, syncing: Boolean(pending),
      total: videoIds.length,
      needsTitleSync: Boolean(videoIds.length && !titles),
    })),
    total: videos.size,
    matched,
    titlesAvailable,
    topics: [...counts].map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    channel: program.channel ?? defaultChannel,
    channelRevision: program.channelRevision ?? null,
    selection: currentSelection(program),
    youtubeConfigured: Boolean(env.YOUTUBE_API_KEY),
  };
}

async function addSource(env, input) {
  const parsed = parseSource(input);
  if (!parsed) throw new ProgramError('Enter a YouTube channel or playlist link, ID, or @handle.', 400);
  const source = await resolveSource(env.YOUTUBE_API_KEY, parsed);
  if (!source) throw new ProgramError('YouTube could not find that channel or playlist.', 404);
  return changeProgram(env.BUCKET, program => {
    if (!program.sources.some(item => item.key === source.key)) {
      if (env.BUCKET.channelDefaults && program.sources.length >= 10) {
        throw new ProgramError('This channel can have up to 10 approved YouTube sources.', 409);
      }
      program.sources.push({ ...source, videoIds: [], syncedAt: null, pending: null, revision: crypto.randomUUID() });
    }
    return { key: source.key };
  });
}

async function syncSource(env, key) {
  const { program } = await readProgram(env.BUCKET);
  const source = program.sources.find(item => item.key === key);
  if (!source) throw new ProgramError('That source is no longer approved.', 404);
  // Restart a pre-title partial import so every page contributes its titles.
  const pending = source.pending?.titles ? source.pending : null;
  const page = await loadSourcePage(env.YOUTUBE_API_KEY, source.playlistId, pending?.cursor);
  return changeProgram(env.BUCKET, latest => {
    const current = latest.sources.find(item => item.key === key);
    if (!current || current.revision !== source.revision) {
      throw new ProgramError('This source changed during the import. Try syncing it again.', 409);
    }
    const videoIds = [...new Set([...(pending?.videoIds ?? []), ...page.ids])];
    const titles = { ...pending?.titles, ...page.titles };
    current.revision = crypto.randomUUID();
    const sourceLimit = env.BUCKET.channelDefaults ? 200 : Infinity;
    if (page.cursor && videoIds.length < sourceLimit) {
      current.pending = { cursor: page.cursor, videoIds, titles };
    } else {
      current.pending = null;
      current.videoIds = videoIds.slice(0, sourceLimit);
      current.titles = Object.fromEntries(current.videoIds.map(id => [id, titles[id]]));
      current.syncedAt = new Date().toISOString();
    }
    return { more: Boolean(current.pending), total: Math.min(videoIds.length, sourceLimit) };
  });
}

export async function readChannel(bucket) {
  const { program } = await readProgram(bucket);
  return program.channel ?? defaultChannel;
}

export async function readPlaybackProgram(bucket) {
  const { program } = await readProgram(bucket);
  const selection = currentSelection(program);
  const videos = catalog(program);
  return {
    selection,
    channel: program.channel ?? defaultChannel,
    excluded: program.excluded ?? [],
    titles: Object.fromEntries([...videos].map(([id, { title }]) => [id, title])),
    videoIds: selection
      ? [...videos].filter(([, { title }]) => titleMatchesTopic(title, selection.topic)).map(([id]) => id)
      : [...videos.keys()],
  };
}

export async function programRequest(request, env, action) {
  if (action === 'summary' && request.method === 'GET') {
    const { program } = await readProgram(env.BUCKET);
    const videos = catalog(program);
    for (const id of await individuallyApprovedIds(env.BUCKET)) {
      if (!videos.has(id)) videos.set(id, { title: '' });
    }
    return respond({
      ...describeProgram(program, env),
      excluded: program.excluded ?? [],
      videos: [...videos].map(([id, { title }]) => ({ id, title })),
    });
  }
  if (request.method !== 'POST' || action === 'summary') return respond({ error: 'Method not allowed.' }, 405);
  if (request.headers.get('Origin') !== new URL(request.url).origin ||
      request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
    return respond({ error: 'Submit changes from the church admin page.' }, 403);
  }
  if (Number(request.headers.get('Content-Length')) > 65536) return respond({ error: 'Request is too large.' }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return respond({ error: 'Invalid request.' }, 400);
  }
  if (!body || typeof body !== 'object') return respond({ error: 'Invalid request.' }, 400);

  try {
    switch (action) {
      case 'add-source':
      case 'sync-source':
        if (!env.YOUTUBE_API_KEY) throw new ProgramError('Configure YOUTUBE_API_KEY in Sites to import YouTube sources.', 503);
        return respond(await (action === 'add-source' ? addSource(env, body.source) : syncSource(env, body.key)));
      case 'cancel-sync':
      case 'remove-source':
        return respond(await changeProgram(env.BUCKET, program => {
          if (action === 'remove-source') {
            program.sources = program.sources.filter(source => source.key !== body.key);
          } else {
            const source = program.sources.find(source => source.key === body.key);
            if (source) {
              source.pending = null;
              source.revision = crypto.randomUUID();
            }
          }
          return { ok: true };
        }));
      case 'set-video-availability': {
        const manual = await individuallyApprovedIds(env.BUCKET);
        return respond(await changeProgram(env.BUCKET, program => {
          if (typeof body.excluded !== 'boolean' || (!manual.includes(body.id) && !catalog(program).has(body.id))) {
            throw new ProgramError('Choose an approved video.', 400);
          }
          const excluded = new Set(program.excluded ?? []);
          if (body.excluded) excluded.add(body.id);
          else excluded.delete(body.id);
          program.excluded = [...excluded];
          return { ok: true };
        }));
      }
      case 'save-channel': {
        const manual = await individuallyApprovedIds(env.BUCKET);
        return respond(await changeProgram(env.BUCKET, program => {
          if (body.revision !== (program.channelRevision ?? null)) {
            throw new ProgramError('Channel settings changed. Reload Programming and try again.', 409);
          }
          try {
            program.channel = validateChannel(body, new Set([...manual, ...catalog(program).keys()]));
          } catch (error) {
            throw new ProgramError(error.message, 400);
          }
          program.channelRevision = crypto.randomUUID();
          return { channel: program.channel, channelRevision: program.channelRevision };
        }));
      }
      case 'publish':
        return respond(await changeProgram(env.BUCKET, program => {
          if (body.topic === null) {
            program.selection = null;
            return { selection: null };
          }
          if (![...catalog(program).values()].some(({ title }) => titleMatchesTopic(title, body.topic))) {
            throw new ProgramError('This topic has no matching videos from approved sources.', 409);
          }
          const selection = { topic: body.topic, endsAt: new Date(Date.now() + week).toISOString() };
          program.selection = selection;
          return { selection };
        }));
      default:
        return respond({ error: 'Not found.' }, 404);
    }
  } catch (error) {
    if (error instanceof ProgramError) return respond({ error: error.message }, error.status);
    // External failures can include a credential-bearing URL in the original error.
    return respond({ error: error instanceof TypeError || error.name === 'TimeoutError'
      ? 'An upstream service could not respond. Try again.'
      : error.message.startsWith('YouTube ')
        ? error.message : 'Could not update the program. Try again.' }, 502);
  }
}
