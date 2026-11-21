import { loadSourcePage, parseSource, resolveSource } from './youtube-sources.mjs';
import { captionsConfigured, readYouTubeTranscript } from './youtube-captions.mjs';
import { classifyTranscript, topics, transcriptHash } from './transcript-topics.mjs';

const programKey = 'program/catalog.json';
const week = 7 * 24 * 60 * 60 * 1000;
const maxTranscript = 350000;
const captionLeaseTime = 3 * 60 * 1000;

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
    : { program: { sources: [], analyses: {}, selection: null }, etag: null };
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

function catalogIds(program) {
  return new Set(program.sources.flatMap(source => source.videoIds));
}

function analysisFor(program, id) {
  return Object.hasOwn(program.analyses, id) ? program.analyses[id] : undefined;
}

function captionCheckFor(program, id) {
  return program.captionChecks && Object.hasOwn(program.captionChecks, id) ? program.captionChecks[id] : undefined;
}

function currentSelection(program) {
  return program.selection && Date.parse(program.selection.endsAt) > Date.now() ? program.selection : null;
}

function describeProgram(program, env) {
  const ids = catalogIds(program);
  const counts = new Map();
  let analyzed = 0;
  let unavailable = 0;
  for (const id of ids) {
    const analysis = analysisFor(program, id);
    if (!analysis) {
      if (captionCheckFor(program, id)?.retryAt > Date.now()) unavailable++;
      continue;
    }
    analyzed++;
    for (const topic of analysis.tags) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  return {
    sources: program.sources.map(({ key, type, title, videoIds, syncedAt, pending }) => ({
      key, type, title, syncedAt, syncing: Boolean(pending),
      total: videoIds.length,
      analyzed: videoIds.filter(id => Object.hasOwn(program.analyses, id)).length,
    })),
    total: ids.size,
    analyzed,
    unavailable,
    captionsConfigured: captionsConfigured(env),
    topics: [...counts].map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    selection: currentSelection(program),
    youtubeConfigured: Boolean(env.YOUTUBE_API_KEY),
    aiConfigured: Boolean(env.OPENAI_API_KEY),
  };
}

async function addSource(env, input) {
  const parsed = parseSource(input);
  if (!parsed) throw new ProgramError('Enter a YouTube channel or playlist link, ID, or @handle.', 400);
  const source = await resolveSource(env.YOUTUBE_API_KEY, parsed);
  if (!source) throw new ProgramError('YouTube could not find that channel or playlist.', 404);
  return changeProgram(env.BUCKET, program => {
    if (!program.sources.some(item => item.key === source.key)) {
      program.sources.push({ ...source, videoIds: [], syncedAt: null, pending: null, revision: crypto.randomUUID() });
    }
    return { key: source.key };
  });
}

async function syncSource(env, key) {
  const { program } = await readProgram(env.BUCKET);
  const source = program.sources.find(item => item.key === key);
  if (!source) throw new ProgramError('That source is no longer approved.', 404);
  const page = await loadSourcePage(env.YOUTUBE_API_KEY, source.playlistId, source.pending?.cursor);
  return changeProgram(env.BUCKET, latest => {
    const current = latest.sources.find(item => item.key === key);
    if (!current || current.revision !== source.revision) {
      throw new ProgramError('This source changed during the import. Try syncing it again.', 409);
    }
    const videoIds = [...new Set([...(current.pending?.videoIds ?? []), ...page.ids])];
    current.revision = crypto.randomUUID();
    if (page.cursor) {
      current.pending = { cursor: page.cursor, videoIds };
    } else {
      current.pending = null;
      current.videoIds = videoIds;
      current.syncedAt = new Date().toISOString();
    }
    return { more: Boolean(page.cursor), total: videoIds.length };
  });
}

async function indexNextCaption(env, retryUnavailable) {
  const bucket = env.BUCKET;
  const { program } = await readProgram(bucket);
  const nextId = current => [...catalogIds(current)].find(id =>
    !analysisFor(current, id) && !(captionCheckFor(current, id)?.retryAt > Date.now()));
  if (!retryUnavailable && !nextId(program)) return { outcome: 'done' };

  const claim = crypto.randomUUID();
  const id = await changeProgram(bucket, latest => {
    const now = Date.now();
    if (latest.captionLease?.expiresAt > now) {
      throw new ProgramError('Caption indexing is already running. Try again in a moment.', 409);
    }
    if (retryUnavailable) latest.captionChecks = {};
    const pendingId = nextId(latest);
    if (pendingId) latest.captionLease = { claim, expiresAt: now + captionLeaseTime };
    return pendingId;
  });
  if (!id) return { outcome: 'done' };

  try {
    const result = await readYouTubeTranscript(env, id);
    const transcript = result.transcript;
    const analysis = transcript && transcript.length <= maxTranscript ? {
      hash: await transcriptHash(transcript),
      tags: await classifyTranscript(env.OPENAI_API_KEY, transcript),
    } : null;
    return await changeProgram(bucket, latest => {
      if (latest.captionLease?.claim !== claim) {
        throw new ProgramError('Caption indexing moved to another request. Resume indexing to continue.', 409);
      }
      delete latest.captionLease;
      if (!catalogIds(latest).has(id) || analysisFor(latest, id)) return { outcome: 'skipped' };
      if (analysis) {
        latest.analyses[id] = analysis;
        return { outcome: 'indexed' };
      }
      latest.captionChecks ??= {};
      latest.captionChecks[id] = { reason: result.reason ?? 'too-long', retryAt: Date.now() + week };
      return { outcome: 'unavailable' };
    });
  } catch (error) {
    // A failed provider call leaves the video queued for retry. The lease also expires if the request is interrupted.
    await changeProgram(bucket, latest => {
      if (latest.captionLease?.claim === claim) delete latest.captionLease;
    }).catch(() => {});
    throw error;
  }
}

export async function readPlaybackProgram(bucket) {
  const { program } = await readProgram(bucket);
  const selection = currentSelection(program);
  const ids = [...catalogIds(program)];
  return {
    selection,
    videoIds: selection ? ids.filter(id => analysisFor(program, id)?.tags.includes(selection.topic)) : ids,
  };
}

export async function programRequest(request, env, action) {
  const email = request.headers.get('oai-authenticated-user-email');
  if (!env.SITE_ADMIN_EMAIL || email?.toLowerCase() !== env.SITE_ADMIN_EMAIL.toLowerCase()) {
    return respond({ error: 'Church admin access is required.' }, 403);
  }
  if (action === 'summary' && request.method === 'GET') {
    return respond(describeProgram((await readProgram(env.BUCKET)).program, env));
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
      case 'index-next':
        if (!env.OPENAI_API_KEY) throw new ProgramError('Configure OPENAI_API_KEY in Sites to index topics.', 503);
        if (!captionsConfigured(env)) throw new ProgramError('Connect a YouTube account with caption access to index topics.', 503);
        return respond(await indexNextCaption(env, body.retryUnavailable === true));
      case 'publish':
        return respond(await changeProgram(env.BUCKET, program => {
          if (body.topic === null) {
            program.selection = null;
            return { selection: null };
          }
          if (!topics.includes(body.topic) ||
              ![...catalogIds(program)].some(id => analysisFor(program, id)?.tags.includes(body.topic))) {
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
      : error.message.startsWith('YouTube ') || error.message.startsWith('AI topic analysis ')
        ? error.message : 'Could not update the program. Try again.' }, 502);
  }
}
