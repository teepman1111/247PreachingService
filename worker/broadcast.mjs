import { individuallyApprovedIds } from './approved-videos.mjs';
import { readPlaybackProgram } from './program.mjs';
import { weeklyAirings } from './channel.mjs';
import { loadVideoMetadata } from './youtube-sources.mjs';

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
    return !entry || (entry.retryAt ?? 0) <= now;
  }).sort((a, b) => Number(Boolean(durationEntry(state, a))) - Number(Boolean(durationEntry(state, b)))).slice(0, 200);
  if (!missing.length) return state;

  state.lease = { until: now + 60000 };
  const locked = await writeMetadata(env.BUCKET, state, etag);
  if (!locked) return (await readMetadata(env.BUCKET)).state;
  try {
    const batches = [];
    for (let offset = 0; offset < missing.length; offset += 50) {
      batches.push(loadVideoMetadata(env.YOUTUBE_API_KEY, missing.slice(offset, offset + 50)));
    }
    const measured = new Map((await Promise.all(batches)).flatMap(batch => [...batch]));
    for (const id of missing) {
      const video = measured.get(id) ?? { seconds: 0 };
      state.durations[id] = { ...video, retryAt: Date.now() + (video.seconds ? week : day) };
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

function describe(slot, titles, state) {
  return {
    ...slot,
    title: slot.title || titles[slot.videoId] || durationEntry(state, slot.videoId)?.title || 'Sermon',
  };
}

export function buildGuide({ slots, airings, anchor, now, durations }) {
  function at(instant) {
    const nextAiring = airings.find(airing => airing.startsAt > instant);
    const latest = airings.findLast(airing => airing.startsAt <= instant);
    const stop = nextAiring?.startsAt ?? Infinity;
    const latestEnd = latest ? latest.startsAt + durations[latest.videoId].seconds * 1000 : -Infinity;
    if (latestEnd > instant) return { ...latest, endsAt: Math.min(latestEnd, stop) };
    const rotation = currentSlot(slots, Math.max(anchor, latestEnd), instant);
    return rotation ? { ...rotation, endsAt: Math.min(rotation.endsAt, stop) } : null;
  }

  const current = at(now);
  return { current, next: current && at(current.endsAt) };
}

export async function broadcastState(env) {
  const { videoIds, selection, channel, titles, excluded } = await readPlaybackProgram(env.BUCKET);
  const manual = await individuallyApprovedIds(env.BUCKET);
  const removed = new Set(excluded);
  const approved = new Set([...Object.keys(titles), ...manual].filter(id => !removed.has(id)));
  const rotationIds = [...new Set([...videoIds, ...(selection ? [] : manual)])].filter(id => approved.has(id));
  const { slots: configured, ...branding } = channel;
  const schedule = configured.filter(slot => approved.has(slot.videoId));
  const ids = [...new Set([...schedule.map(slot => slot.videoId), ...rotationIds, ...approved])];
  const base = { channel: branding, topic: selection?.topic ?? null };
  if (!ids.length) return { ...base, state: 'empty' };
  if (!env.YOUTUBE_API_KEY) return { ...base, state: 'unavailable' };

  const { state: cached, etag } = await readMetadata(env.BUCKET);
  const state = await prepareDurations(env, ids, cached, etag);
  const playable = id => durationEntry(state, id)?.seconds > 0;
  const slots = rotationIds.filter(playable).map(id => ({ id, seconds: durationEntry(state, id).seconds }));
  if (!slots.length) {
    slots.push(...ids.filter(playable).map(id => ({ id, seconds: durationEntry(state, id).seconds })));
  }
  const serverNow = Date.now();
  const airings = weeklyAirings({ ...channel, slots: schedule.filter(slot => playable(slot.videoId)) }, serverNow);
  const anchor = selection ? Date.parse(selection.endsAt) - week : 0;
  const { current, next } = buildGuide({ slots, airings, anchor, now: serverNow, durations: state.durations });
  const upcoming = airings.filter(airing => airing.startsAt > serverNow).slice(0, 7)
    .map(airing => describe(airing, titles, state));
  if (!current) {
    const pending = ids.some(id => !durationEntry(state, id));
    return { ...base, upcoming, state: pending ? (state.retryAt > serverNow ? 'unavailable' : 'preparing') : 'empty' };
  }

  const fallback = [...new Set([next?.videoId, ...rotationIds, ...ids])]
    .filter(id => id && id !== current.videoId && playable(id)).slice(0, 5)
    .map(videoId => describe({ videoId }, titles, state));
  return {
    ...base, ...describe(current, titles, state), state: 'live', serverNow,
    next: next && describe(next, titles, state), upcoming, fallback,
  };
}
