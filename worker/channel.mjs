import { videoIdPattern } from './youtube-sources.mjs';

export const defaultChannel = {
  name: '24/7 Preaching', timeZone: 'America/Chicago', slots: [], prayerUrl: '',
};

function field(value, limit) {
  if (typeof value !== 'string' || value.length > limit) throw new Error('Check the length of the channel fields.');
  return value.trim();
}

function link(value) {
  const text = field(value, 1024);
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {}
  throw new Error('Enter an HTTPS link.');
}

export function validateChannel(input, approved) {
  const name = field(input.name, 80);
  if (!name) throw new Error('Enter a channel name.');
  const timeZone = field(input.timeZone, 80);
  if (!timeZone || /^[+-]/.test(timeZone)) throw new Error('Enter an IANA time zone, such as America/Chicago.');
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw new Error('Enter an IANA time zone, such as America/Chicago.');
  }
  if (!Array.isArray(input.slots) || input.slots.length > 28) throw new Error('Add up to 28 weekly airings.');
  const times = new Set();
  const slots = input.slots.map(slot => {
    if (!slot || typeof slot.videoId !== 'string' || !videoIdPattern.test(slot.videoId) || !approved.has(slot.videoId)) {
      throw new Error('Choose an approved video for each airing.');
    }
    if (!Number.isInteger(slot.day) || slot.day < 0 || slot.day > 6 ||
        typeof slot.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.time)) {
      throw new Error('Choose a day and time for each airing.');
    }
    const key = slot.day + ':' + slot.time;
    if (times.has(key)) throw new Error('Choose a different time for each airing.');
    times.add(key);
    return {
      day: slot.day, time: slot.time, videoId: slot.videoId, title: field(slot.title, 160),
      speaker: field(slot.speaker, 100), scripture: field(slot.scripture, 100), notesUrl: link(slot.notesUrl),
    };
  });
  return { name, timeZone, slots, prayerUrl: link(input.prayerUrl) };
}

const dayMs = 86400000;

function wallTime(formatter, instant) {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

export function weeklyAirings(channel, now) {
  if (!channel.slots.length) return [];
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone: channel.timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  });
  const localMidnight = Math.floor(wallTime(formatter, now) / dayMs) * dayMs;
  const airings = [];
  for (let offset = -7; offset <= 7; offset++) {
    const date = localMidnight + offset * dayMs;
    const slots = channel.slots.filter(slot => slot.day === new Date(date).getUTCDay());
    if (!slots.length) continue;
    // Sample both sides of a clock change. An ambiguous time airs once, at
    // its first occurrence. A time skipped by the clock change has no airing.
    const offsets = [...new Set([-dayMs, 0, dayMs].map(delta =>
      wallTime(formatter, date + delta) - (date + delta)))];
    for (const slot of slots) {
      const [hour, minute] = slot.time.split(':').map(Number);
      const wall = date + (hour * 60 + minute) * 60000;
      const startsAt = Math.min(...offsets.map(zoneOffset => wall - zoneOffset)
        .filter(candidate => wallTime(formatter, candidate) === wall));
      if (Number.isFinite(startsAt)) airings.push({ ...slot, startsAt });
    }
  }
  return airings.sort((a, b) => a.startsAt - b.startsAt);
}
