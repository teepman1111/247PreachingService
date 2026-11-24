import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { createAuth } from './auth.mjs';
import { s3Bucket, sessionStore } from './storage.mjs';
import app from '../worker/index.mjs';

const origin = process.env.APP_ORIGIN;
const pool = process.env.COGNITO_USER_POOL_ID;
const cognito = new CognitoIdentityProviderClient({});
const bucket = s3Bucket(new S3Client({}), process.env.DATA_BUCKET);
const auth = createAuth({
  origin,
  domain: process.env.COGNITO_DOMAIN,
  issuer: process.env.COGNITO_ISSUER,
  clientId: process.env.COGNITO_CLIENT_ID,
  sessionSecret: process.env.SESSION_SECRET,
  sessions: sessionStore(new DynamoDBClient({}), process.env.SESSION_TABLE),
  async hasTotp(username) {
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: pool, Username: username }));
    return user.Enabled === true && user.UserMFASettingList?.includes('SOFTWARE_TOKEN_MFA');
  },
});

export async function handler(event) {
  try {
    const method = event.requestContext.http.method;
    const headers = new Headers(event.headers);
    if (event.cookies?.length) headers.set('Cookie', event.cookies.join('; '));
    const target = origin + event.rawPath + (event.rawQueryString ? '?' + event.rawQueryString : '');
    const request = new Request(target, {
      method, headers,
      body: method === 'GET' || method === 'HEAD' || event.body == null
        ? undefined : event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body,
    });
    const response = new URL(request.url).pathname.startsWith('/auth/')
      ? await auth.route(request)
      : await app.fetch(request, { BUCKET: bucket, YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY }, await auth.identity(request));
    const responseHeaders = Object.fromEntries(response.headers);
    delete responseHeaders['set-cookie'];
    delete responseHeaders['content-length'];
    const payload = {
      statusCode: response.status,
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Strict-Transport-Security': 'max-age=31536000',
        ...responseHeaders,
      },
      cookies: response.headers.getSetCookie(),
    };
    if (!response.body) return payload;
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = /^(text\/|application\/json)/i.test(response.headers.get('Content-Type') ?? '');
    return { ...payload, isBase64Encoded: !text, body: bytes.toString(text ? 'utf8' : 'base64') };
  } catch (error) {
    console.error('Request failed', error.name, event.requestContext?.requestId);
    return { statusCode: 500, headers: { 'Cache-Control': 'no-store' }, body: 'The channel is temporarily unavailable.' };
  }
}
