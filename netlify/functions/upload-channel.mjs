import { timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';

import { uploadChannel } from '../../worker/upload-channel.mjs';

export default req => uploadChannel(req, {
  store: getStore('yt-videos'),
  adminToken: Netlify.env.get('ADMIN_TOKEN'),
  apiKey: Netlify.env.get('YOUTUBE_API_KEY'),
  timingSafeEqual,
});

export const config = {
  path: '/api/upload-channel',
  method: 'POST',
};
