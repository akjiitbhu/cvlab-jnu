# Computing and Vision Lab — website

Public site and admin portal for the Computing and Vision Lab, School of Engineering,
Jawaharlal Nehru University, New Delhi.

**Deployed to Azure App Service** — one Node app serving the public pages, the API and the
editor, with MongoDB Atlas behind it. The address is the app's Azure default hostname,
which now carries a random hash (`cvlab-jnu-<hash>.centralindia-01.azurewebsites.net`);
find the exact one under **Overview → Default domain** in the portal. See
**`DEPLOY-AZURE.md`**, which is written around running on the free tier so an Azure for
Students credit stays intact.

The repository also supports two other shapes, documented but not in use: a split
deployment with the pages on GitHub Pages and the API elsewhere (the rest of this file),
and a self-hosted Ubuntu server (`DEPLOY-UBUNTU.md`).

Content lives in MongoDB and is edited through the portal — no redeploy to change a
member, a publication, a course, or the citation figures.

---

## Why the editor is not a separate app

*(This section explains the split deployment. On Azure everything is one app and one
origin, so the cookie question below simply does not arise — but the reasoning is worth
keeping, because it is what makes the login safe if you ever do split it.)*

GitHub Pages serves **static files only**. It cannot connect to MongoDB, check a
password, or hold a secret. A connection string in browser JavaScript is readable by
anyone viewing source, and a login checked in page JavaScript is bypassed with devtools.
So the database and the login need a host that runs Node.

### The one decision worth understanding: where the editor lives

The editor is served **by the API host**, at `https://your-api-host/admin` — not from
GitHub Pages. That is deliberate, and it is what keeps the login secure.

The session is an httpOnly cookie with `SameSite=Lax`. That `Lax` is what stops another
website from making an authenticated request using your cookie — it is the CSRF
protection. A cookie with `SameSite=Lax` is **not sent on cross-site requests**, so if
the editor were on `github.io` and the API elsewhere, the cookie would never arrive. The
usual fix is `SameSite=None`, which throws the CSRF protection away and requires a
separate CSRF token to replace it.

Keeping the editor on the API host avoids all of that: the editor and the API are the
same origin, `Lax` works as intended, and no CSRF token is needed. As a bonus the admin
login is not on your public domain at all.

So:

- **Public pages** → GitHub Pages → read `GET /api/content` cross-origin, no cookie, no
  credentials. Plain public data.
- **Editor** → the API host → same-origin, cookie works, writes protected.
- Auth and write routes send **no CORS headers whatsoever**, so a page on any other site
  cannot call them even if it has your cookie. (There is a test for this.)

The `docs/` folder is also served by the Node host, so the API host has a working copy of
the public site — handy for checking a change before it reaches Pages, and as a fallback
if Pages is down.

---

## What is where

```
server.js                 Express: security headers, CORS, routes, static files, errors
src/db.js                 MongoDB connection (redacts the password before logging)
src/models/               Mongoose schemas — Member, ResearchItem, Course, Metrics,
                          Photo, GalleryItem, AdminUser
src/middleware/
  auth.js                 JWT in an httpOnly cookie; requireAdmin gates every write
  cors.js                 cross-origin reads for the public endpoints ONLY — read the
                          comment at the top, it explains the security reasoning
src/routes/
  auth.js                 login, logout, me, change-password (rate limited + lockout)
  content.js              GET /api/content — everything the public site needs, one request
  crud.js                 generic REST router for members / research / courses
  metrics.js              GET/PUT the single metrics document
  photos.js               upload, serve and delete photographs (3 size variants)
  files.js                upload, stream and delete course materials
src/storage/files.js      GridFS document store + storage-usage reporting

docs/                     ← GitHub Pages publishes THIS FOLDER
  index.html              the public site
  404.html                self-contained, styles inlined
  .nojekyll               stops Jekyll from processing the folder
  assets/config.js        ** the API URL goes here **
  assets/site.css         one stylesheet, shared with the editor
  assets/site.js          renders everything; escapes all database values
  files/                  put course PDFs and notebooks here

admin/                    served only by the Node host, never published to Pages
  admin.html
  assets/admin.css
  assets/admin.js

scripts/
  seed.js                 loads the starting content (already filled in from your CV)
  seed-data.json          lab in-charge, 3 scholars, 25 publications, 13 talks, 4 courses
  create-admin.js         creates or resets the admin password
  refresh-metrics.js      updates citations / h-index / i10-index
  check.js                59 offline tests — no database needed
  smoke-test.js           full integration tests — needs MongoDB
  audit-secrets.sh        scans every commit for committed secrets

.github/workflows/pages.yml   publishes docs/ to Pages, injecting the API URL
```

---

## Run it locally first

Do this before deploying. Locally, Node serves both the pages and the API, so
`API_BASE` stays empty and there is no CORS to think about.

```bash
cd cvlab
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Paste that output as `JWT_SECRET` in `.env`. Leave `SITE_ORIGIN` unset — unset means
same-origin only, which is right for local work.

For `MONGODB_URI`, either install MongoDB locally
(`mongodb://127.0.0.1:27017/cvlab`) or create the free Atlas cluster now — step 2 of
deployment — and use its string here too.

```bash
npm run seed          # loads your content
npm run create-admin  # asks for a username and password, not echoed
npm run dev
```

<http://localhost:3000> is the site, <http://localhost:3000/admin> the editor. Change
something, reload the site, confirm it appears.

Then:

```bash
npm run check   # 59 offline checks
npm run smoke   # full integration test against a throwaway in-memory MongoDB
```

`npm run smoke` downloads a MongoDB binary the first time, so it needs a few minutes and
an open network.

---

## Deployment

**For Azure, follow `DEPLOY-AZURE.md` instead of this section.** It is the deployment in
use, it is simpler — one app, no CORS, no second origin — and it covers staying on the
free tier.

The rest of this section describes the split deployment: pages on GitHub Pages, API on a
separate Node host. The `pages.yml` workflow that publishes to GitHub Pages is **manual
only**, so it will not fire while you are on Azure.

---

Deploy the **API first**. The pages need its URL, so doing it the other way means
publishing a site that cannot load anything.

### Step 1 — push to GitHub

Create an empty repository. **Private** is a sensible default; you can open it later once
you have confirmed no secrets are in the history.

```bash
cd cvlab
git init
git add .
git commit -m "Lab website: static pages, API and admin portal"
git branch -M main
git remote add origin https://github.com/<your-username>/cvlab-jnu.git
git push -u origin main
```

Check `.env` is not going up:

```bash
git status --short | grep -F .env    # should print nothing, or only .env.example
```

`.gitignore` already excludes it. If a secret does get committed, **rotate it** — deleting
the file in a later commit does not remove it from the history.

### Step 2 — the database (MongoDB Atlas)

1. Sign up at <https://www.mongodb.com/cloud/atlas>, create a cluster on the free shared
   tier. Pick a region near India — Mumbai (`ap-south-1`) if offered.
2. **Database Access** → add a user with a strong generated password. Copy it now; Atlas
   will not show it again. `readWrite` on `cvlab` is enough — no admin rights.
3. **Network Access** → free hosts have no fixed outbound IP, so `0.0.0.0/0` is the
   practical entry. That is acceptable **only** because the user has a strong password and
   the string never reaches the browser. It is why the password matters so much.
4. **Connect → Drivers** → copy the string, insert the real password, add the database
   name before the `?`:

   ```
   mongodb+srv://cvlab_app:REALPASSWORD@cluster0.xxxxx.mongodb.net/cvlab?retryWrites=true&w=majority
   ```

   URL-encode any `: / ? # [ ] @` in the password or the string will not parse.

### Step 3 — the API host

Render is used here because its free tier needs no card. Railway, Fly.io, or a JNU server
work identically. Dashboards get redesigned often, so treat these as descriptions of what
to look for.

1. <https://render.com> → sign in with GitHub → authorise the repository.
2. New **Web Service** from that repository.
3. Settings:
   - **Runtime**: Node
   - **Build command**: `npm ci --omit=dev`
   - **Start command**: `node server.js`
   - **Health check path**: `/api/health`
4. Environment variables:

   | Key | Value |
   |---|---|
   | `MONGODB_URI` | the Atlas string from step 2 |
   | `JWT_SECRET` | 64 fresh random hex characters — **do not reuse your local value** |
   | `NODE_ENV` | `production` |
   | `SITE_ORIGIN` | your Pages origin — see the note below |

   Do not set `PORT`; the host provides it.

   **`SITE_ORIGIN` is the host only, not the path.** For a project site published at
   `https://ankit.github.io/cvlab-jnu/`, the origin is `https://ankit.github.io` — no
   repository name, no trailing slash. Getting this wrong is the single most common
   reason the published site shows no content.

5. Deploy. The log should show `[db] connected`, `[server] listening`, and
   `[cors] public reads allowed from: https://…`. If that last line says `SITE_ORIGIN not
   set`, fix it before continuing.
6. Note the service URL, e.g. `https://cvlab-jnu.onrender.com`.

`render.yaml` is included if you would rather point Render's Blueprints at the repo; the
secrets are marked `sync: false` so they are never written into the file.

### Step 4 — seed the live database and create your login

The live database is empty. Open the host's **Shell** for the service:

```bash
npm run seed
npm run create-admin
```

No shell on your host? Run both from your own machine with `MONGODB_URI` temporarily
pointed at the live Atlas string — same database.

Sign in at `https://your-api-host/admin` and confirm the editor loads.

### Step 5 — GitHub Pages

Two ways. **The workflow is better** — the API URL stays out of the repository.

**With the included workflow (recommended)**

1. Repository → **Settings → Secrets and variables → Actions → Variables → New
   repository variable**
   - Name: `CVLAB_API_BASE`
   - Value: your API URL, e.g. `https://cvlab-jnu.onrender.com` (no trailing slash)
2. Repository → **Settings → Pages → Source → GitHub Actions**
3. Push anything, or run the workflow manually from the **Actions** tab.

The workflow rewrites `docs/assets/config.js` at deploy time, checks the API responds,
and publishes `docs/`. It **fails loudly** if `CVLAB_API_BASE` is unset, rather than
publishing a site that silently loads nothing.

**By hand**

1. Edit `docs/assets/config.js` and set `API_BASE` to your API URL. Commit and push.
2. Repository → **Settings → Pages → Source → Deploy from a branch** → branch `main`,
   folder `/docs`.

Your site is then at `https://<username>.github.io/<repository>/`.

### Step 6 — confirm both halves

1. Open the Pages URL. The first load may show *"Waking the server…"* for up to a minute
   if the API was asleep — that is expected, and it retries by itself.
2. Publications, members and courses should all populate.
3. If sections say *"could not be loaded"*, it is almost always `SITE_ORIGIN`. Open the
   browser console: a CORS message names the origin it expected.

### After that

- Pushing to `main` redeploys the API automatically, and the workflow republishes Pages
  when anything in `docs/` changes.
- **Content changes need no deploy at all** — they go through `/admin`.

---

## A free tier sleeps

Free plans stop the process when idle and restart it on the next request, taking up to a
minute. Because the pages are static on GitHub Pages, the layout and text appear
instantly and only the database-backed sections wait — a much better first impression
than a blank page, which is one of the real advantages of this split.

The pages show a "waking" notice and retry automatically; tune it in
`docs/assets/config.js`.

If it still bothers you: the host's cheapest paid tier does not sleep, or ask the School
of Engineering for a server — which is also the answer if you want a `jnu.ac.in` address.

Do **not** add a cron job pinging the site every few minutes. It defeats the purpose of
the free tier and hosts increasingly detect and penalise it.

---

## Custom domains

**Pages**: repository → Settings → Pages → Custom domain, then the DNS records GitHub
asks for. Add a `docs/CNAME` file containing the domain so it survives redeploys.

**API**: add the domain in the host's settings and create the `CNAME` it asks for.

A `jnu.ac.in` subdomain must be created by JNU IT — you chair the Website and Social
Media Committee, which should help.

**If you change either domain, update `SITE_ORIGIN` on the API** or the pages stop being
allowed to read it.

---

## Editing content

Sign in at `https://your-api-host/admin`. The public site's footer links there. Five tabs:

- **Members** — scholars, students, alumni. `Group` picks the block, `Order` sorts within
  it. Untick *Show on the public site* to hide someone without deleting the record.
- **Research** — publications, talks, events, and the home-page research directions. Set
  **Year** so entries sort newest first. **Authors** is stored exactly as typed, so a
  published author order is never rearranged.
- **Teaching** — one entry per course, with repeating rows for units and materials. A
  material with a blank URL shows "link pending" rather than a dead link.
- **Metrics** — the home-page figures. **Leave a field blank and its tile disappears**
  rather than showing a zero. Whatever you put in **Source** is printed beside the numbers.
- **Account** — change your password; doing so signs out every other browser.

### Files for students

Put PDFs and notebooks in `docs/files/`, commit, push. A file at
`docs/files/dip/unit1-slides.pdf` is served by Pages at
`/<repository>/files/dip/unit1-slides.pdf` — paste that into a material's URL field.

Because these are static files on Pages, downloads do **not** wake the API and are fast
even when it is asleep. Keep individual files modest; Git is a poor store for very large
binaries — link to Drive or an institutional store for big datasets.

---

## Keeping the citation figures current

**Google Scholar cannot be read automatically by anyone.** No public API, and its
`robots.txt` disallows automated reads of `/citations`. No workaround fixes this —
scraping it on a timer gets the host rate-limited, CAPTCHA'd, and eventually blocked.

So `scripts/refresh-metrics.js` reads **OpenAlex**: free, documented, built for this. The
trade-off, stated plainly because your page displays it: OpenAlex indexes fewer venues
than Scholar and will normally report a **lower** citation count. The two are not
interchangeable. The script records which source it used and the page prints it, so a
figure is never credited to Scholar when it came from elsewhere.

```bash
npm run refresh-metrics -- --dry-run   # see what it would write
npm run refresh-metrics                # write it
```

For the Scholar numbers specifically, read them off your profile and enter them — in the
**Metrics** tab, or:

```bash
npm run refresh-metrics -- --citations 351 --h 10 --i10 11 --source "Google Scholar"
```

Weekly, on a host with cron:

```
0 6 * * 1  cd /srv/cvlab && /usr/bin/node scripts/refresh-metrics.js
```

Render's free tier has no cron. Run it occasionally from your own machine, or just type
the numbers into the Metrics tab when you notice they have moved — for a figure that
changes a few times a month, that is honestly fine.

---

## Security notes

In place:

- Passwords stored only as bcrypt hashes (cost 12); plaintext never reaches the database,
  a log, or a response.
- Session is a signed JWT in an **httpOnly, SameSite=Lax** cookie — unreadable by page
  JavaScript, not sent cross-site. `Secure` when `NODE_ENV=production`.
- **CORS is scoped to public reads.** Auth and write routes send no CORS headers, so
  another site cannot call them even holding your cookie. Cross-origin responses never
  carry `Allow-Credentials`, so `SameSite=Lax` is never forced to `None`.
- `requireAdmin` re-checks the account on every request, so deleting it or changing the
  password invalidates unexpired tokens.
- Login rate limited per IP **and** the account locks 15 minutes after 8 failures.
- Wrong username and wrong password give identical responses — no account enumeration.
- CSP without `unsafe-inline` for scripts, plus `frame-ancestors 'none'`.
- Bodies capped at 256 kB; write routes accept only allow-listed fields, so a crafted
  request cannot set `_id` or `createdAt`.
- Everything from the API is HTML-escaped before rendering.
- A test asserts no editor file and no secret-shaped string is inside `docs/`, so the
  editor can never be accidentally published to Pages.

Your side:

- Long unique password for the admin account; a different strong one for the Atlas user.
- Never commit `.env`. Generate a **fresh** `JWT_SECRET` for production.
- Suspect a leak? `npm run create-admin` resets the password and signs out every session.
- `npm audit` occasionally; `npm update` for patch releases. The lockfile pins `qs`
  through an `overrides` entry in `package.json` to clear two moderate advisories that
  reach the tree via Express 4 — `npm audit` reports 0 vulnerabilities as shipped.

There is **one** account by design. No signup route, no reset-by-email, no way to create a
second admin from the web — three fewer things to attack on a site that needs one editor.

---

## Is anything secret in this repository?

**No — by design.** Every secret lives in one of two places, neither of which is git:

| Secret | Where it lives |
|---|---|
| MongoDB connection string | `MONGODB_URI` in the host's environment variables |
| Session signing key | `JWT_SECRET` in the host's environment variables |
| Your admin password | only as a bcrypt hash, in the database |
| Atlas database password | in Atlas, and inside `MONGODB_URI` on the host |

`.env` is gitignored and never committed. What *is* committed only ever mentions the
*names* of these variables — `.env.example` holds placeholders, `render.yaml` marks them
`sync: false`, and the code reads `process.env`. A public repository leaks none of it.

### Prove it on your own clone

Do not take the above on trust — check the repository you actually pushed:

```bash
bash scripts/audit-secrets.sh
```

It reads only, changes nothing, and scans **every commit on every branch**, not just the
current files. That distinction matters: deleting a secret in a later commit does not
remove it from history — the old blob stays reachable through GitHub's commit views and
through anyone's existing clone. The script reports the commit hash if it finds one.

### If it does find something

**Rotate first, before anything else.** Making the repository private afterwards does not
help: assume a public secret is already known.

1. **Atlas password** — Atlas → Database Access → Edit user → Edit Password. Update
   `MONGODB_URI` on your host.
2. **`JWT_SECRET`** — generate a new one and set it on the host. Every session is signed
   out, which is the desired effect.
3. **Admin password** — `npm run create-admin`.

Then `git rm --cached .env`, commit, push. Rewriting history is optional once rotated, and
it breaks every existing clone; if you want it anyway, use
[git-filter-repo](https://github.com/newren/git-filter-repo).

---

## Making the repository private

You can, but **it breaks GitHub Pages on a free account.** GitHub's own documentation:

> "GitHub Pages is available in public repositories with GitHub Free and GitHub Free for
> organizations, and in public and private repositories with GitHub Pro, GitHub Team,
> GitHub Enterprise Cloud, and GitHub Enterprise Server."

So a private repository on the free plan cannot publish a Pages site at all. Your options:

| Option | Cost | Consequence |
|---|---|---|
| **Stay public** | free | Pages works. Run the audit first; if it is clean there is nothing to hide — the code has no secrets, and an open lab site is normal in academia. |
| **Private + GitHub Pro** | paid monthly | Everything keeps working exactly as documented. |
| **Private, drop Pages** | free | Serve the whole site from the Node host instead: set `API_BASE` back to `''` and use the host's URL. You lose the `github.io` address and the instant first paint while the API wakes, but nothing else. The Node host already serves `docs/`, so this needs no code change. |
| **Two repositories** | free | Private for the API, public holding only `docs/`. Works, but you now maintain two repos and copy `docs/` between them. Not worth it here. |

If you go private and keep a paid plan, note that a Pages site published from a private
repository is still **publicly visible** on GitHub Free/Pro — privacy applies to the
source, not the published site. That is what you want for a lab site, but it is worth
knowing: putting something sensitive in `docs/` publishes it regardless of repository
visibility.

---

## Troubleshooting

**Published site loads but every section says "could not be loaded"** — nearly always
`SITE_ORIGIN`. It must be the origin only (`https://user.github.io`), no repository path,
no trailing slash. The browser console names the origin it expected. Restart the API after
changing it.

**Sections say "Waking the server…" and never finish** — the API is down rather than
asleep. Open `https://your-api-host/api/health`: `{"ok":true}` means it is fine and the
problem is CORS; no response means the service is not running.

**Published site shows no content but localhost works** — `API_BASE` in
`docs/assets/config.js` is still empty, so the pages are asking GitHub Pages for the API.
Set the `CVLAB_API_BASE` variable and re-run the workflow, or edit the file directly.

**Pages 404s on the CSS** — an absolute `/assets/...` path. Project sites are published
under `/<repository>/`, so asset paths must stay relative. A test enforces this.

**Deploy builds fine, then `Exited with status 1` and `Could not connect to any
servers in your MongoDB Atlas cluster`** — the Atlas IP access list. A cloud host's
outbound IP is not in it, and free tiers have no fixed IP to add.

Atlas → **Network Access** → **IP Access List** → **Add IP Address** → *Allow access
from anywhere* (`0.0.0.0/0`) → Confirm. Wait about a minute, then redeploy.

That is safe **only** because the database user has a strong password and the connection
string never reaches a browser — which is why that password matters. The app now prints
this checklist itself when the connection fails, along with the redacted URI it tried.

If the message instead says `bad auth : authentication failed`, the cluster was reached
and the credentials are wrong: re-copy the string from Atlas → Connect, and URL-encode
any of `: / ? # [ ] @` in the password (`@` → `%40`, `#` → `%23`).

**Render says "It looks like we don't have access to your repo, but we'll try to clone
it anyway"** — the clone succeeds for a public repository, but Render lacks the GitHub
App permission, so **automatic redeploys on push will not fire**. Fix it at
<https://github.com/settings/installations> → Render → grant access to the repository,
or reconnect the repo in Render's service settings. Until then you must click **Manual
Deploy** after each push.

**`MONGODB_URI is not set`** — no `.env` locally, or missing from the host's dashboard.

**`JWT_SECRET must be set to at least 32 random characters`** — generate one as in the
local setup. The app refuses to start without it: a weak secret means anyone can forge a
session cookie.

**Login says "Incorrect username or password" and you are sure it is right** — the account
may be locked from earlier attempts. Wait 15 minutes, or `npm run create-admin` to reset,
which also clears the lock.

**Login works locally, not deployed** — `NODE_ENV=production` sets a `Secure` cookie,
which browsers keep only over HTTPS. Use the `https://` URL.

**`npm run smoke` cannot download MongoDB** — a network restriction; `npm run check`
covers the offline half.

---

## Test status

**`npm run check` — 59 offline checks, all passing.** Every seed document validates
against its schema; publication counts, DOIs, authors and venues match the source;
`docs/` contains no editor file and no secret-shaped string; asset paths are relative;
writes are refused without a session; forged and wrong-key cookies are refused; the CSP
forbids inline script; and the CORS rules are asserted in both directions — allowed
origins get a header, unknown and lookalike origins do not, cross-origin responses never
carry `Allow-Credentials`, and auth and write routes carry no CORS headers at all.

**`npm run smoke`** — full integration suite: login, account lockout, CRUD on every
collection, hidden rows staying out of the public payload, field allow-listing. Written
and syntax-checked but **not executed** during development, because that environment
could not run MongoDB. Run it once locally; it is the first thing to try if anything
behaves oddly.

**Browser testing.** Both pages were driven end to end in headless Chromium with the
static site on one port and the API on another — a genuine cross-origin setup:

- all 55 research items, 8 research directions, 4 courses with units and materials, and 3
  members render from the API;
- the editor creates, edits and deletes records, and its changes appear on the public site;
- with the API returning 503 (a cold start), the pages show "Waking the server…" and
  recover by themselves once it responds;
- with the API unreachable, each section shows an error while navigation and the
  static content keep working;
- a page on an origin **not** in `SITE_ORIGIN` was blocked by the browser from reading
  `/api/content` — CORS enforcement confirmed, not just configured.

One real bug was found and fixed this way: the course picker overflowed the page
horizontally on mobile instead of scrolling inside its own container.
