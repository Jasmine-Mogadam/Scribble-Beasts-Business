# Deploying to Cloudflare (Workers + Durable Objects)

Production runs as **one Cloudflare Worker**:

- Static client (`client/dist`) is served as Workers static assets.
- `wss://scribble-beasts.com/api/room/<ROOM>` is routed to a **Durable Object per room** (`GameRoom`), which runs the same game code as the Node server.

There's no nginx, no containers, and nothing to scale. Idle lobbies hibernate and cost nothing.

## Cost

|                          | Fly.io (before) | Cloudflare Workers **Free** (recommended)        | Workers Paid                                     |
| ------------------------ | --------------- | ------------------------------------------------ | ------------------------------------------------ |
| Monthly                  | ~$5             | **$0**                                           | $5 minimum                                       |
| Static files / bandwidth | metered VM      | free, unlimited                                  | free, unlimited                                  |
| Durable Object time      | n/a             | 13,000 GB-s **per day**                          | 400,000 GB-s/month, then $12.50 per million GB-s |
| Requests                 | n/a             | 100,000/day                                      | 1M/month DO + 10M/month Worker                   |
| Over the limit           | billed          | requests fail until 00:00 UTC (no surprise bill) | billed                                           |

**What one game uses:** the room's Durable Object stays awake while a game runs, because round timers prevent hibernation. It's billed at 128 MB, so a 20-minute game costs 1,200 s × 0.125 GB = **150 GB-s**. Requests are trivial: one per WebSocket connection, plus incoming messages counted at 20:1. Heartbeats are answered by the runtime for free.

- **Free plan:** about **85 full games per day**. Lobbies left open in a tab cost ~0 thanks to hibernation.
- **Paid plan:** about 2,600 games/month included, then roughly $0.002 per game.

**Recommendation:** stay on **Workers Free**. That saves the ~$60/yr Fly bill. Move to Paid ($5/mo) only if you regularly run more than ~80 games a day.

## First-time setup

1. **Log in** (opens a browser):
   ```bash
   npx wrangler login
   ```
2. **Deploy a preview.** It goes to `*.workers.dev` and doesn't touch the real domain:
   ```bash
   npm run cf:deploy:preview
   npm run sim -- --url wss://scribble-beasts-preview.<your-subdomain>.workers.dev
   ```
   Then open the URL in two tabs and play a round.

## Switching scribble-beasts.com over from Fly

The `scribble-beasts.com` zone is already on Cloudflare (proxied to Fly). Custom domains can't be attached while other DNS records exist for the same hostname, so:

1. In the Cloudflare dashboard → **scribble-beasts.com → DNS → Records**, note down (for rollback) and then **delete** the records for `scribble-beasts.com` and `www`. Leave `playtest` alone; it's the Cloudflare Tunnel used for playtests.
2. Immediately deploy. Wrangler creates the DNS records and certificates for both hostnames:
   ```bash
   npm run cf:deploy
   ```
3. Verify:
   ```bash
   curl https://scribble-beasts.com/api/health      # OK
   npm run sim -- --url wss://scribble-beasts.com
   ```
4. **Rollback** if needed: remove the custom domains (Workers → scribble-beasts → Settings → Domains & Routes) and re-create the DNS records from step 1. Fly is still running until you destroy it.

## Turn on CI deploys and turn off Fly

1. Create an API token (**My Profile → API Tokens → "Edit Cloudflare Workers"** template, scoped to your account and the `scribble-beasts.com` zone).
2. In GitHub → Settings → Secrets and variables → Actions:
   - secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   - variable `DEPLOY_TARGET` = `cloudflare` (switches `.github/workflows/playtest.yml` from the Fly deploy to `npm run cf:deploy`)
3. Once Cloudflare has been stable for a few days, stop paying Fly:
   ```bash
   flyctl apps destroy scribble-server-jazmo
   flyctl apps destroy scribble-client-jazmo
   ```

## Day to day

```bash
npm run cf:dev        # local Worker + Durable Objects on http://localhost:8787 (no account needed)
npm run cf:tail       # live production logs
npm run cf:types      # after editing wrangler.jsonc
```

## Things to know

- **Deploys restart Durable Objects.** Anyone mid-game reconnects automatically and lands back in their lobby, because only idle lobbies are persisted. Deploy when nobody's playing.
- **Static asset limit is 25 MiB per file.** The intro video was re-encoded from 33 MB to 11 MB for this. The four `.wav` music tracks (7.5 MB each) fit, but converting them to `.mp3`/`.ogg` would make the game load much faster on phones.
- The old Docker/Fly setup (`npm run dev`, `npm run deploy`) still works and uses the same URL contract, so local development is unchanged.
