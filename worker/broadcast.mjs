import { individuallyApprovedIds } from './approved-videos.mjs';
import { readPlaybackProgram } from './program.mjs';
import { loadVideoDurations } from './youtube-sources.mjs';

const metadataKey = 'program/broadcast-metadata.json';
const week = 7 * 24 * 60 * 60 * 1000;
const day = 24 * 60 * 60 * 1000;

async function readMetadata(bucket) {
  const object = await bucket.get(metadataKey);
  return object ? { state: await object.json(), etag: object.etag } : { state: { durations: {} }, etag: null };
}

function writeMetadata(bucket, state, etag) {
  return bucket.put(metadataKey, JSON.stringify(state), {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
}

function durationEntry(state, id) {
  return Object.hasOwn(state.durations, id) ? state.durations[id] : undefined;
}

async function prepareDurations(env, ids, state, etag) {
  const now = Date.now();
  if (!env.YOUTUBE_API_KEY || state.lease?.until > now || state.retryAt > now) return state;
  const missing = ids.filter(id => {
    const entry = durationEntry(state, id);
    return !entry || (!entry.seconds && entry.retryAt <= now);
  }).slice(0, 200);
  if (!missing.length) return state;

  state.lease = { until: now + 60000 };
  const locked = await writeMetadata(env.BUCKET, state, etag);
  if (!locked) return (await readMetadata(env.BUCKET)).state;
  try {
    const batches = [];
    for (let offset = 0; offset < missing.length; offset += 50) {
      batches.push(loadVideoDurations(env.YOUTUBE_API_KEY, missing.slice(offset, offset + 50)));
    }
    const measured = new Map((await Promise.all(batches)).flatMap(batch => [...batch]));
    for (const id of missing) {
      const seconds = measured.get(id) ?? 0;
      state.durations[id] = seconds ? { seconds } : { seconds: 0, retryAt: Date.now() + day };
    }
    delete state.retryAt;
  } catch {
    state.retryAt = Date.now() + 60000;
  }
  delete state.lease;
  if (!await writeMetadata(env.BUCKET, state, locked.etag)) return (await readMetadata(env.BUCKET)).state;
  return state;
}

export function currentSlot(slots, anchor, now) {
  const cycle = slots.reduce((total, slot) => total + slot.seconds * 1000, 0);
  if (!cycle) return null;
  let offset = ((now - anchor) % cycle + cycle) % cycle;
  for (const { id, seconds } of slots) {
    const duration = seconds * 1000;
    if (offset < duration) {
      const startsAt = now - offset;
      return { videoId: id, startsAt, endsAt: startsAt + duration };
    }
    offset -= duration;
  }
  return null;
}

export async function broadcastState(env) {
  const { videoIds, selection } = await readPlaybackProgram(env.BUCKET);
  const manual = selection ? [] : await individuallyApprovedIds(env.BUCKET);
  const ids = [...new Set([...videoIds, ...manual])];
  if (!ids.length) return { state: 'empty', topic: selection?.topic ?? null };
  if (!env.YOUTUBE_API_KEY) return { state: 'unavailable', topic: selection?.topic ?? null };

  const { state: cached, etag } = await readMetadata(env.BUCKET);
  const state = await prepareDurations(env, ids, cached, etag);
  if (ids.some(id => !durationEntry(state, id))) {
    return { state: state.retryAt > Date.now() ? 'unavailable' : 'preparing', topic: selection?.topic ?? null };
  }

  const slots = ids.map(id => ({ id, seconds: durationEntry(state, id).seconds })).filter(slot => slot.seconds > 0);
  const serverNow = Date.now();
  // A topic cycle begins when it is published. The all-approved cycle has a
  // fixed epoch so independently arriving viewers resolve the same slot.
  const anchor = selection ? Date.parse(selection.endsAt) - week : 0;
  const slot = currentSlot(slots, anchor, serverNow);
  return slot
    ? { ...slot, state: 'live', serverNow, topic: selection?.topic ?? null }
    : { state: 'empty', topic: selection?.topic ?? null };
}
