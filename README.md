# RotWatch

Uptime monitoring and broken-link checks for small websites: email alerts the moment your site goes down, plus a weekly report of every broken link.

RotWatch is new. The live site is https://rotwatch-dwz.pages.dev.

## What works today

The home page runs a one-off check of a single page. It fetches the page, records the status code and the response time, and checks the links on the page. A check runs when you submit it. RotWatch keeps no record of it, and there are no accounts in this version.

## What is planned

Scheduled monitoring, email alerts, and a weekly broken-link report are still being built. The home page will say when each one is live. Checkout is not open yet, and the site collects no payment. The prices on the home page are launch pricing.

## How the check works

The checker fetches the page with a 10 second timeout and follows redirects. When the page answers with a 2xx status and HTML content, the checker reads up to the first 1 MB and collects the links on the page. It checks up to 100 links, 10 at a time. Each link is checked with a HEAD request first. If that fails, the checker retries with GET. A link counts as broken when it returns a 4xx or 5xx status or when both requests fail. The whole run is bounded at about 25 seconds. Links left unchecked past that limit are reported as unchecked, not as broken.

Private and local network addresses are refused. The block covers literal addresses such as 127.0.0.1, 10.0.0.0/8, 192.168.0.0/16, and ::1. Host names that resolve to private addresses are not caught in this version.

## Layout

- `site/` holds the static pages, the stylesheet, and the check form script. `site/_redirects` sends `/api/*` to the Worker.
- `worker/` holds the check API. `check.js` is the Worker module. `smoke-test.mjs` runs the same module under Node.

The site uses no build step, no framework, and no third party script. The only script on the pages is the check form script. The `<head>` of each page holds a comment marking where the contest traffic verification snippet goes. Nothing is installed there yet.

## Run it locally

Preview the pages:

```sh
cd site && python3 -m http.server 8000
```

The check form on a local preview needs the Worker, since `/api/*` is served by the deployed Worker through the redirect. To run the check logic itself under Node 20 or newer:

```sh
node worker/smoke-test.mjs
```

The smoke test runs the handler against a known good page, a known 404 page, a private address, and bad input. It prints each result.

## Deploy

The Pages project must exist before the first direct upload. Create it once through the Cloudflare API, then deploy the folder:

```sh
cd ~/workspace/rotwatch
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py pages-deploy rotwatch site
```

The command takes the project name and the folder as plain arguments. Do not pass `--site-dir`. That flag is read as a folder name and uploads nothing.

Deploy the check API as a Worker:

```sh
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py put-worker rotwatch-check worker/check.js worker/metadata.json
```

The Worker answers at `https://rotwatch-check.imahgal.workers.dev/check`. The Pages redirect maps `/api/check` to it, so the form calls the same origin.

## Limits in this version

There is no rate limiting on the check API yet. There is no stored history and no way to re-run a past check. The checker reads only the first 1 MB of a page and checks at most 100 links. Some sites block automated requests and return 403 for pages that load fine in a browser. The result lists the status code for each link, so those cases stay visible.
