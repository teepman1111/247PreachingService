# 247PreachingService

This project is written in the following manner:
Backend: Netlify Functions (Node.js), Netlify Blobs (data storage)
Frontend: Static HTML/JS hosted on Netlify

The intent of this project is to provide a space for Christians to come and watch Biblically accurate preaching 24/7. This project will not make any money and is not intended to make money until churches and their leadership sign off on allowing me to use their videos on this site.

## Setup

1. Set the `YOUTUBE_API_KEY` environment variable in your Netlify site settings (Site Settings > Environment Variables). You can get a YouTube Data API key from the [Google Cloud Console](https://console.cloud.google.com/).

2. Deploy to Netlify. The site will be available at your Netlify URL.

3. Use the admin section on the page to add YouTube channels by their Channel ID.

## Architecture

- `public/index.html` — Frontend UI that embeds random YouTube preaching videos
- `netlify/functions/get-random-video.mjs` — API endpoint that picks a random video from stored channels
- `netlify/functions/upload-channel.mjs` — API endpoint that fetches all videos from a YouTube channel and stores them

Data is stored in Netlify Blobs (key-value store), replacing the previous Firebase Firestore setup.

## Planned features

- Server-side video streaming, making everyone be able to watch the same thing at the same time
- Admin panel
- Video transcript word-cloud for filtering videos
- Business plan
