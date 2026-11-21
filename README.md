# 247PreachingService

This project is written in the following manner:
Backend: Netlify Functions (Node.js), Netlify Blobs (data storage)
Frontend: Static HTML/JS hosted on Netlify

The intent of this project is to provide a space for Christians to come and watch Biblically accurate preaching 24/7. This project will not make any money and is not intended to make money until churches and their leadership sign off on allowing me to use their videos on this site.

## Deploy on Netlify

1. Connect this repository and select the branch containing the Netlify app. The publish and functions directories are configured in `netlify.toml`.
2. Set `YOUTUBE_API_KEY` and a strong, unique `ADMIN_TOKEN` in the site's environment variables. Give both variables Functions scope if your plan supports scoping.
3. Deploy the site. In **Admin: Add a YouTube Channel**, enter the channel's `UC…` ID and your admin token, then select **Upload Channel**. Repeat for each channel you choose. The importer fetches the channel's uploads playlist and stores its video IDs.
4. Select **Next Video** or reload the page to start watching. Press play in the YouTube player if your browser blocks autoplay.

## Playback

Each viewer gets a random video on arrival. The player picks another when a video ends or when the viewer selects **Next Video**. It avoids immediate repeats when another video is available and skips videos YouTube cannot play in the embed. Viewers run independent streams.

YouTube controls ads and playback availability for embedded videos. Guaranteed ad-free playback requires a separate source of video files you have permission to host and stream.

## Architecture

- `public/index.html` — Frontend UI that embeds random YouTube preaching videos
- `netlify/functions/get-random-video.mjs` — API endpoint that picks a random video from stored channels
- `netlify/functions/upload-channel.mjs` — API endpoint that fetches all videos from a YouTube channel and stores them

Data is stored in Netlify Blobs (key-value store), replacing the previous Firebase Firestore setup.

## Planned features

- Server-side video streaming, making everyone be able to watch the same thing at the same time
- Expanded admin panel for managing the catalog
- Video transcript word-cloud for filtering videos
- Business plan

## ChatGPT Sites hosting

Build the Worker with `bash scripts/build-sites.sh`. The Site uses its own R2 catalog, so add your channels again if they were originally imported on Netlify. Set `ADMIN_TOKEN` and `YOUTUBE_API_KEY` as production secrets in Sites and redeploy to apply them. Then enter the same admin token in the site's import form.

The owner-private church pilot uses `SITE_ADMIN_EMAIL` to authorize playlist edits. Set it to the owner's ChatGPT email in the Sites production environment. Approve individual YouTube links on the home page. `/watch` plays the approved list in order and `/signage` runs the same loop in a full-window, muted player. These flows work without a YouTube Data API key. Imported channel catalogs are separate from the approved list.

### Trusted sources and weekly topics

The private pilot accepts multiple channels and playlists on **Programming**.
Configure `YOUTUBE_API_KEY` (YouTube Data API v3) as a Sites production
secret and redeploy to apply it. The existing `SITE_ADMIN_EMAIL` authorizes
programming changes.

Approving a source imports its embeddable public or unlisted videos and their
titles. The topic cloud matches recognized English words and phrases in the
titles. Generic titles can remain unmatched. A video contributes only once to
a topic even when it appears in several sources.

Opening Programming refreshes sources imported before titles were stored. Use
**Sync all sources** to pick up new uploads, title edits, and removals. The
previous completed catalog stays active if a sync is interrupted. Resume the
sync or discard the partial result from the source row.

Select a topic in the cloud and publish it to Watch and Signage for seven days.
The active topic uses the current set of matching videos from trusted sources.
After it expires, both players return to all approved videos. Source removal
excludes its videos unless another trusted source also supplies them. Existing
individually approved videos remain in the all-approved loop.

### Sharing Watch

Share the `/watch` URL for synchronized viewing without a sign-in. The
broadcast follows the weekly topic or the all-approved loop. Its server clock
chooses the current video and playback offset from the ordered playlist and
YouTube durations. The player checks the clock periodically and rejoins the
current position when possible. YouTube ads, buffering, and browser autoplay
rules can temporarily affect timing.

Sites access is public so Watch can be opened by anyone with the link. The
Worker requires the signed-in site owner for Programming, Signage, and their
APIs. The public broadcast endpoint exposes the current video and timing.
