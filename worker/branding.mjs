const key = 'program/branding';
const nonceBytes = 16;
const maxLogoBytes = 1024 * 1024;
const maxFormBytes = maxLogoBytes + 16384;
const noStore = { 'Cache-Control': 'no-store' };
const colorPattern = /^#[a-fA-F0-9]{6}$/;
const fonts = {
  classic: '"Instrument Serif", Georgia, serif',
  modern: 'system-ui, sans-serif',
  traditional: 'Georgia, serif',
  warm: '"Trebuchet MS", system-ui, sans-serif',
};

const defaults = {
  font: 'classic', primary: '#172c22', accent: '#efdba2',
  tagline: 'Sermons and teaching throughout the week.',
};

export const headingFontLink = '<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap" rel="stylesheet">';

export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function settings(object, base) {
  return {
    ...defaults, ...object?.customMetadata,
    revision: object?.etag ?? '',
    logoUrl: object?.size > nonceBytes ? base + '/logo?v=' + encodeURIComponent(object.etag) : null,
  };
}

export async function readBranding(bucket, base) {
  return settings(await bucket.head(key), base);
}

function readableText(color) {
  const linear = index => {
    const value = Number.parseInt(color.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminosity = 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
  return luminosity > 0.179 ? '#000000' : '#ffffff';
}

export function customPalette(branding) {
  return branding.primary !== defaults.primary || branding.accent !== defaults.accent;
}

export function brandingStyles(branding) {
  return [
    '--channel-font:' + fonts[branding.font],
    '--channel-primary:' + branding.primary,
    '--channel-on-primary:' + readableText(branding.primary),
    '--channel-accent:' + branding.accent,
    '--channel-on-accent:' + readableText(branding.accent),
  ].join(';');
}

function imageMime(bytes) {
  const matches = (offset, signature) => signature.every((byte, index) => bytes[offset + index] === byte);
  if (matches(0, [137, 80, 78, 71, 13, 10, 26, 10]) && matches(12, [73, 72, 68, 82]) &&
      bytes.length >= 33) return 'image/png';
  if (matches(0, [255, 216, 255]) && matches(bytes.length - 2, [255, 217])) return 'image/jpeg';
  if (matches(0, [82, 73, 70, 70]) && matches(8, [87, 69, 66, 80]) &&
      bytes.length >= 20) return 'image/webp';
  return '';
}

async function limitedForm(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Choose branding settings first.');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxFormBytes) {
      await reader.cancel();
      throw new Error('Choose a logo under 1 MB.');
    }
    chunks.push(value);
  }
  return new Response(new Blob(chunks), { headers: { 'Content-Type': request.headers.get('Content-Type') } }).formData();
}

function validateBranding(form) {
  const font = form.get('font');
  const primary = form.get('primary');
  const accent = form.get('accent');
  const tagline = form.get('tagline');
  if (typeof font !== 'string' || !Object.hasOwn(fonts, font)) throw new Error('Choose one of the available fonts.');
  if (typeof primary !== 'string' || typeof accent !== 'string' ||
      !colorPattern.test(primary) || !colorPattern.test(accent)) throw new Error('Choose valid colors.');
  if (typeof tagline !== 'string' || tagline.length > 120) throw new Error('Keep your tagline to 120 characters.');
  return { font, primary: primary.toLowerCase(), accent: accent.toLowerCase(), tagline: tagline.trim() };
}

export async function brandingRequest(request, bucket, base) {
  const respond = (body, status = 200) => Response.json(body, { status, headers: noStore });
  if (request.method === 'GET') return respond(await readBranding(bucket, base));
  if (request.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);
  if (request.headers.get('Origin') !== new URL(request.url).origin ||
      !request.headers.get('Content-Type')?.startsWith('multipart/form-data;')) {
    return respond({ error: 'Save branding from your church’s Programming page.' }, 403);
  }

  let form, branding, bytes, mime;
  try {
    form = await limitedForm(request);
    branding = validateBranding(form);
    const image = form.get('logo');
    if (image instanceof Blob && image.size) {
      if (image.size > maxLogoBytes) throw new Error('Choose a logo under 1 MB.');
      bytes = new Uint8Array(await image.arrayBuffer());
      mime = imageMime(bytes);
      if (!mime) throw new Error('Choose a PNG, JPG, or WebP image.');
    }
  } catch (error) {
    return respond({ error: error.message || 'Could not read the branding form.' }, 400);
  }

  const current = await bucket.get(key);
  const etag = current?.etag ?? '';
  if (form.get('revision') !== etag) {
    await current?.body?.cancel();
    return respond({ error: 'Branding changed in another tab. Reload Programming and try again.' }, 409);
  }

  if (!bytes && current?.size > nonceBytes && form.get('removeLogo') !== 'true') {
    bytes = new Uint8Array(await current.arrayBuffer(), nonceBytes);
    mime = current.httpMetadata.contentType;
  } else {
    await current?.body?.cancel();
  }
  // R2 uses the body for its ETag. Change it even on a metadata-only save
  // so two editors cannot overwrite each other with the same revision.
  const record = new Uint8Array(nonceBytes + (bytes?.length ?? 0));
  crypto.getRandomValues(record.subarray(0, nonceBytes));
  if (bytes) record.set(bytes, nonceBytes);
  const saved = await bucket.put(key, record, {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
    customMetadata: branding,
    httpMetadata: { contentType: mime || 'application/octet-stream' },
  });
  return saved
    ? respond(settings({ etag: saved.etag, size: record.length, customMetadata: branding }, base))
    : respond({ error: 'Branding changed in another tab. Reload Programming and try again.' }, 409);
}

export async function logoResponse(request, bucket) {
  const logo = await bucket.get(key);
  if (!(logo?.size > nonceBytes)) {
    await logo?.body?.cancel();
    return new Response('No logo uploaded.', { status: 404, headers: noStore });
  }
  const headers = {
    'Content-Type': logo.httpMetadata.contentType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, no-cache',
    ETag: logo.httpEtag,
  };
  if (request.headers.get('If-None-Match') === logo.httpEtag) {
    await logo.body.cancel();
    return new Response(null, { status: 304, headers });
  }
  let remaining = nonceBytes;
  const image = logo.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const discarded = Math.min(remaining, chunk.length);
      remaining -= discarded;
      if (chunk.length > discarded) controller.enqueue(chunk.subarray(discarded));
    },
  }));
  return new Response(image, { headers });
}
