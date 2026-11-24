import { getStore } from '@netlify/blobs';

import { getRandomVideo } from '../../worker/get-random-video.mjs';

export default req => getRandomVideo(req, getStore('yt-videos'));

export const config = {
  path: '/api/random-video',
};
