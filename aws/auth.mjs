import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const transactionCookie = '__Host-church-login';
const sessionCookie = '__Host-church-session';
const loginSeconds = 600;
const sessionSeconds = 3600;
const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const now = () => Math.floor(Date.now() / 1000);
const random = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');

function cookieValue(request, name) {
  const entry = request.headers.get('Cookie')?.split(';').map(value => value.trim())
    .find(value => value.startsWith(name + '='));
  return entry?.slice(name.length + 1);
}

function cookie(name, value, maxAge) {
  return name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
}

function redirect(location, cookies = []) {
  const headers = new Headers({ ...noStore, Location: location });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}

function html(body, status = 200) {
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Church Channel sign-in</title><main>' +
    body + '</main></html>', {
    status, headers: { ...noStore, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'" },
  });
}

function localPath(url, value) {
  if (!value?.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value) || value.length > 1024) return '/';
  const target = new URL(value, url.origin);
  if (target.origin !== url.origin || target.pathname.startsWith('/auth/')) return '/';
  return target.pathname + target.search;
}

function encryptTransaction(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(transactionCookie));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function readTransaction(request, key) {
  const value = cookieValue(request, transactionCookie);
  if (!value || value.length > 3072) return null;
  try {
    const data = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(transactionCookie));
    decipher.setAuthTag(data.subarray(12, 28));
    const result = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
    return result.expires > now() ? result : null;
  } catch {
    return null;
  }
}

function sessionId(request) {
  const value = cookieValue(request, sessionCookie);
  return /^[A-Za-z0-9_-]{43}$/.test(value ?? '') ? digest(value) : null;
}

export function createAuth({ origin, domain, issuer, clientId, sessionSecret, sessions, hasTotp, fetchToken = fetch, jwks }) {
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('Configure a strong authentication secret.');
  const app = new URL(origin);
  if (app.protocol !== 'https:' || app.origin !== origin) throw new Error('APP_ORIGIN must be a canonical HTTPS origin.');
  const login = new URL(domain);
  if (login.protocol !== 'https:' || login.origin !== domain) throw new Error('COGNITO_DOMAIN must be a canonical HTTPS origin.');
  const key = createHash('sha256').update(sessionSecret).digest();
  const keys = jwks ?? createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'), { timeoutDuration: 5000 });
  const redirectUri = origin + '/auth/callback';
  const clearTransaction = cookie(transactionCookie, '', 0);

  function begin(url) {
    const transaction = {
      state: random(), nonce: random(), verifier: random(),
      returnTo: localPath(app, url.searchParams.get('return_to')),
      expires: now() + loginSeconds,
    };
    const authorize = new URL('/oauth2/authorize', login);
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, scope: 'openid email',
      redirect_uri: redirectUri, state: transaction.state, nonce: transaction.nonce,
      code_challenge: digest(transaction.verifier), code_challenge_method: 'S256',
    });
    return redirect(authorize.href, [cookie(transactionCookie, encryptTransaction(transaction, key), loginSeconds)]);
  }

  async function callback(request, url) {
    const transaction = readTransaction(request, key);
    const code = url.searchParams.get('code');
    if (!transaction || !code || url.searchParams.get('state') !== transaction.state) {
      return failure('This sign-in link expired or could not be verified. Start sign-in again.');
    }
    try {
      const response = await fetchToken(new URL('/oauth2/token', login), {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri,
          code, code_verifier: transaction.verifier,
        }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return failure('The sign-in code could not be exchanged. Start sign-in again.');
      const { id_token: token } = await response.json();
      const { payload } = await jwtVerify(token, keys, {
        issuer, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp'],
      });
      if (payload.token_use !== 'id' || payload.nonce !== transaction.nonce ||
          payload.email_verified !== true || typeof payload.email !== 'string' ||
          typeof payload['cognito:username'] !== 'string') {
        return failure('Verify your email and start sign-in again.');
      }
      // Cognito may issue a first-use token during enrollment. Admit the
      // account only after its authenticator has been registered.
      if (!await hasTotp(payload['cognito:username'])) {
        return failure('Finish setting up your authenticator in Cognito, then sign in again.');
      }
      const tokenValue = random();
      const expires = Math.min(payload.exp, now() + sessionSeconds);
      const duration = expires - now();
      if (duration <= 0) return failure('Your sign-in expired. Start sign-in again.');
      const existing = sessionId(request);
      if (existing) await sessions.remove(existing);
      await sessions.create(digest(tokenValue), {
        sub: payload.sub, email: payload.email.trim().toLowerCase(), expires,
        legacyAdmin: Array.isArray(payload['cognito:groups']) && payload['cognito:groups'].includes('legacy-pilot-admin'),
      });
      return redirect(transaction.returnTo, [clearTransaction, cookie(sessionCookie, tokenValue, duration)]);
    } catch {
      return failure('Sign-in could not be completed. Start sign-in again.');
    }
  }

  function failure(message) {
    const response = html('<h1>Sign-in incomplete</h1><p>' + message + '</p><a href="/auth/login">Sign in</a>', 400);
    response.headers.append('Set-Cookie', clearTransaction);
    return response;
  }

  async function logout(request) {
    if (request.method === 'GET') {
      return html('<h1>Sign out of Church Channel?</h1><form action="/auth/logout" method="post"><button>Sign out</button></form><a href="/">Return to dashboard</a>');
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: noStore });
    if (request.headers.get('Origin') !== origin) return new Response(null, { status: 403, headers: noStore });
    const id = sessionId(request);
    if (id) await sessions.remove(id);
    const url = new URL('/logout', login);
    url.search = new URLSearchParams({ client_id: clientId, logout_uri: origin + '/' });
    return redirect(url.href, [clearTransaction, cookie(sessionCookie, '', 0)]);
  }

  return {
    async identity(request) {
      const id = sessionId(request);
      const session = id ? await sessions.get(id) : null;
      return session?.expires > now() ? session : null;
    },
    async route(request) {
      const url = new URL(request.url);
      if (url.pathname === '/auth/logout') return logout(request);
      if (request.method === 'GET' && url.pathname === '/auth/login') return begin(url);
      if (request.method === 'GET' && url.pathname === '/auth/callback') return callback(request, url);
      return new Response('Not found', { status: 404, headers: noStore });
    },
  };
}
