import qrcode from 'qrcode-generator';
import { readChannel } from './program.mjs';

const noStore = { 'Cache-Control': 'no-store' };
const fields = ['tuneIns', 'returningTuneIns', 'playbackFailures'];

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export async function invitation(request, env, base) {
  const channel = await readChannel(env.BUCKET);
  const watch = new URL(base + '/watch', request.url).href;
  const code = qrcode(0, 'M');
  code.addData(watch);
  code.make();
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tune in to ${escapeHtml(channel.name)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#172c22;color:#fffaf0;font:1.2rem/1.5 system-ui,sans-serif}
  main{min-height:100vh;display:grid;place-content:center;justify-items:center;padding:2rem;text-align:center}
  h1{margin:0;font:clamp(2rem,7vw,5rem)/1.05 Georgia,serif;overflow-wrap:anywhere}
  img{width:min(60vw,16rem);height:auto;border-radius:.5rem;image-rendering:pixelated}
  a{color:inherit;overflow-wrap:anywhere} p{margin:1rem 0}
  @media print{body{background:white;color:black}main{min-height:auto}}
</style>
<main><h1>${escapeHtml(channel.name)}</h1><p>Tune in between Sundays. Scan to watch.</p>
<img src="${code.createDataURL(8)}" alt="QR code for the Watch page">
<p><a href="${escapeHtml(watch)}">${escapeHtml(watch)}</a></p></main></html>`, {
    headers: { ...noStore, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function keyFor(timeZone, instant) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const part = type => date.find(item => item.type === type).value;
  return 'program/pilot/' + [part('year'), part('month'), part('day')].join('-');
}

export async function pilotEvent(request, env) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) return new Response(null, { status: 403 });
  const event = new URL(request.url).searchParams.get('event');
  if (!fields.includes(event)) return new Response(null, { status: 400 });
  const channel = await readChannel(env.BUCKET);
  const key = keyFor(channel.timeZone, Date.now());
  for (let attempt = 0; attempt < 4; attempt++) {
    const object = await env.BUCKET.get(key);
    const counts = object ? await object.json() : {};
    counts[event] = (counts[event] ?? 0) + 1;
    const saved = await env.BUCKET.put(key, JSON.stringify(counts), {
      onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
    });
    if (saved) return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 503 });
}

export async function pilotReport(env) {
  const channel = await readChannel(env.BUCKET);
  const now = Date.now();
  const today = keyFor(channel.timeZone, now);
  // Use local calendar date arithmetic, so DST changes never skip or duplicate a day.
  const midnight = Date.parse(today.split('/').at(-1) + 'T00:00:00Z');
  const days = await Promise.all(Array.from({ length: 28 }, async (_, index) => {
    const date = new Date(midnight - index * 86400000).toISOString().slice(0, 10);
    const object = await env.BUCKET.get('program/pilot/' + date);
    const counts = object ? await object.json() : {};
    return { date, tuneIns: (counts.tuneIns ?? 0) + (counts.returningTuneIns ?? 0),
      returning: counts.returningTuneIns ?? 0, failures: counts.playbackFailures ?? 0 };
  }));
  return Response.json({ days }, { headers: noStore });
}
