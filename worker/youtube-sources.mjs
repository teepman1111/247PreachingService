export const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
const playlistIdPattern = /^(?:PL|UU|LL|FL|OLAK5uy_)[A-Za-z0-9_-]{8,140}$/;
const handlePattern = /^@[^@/\s?#]{3,40}$/u;

export function parseSource(input) {
  if (typeof input !== 'string' || input.length > 512) return null;
  let value = input.trim();
  if (value.startsWith('https://')) {
    try {
      const url = new URL(value);
      if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
      const [, first, second] = url.pathname.split('/');
      if (url.searchParams.has('list')) value = url.searchParams.get('list');
      else if (first === 'channel') value = second ?? '';
      else value = decodeURIComponent(first ?? '');
    } catch {
      return null;
    }
  }
  if (channelIdPattern.test(value)) return { type: 'channel', id: value };
  if (playlistIdPattern.test(value)) return { type: 'playlist', id: value };
  if (handlePattern.test(value)) return { type: 'channel', handle: value };
  return null;
}

async function youtube(apiKey, resource, parameters) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + resource);
  url.search = new URLSearchParams({ ...parameters, key: apiKey });
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      throw new Error('YouTube denied the request. Check the API key and quota, then try again.');
    }
    throw new Error('YouTube could not complete this request. Check the source and try again.');
  }
  return response.json();
}

export async function resolveSource(apiKey, source) {
  if (source.type === 'channel') {
    const { items } = await youtube(apiKey, 'channels', {
      part: 'snippet,contentDetails',
      ...(source.handle ? { forHandle: source.handle } : { id: source.id }),
    });
    const channel = items?.[0];
    const playlistId = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (!channel || !playlistId) return null;
    return { key: 'channel:' + channel.id, type: 'channel', title: channel.snippet.title, playlistId };
  }

  const { items } = await youtube(apiKey, 'playlists', { part: 'snippet', id: source.id });
  const playlist = items?.[0];
  if (!playlist) return null;
  return { key: 'playlist:' + playlist.id, type: 'playlist', title: playlist.snippet.title, playlistId: playlist.id };
}

export async function loadSourcePage(apiKey, playlistId, cursor) {
  const page = await youtube(apiKey, 'playlistItems', {
    part: 'contentDetails',
    playlistId,
    maxResults: '50',
    ...(cursor ? { pageToken: cursor } : {}),
  });
  if (!Array.isArray(page.items)) throw new Error('YouTube returned an incomplete playlist page. Try again.');
  const ids = [...new Set(page.items.map(item => item.contentDetails?.videoId).filter(id => videoIdPattern.test(id ?? '')))];
  if (!ids.length) return { ids, titles: {}, cursor: page.nextPageToken ?? null };

  const details = await youtube(apiKey, 'videos', { part: 'status,snippet', id: ids.join(',') });
  if (!Array.isArray(details.items)) throw new Error('YouTube returned incomplete video details. Try again.');
  const eligible = details.items.filter(item => item.status?.embeddable &&
    ['public', 'unlisted'].includes(item.status.privacyStatus));
  const eligibleIds = new Set(eligible.map(item => item.id));
  const titles = Object.fromEntries(eligible.filter(item => typeof item.snippet?.title === 'string')
    .map(item => [item.id, item.snippet.title]));
  return { ids: ids.filter(id => eligibleIds.has(id)), titles, cursor: page.nextPageToken ?? null };
}

export async function loadVideoMetadata(apiKey, ids) {
  const details = await youtube(apiKey, 'videos', { part: 'contentDetails,status,snippet', id: ids.join(',') });
  if (!Array.isArray(details.items)) throw new Error('YouTube returned incomplete video durations.');
  const metadata = new Map();
  for (const item of details.items) {
    if (!item.status?.embeddable || !['public', 'unlisted'].includes(item.status.privacyStatus)) continue;
    const time = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(item.contentDetails?.duration ?? '');
    if (!time) continue;
    const [, days = 0, hours = 0, minutes = 0, seconds = 0] = time;
    const total = Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
    if (total > 0 && Number.isSafeInteger(total)) metadata.set(item.id, { seconds: total, title: item.snippet?.title || '' });
  }
  return metadata;
}
