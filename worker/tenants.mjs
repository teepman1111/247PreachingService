import { validateChannel } from './channel.mjs';

const tenantKey = id => 'channels/' + id + '/identity.json';
const channelPattern = /^\/c\/([a-z0-9-]+)-([a-f0-9]{24})(\/.*)?$/;

export async function tenantId(account) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('church-channel:' + account));
  return Array.from(new Uint8Array(hash).slice(0, 12), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function findTenant(bucket, id) {
  const object = await bucket.get(tenantKey(id));
  return object ? object.json() : null;
}

export async function accountTenant(bucket, id) {
  const direct = await findTenant(bucket, id);
  if (direct) return direct;
  const alias = await bucket.get('accounts/' + id + '.json');
  if (!alias) return null;
  const { tenantId: linked } = await alias.json();
  return /^[a-f0-9]{24}$/.test(linked ?? '') ? findTenant(bucket, linked) : null;
}

export function tenantBase(tenant) {
  return '/c/' + tenant.slug + '-' + tenant.id;
}

export async function resolveTenant(bucket, pathname) {
  const match = channelPattern.exec(pathname);
  if (!match) return null;
  const [, slug, id, path = '/'] = match;
  const tenant = await findTenant(bucket, id);
  return tenant?.slug === slug ? { tenant, path } : null;
}

export function tenantBucket(bucket, tenant) {
  const prefix = 'channels/' + tenant.id + '/data/';
  return {
    channelDefaults: tenant.channelDefaults,
    get: key => bucket.get(prefix + key),
    head: key => bucket.head(prefix + key),
    put: (key, value, options) => bucket.put(prefix + key, value, options),
    delete: key => bucket.delete(prefix + key),
    async list(options) {
      const page = await bucket.list({ ...options, prefix: prefix + (options?.prefix ?? '') });
      return {
        truncated: page.truncated,
        cursor: page.cursor,
        objects: page.objects.map(({ key, uploaded }) => ({ key: key.slice(prefix.length), uploaded })),
      };
    },
  };
}

export async function createTenant(request, bucket, account) {
  const respond = (body, status) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!account) return respond({ error: 'Sign in to create your church channel.' }, 401);
  if (request.headers.get('Origin') !== new URL(request.url).origin ||
      request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
    return respond({ error: 'Submit the form from the pastor dashboard.' }, 403);
  }

  const id = await tenantId(account);
  const existing = await accountTenant(bucket, id);
  if (existing) return respond({ programming: tenantBase(existing) + '/programming' }, 200);
  const reader = request.body?.getReader();
  if (!reader) return respond({ error: 'Enter a church name and time zone.' }, 400);
  const chunks = [];
  let length = 0;
  let input;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2048) {
        await reader.cancel();
        return respond({ error: 'The form is too large.' }, 413);
      }
      chunks.push(value);
    }
    input = JSON.parse(await new Blob(chunks).text());
  } catch {
    return respond({ error: 'Enter a church name and time zone.' }, 400);
  }

  let channelDefaults;
  try {
    channelDefaults = validateChannel({
      name: input?.name, timeZone: input?.timeZone, prayerUrl: '', slots: [],
    }, new Set());
  } catch (error) {
    return respond({ error: error.message }, 400);
  }
  const slug = channelDefaults.name.normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
    .slice(0, 48).replace(/^-+|-+$/g, '') || 'church';
  const proposed = { id, slug, channelDefaults };
  const saved = await bucket.put(tenantKey(id), JSON.stringify(proposed), {
    onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
  });
  const tenant = saved ? proposed : await findTenant(bucket, id);
  return tenant
    ? respond({ programming: tenantBase(tenant) + '/programming' }, saved ? 201 : 200)
    : respond({ error: 'Could not finish setup. Try creating your channel again.' }, 503);
}
