# Deploying on Azure App Service

With an **Azure for Students** subscription and its $100 credit.

The whole site — public pages, API, editor, photographs and course materials — runs as one
Node app on App Service. MongoDB Atlas stays where it is.

---

## The plan, decided

| | |
|---|---|
| Host | Azure App Service, **Linux, Node 22** |
| Plan | **F1 (Free)** |
| Address | `https://cvlab-jnu-<hash>.centralindia-01.azurewebsites.net` — see below; HTTPS, certificate managed by Azure |
| Database | MongoDB Atlas M0, free, unchanged |
| Custom domain | none for now |
| **Monthly cost** | **$0. The $100 credit is not touched.** |

Everything below follows from that. Skip to *Step 1* if you just want to get it running;
the rest of this section is why the free tier is the right answer rather than a compromise.

---

## Why free, not "free for now"

That $0 matters more than it sounds, because of how the student offer ends:

- The credit expires after 12 months, or sooner if you spend it.
- When it is gone, **anything running on a paid tier stops**. A lab website that dies
  eight months from now, in the middle of a semester, because a credit ran out is worse
  than one that was never fancy to begin with.
- Free-tier services keep running. They are not billed against the credit at all.

So: **F1 for the website, and keep the $100 for things that actually need it** — a GPU VM
for training runs, a Machine Learning workspace, compute for your scholars' experiments.
Those are worth real money. Serving a few thousand page views a month is not.

`cvlab-jnu.azurewebsites.net` is a perfectly respectable address for a lab. It is HTTPS,
the certificate is managed for you, and nobody has ever thought less of a research group
for it.

### What F1 costs you in capability

| | F1 Free | B1 Basic |
|---|---|---|
| Price | **$0** | roughly $13/month — check your region |
| CPU | **60 CPU-minutes per day**, shared VM | 1 dedicated core |
| Memory | 1 GB | 1.75 GB |
| Storage | **1 GB** | 10 GB |
| Scale out | **No** | Yes |
| Always On | **No** — the app sleeps when idle | Yes |
| Custom domain | **Not supported on F1** | Yes, with TLS |

Two of those are real constraints, and both are survivable:

**The 60 CPU-minute daily quota.** It is a hard stop: exceed it and the app returns 403
for the rest of the day. For a lab site this is a lot of headroom — image processing is
about 50 ms per upload and page loads are mostly static file serving — but it is the thing
to watch if the site is ever linked somewhere busy. The portal shows usage under
**Quotas**.

**No custom domain.** Settled: you are on `azurewebsites.net`. If a `jnu.ac.in` subdomain
becomes available later, that needs at least B1 — and at that point the ~$13/month is a
deliberate choice rather than an accident. The last section covers the move.

> The figures above for CPU minutes and storage come from Azure's published limits; the
> B1 price is region-dependent and loads dynamically on the pricing page, so check the
> number for Central India in the portal before committing. Verify the custom-domain
> restriction in the portal too — Azure does revise tier features.

### Why the database stays on Atlas

You chose to keep MongoDB Atlas, and that is the right call here: the **M0 free cluster is
free forever and is not an Azure service at all**, so it never touches the credit or the
expiry. Atlas runs on Azure infrastructure, so you can place it in an Azure region near
you and keep latency low.

The alternative, Cosmos DB for MongoDB, would bill against your credit.

**The one Atlas limit that matters now that you upload files: M0 gives you 512 MB
total.** Documents, indexes, photographs and course materials all share it. Photographs
are tiny — a portrait is 6–10 kB. Lecture PDFs are not: 30–60 decks will fill it. The
editor warns you past 380 MB, and the "Managing storage" section below covers what to do.

---

## The whole thing, on one page

Tick these off in order. Each is expanded below.

- [ ] **1.** Web App: `cvlab-jnu`, Linux, **Node 22 LTS**, Central India, **F1 Free**
- [ ] **2.** App settings: `MONGODB_URI`, `JWT_SECRET`, `NODE_ENV=production`,
      `SCM_DO_BUILD_DURING_DEPLOYMENT=true`, `WEBSITE_NODE_DEFAULT_VERSION=22-lts`
- [ ] **2b.** Startup command: `node server.js`
- [ ] **3.** Atlas → Network Access → add the App Service outbound IPs
- [ ] **4.** Deployment Center → GitHub → `akjiitbhu/cvlab-jnu`, branch `main`
- [ ] **5.** SSH into the app → `npm run seed` → `npm run create-admin`
- [ ] **6.** Open the site, sign in at `/admin`, upload a photo to confirm it all works
- [ ] **7.** Cost Management → Budgets → a $10 alert, so nothing surprises you

**Do not set** `PORT`, `SITE_ORIGIN` or `INSECURE_HTTP`. Azure provides the port; there is
no second origin; the site is HTTPS. Each of those set wrongly breaks something quietly —
`SITE_ORIGIN` would allow a stranger's site to read your API, and `INSECURE_HTTP` would
strip the `Secure` flag off your session cookie for no reason.

---

## Before you start

- An Azure for Students subscription — <https://azure.microsoft.com/free/students>,
  activated with your `@jnu.ac.in` address. No credit card.
- Your MongoDB Atlas cluster and connection string, from the main README.
- The repository on GitHub.

---

## Step 1 — Create the App Service

**Portal** → **Create a resource** → **Web App**.

| Field | Value |
|---|---|
| Subscription | Azure for Students |
| Resource group | Create new: `cvlab-rg` |
| Name | `cvlab-jnu` — becomes `cvlab-jnu.azurewebsites.net`, so it must be globally unique |
| Publish | **Code** |
| Runtime stack | **Node 22 LTS** |
| Operating System | **Linux** |
| Region | **Central India** (or whichever is nearest and offers F1) |
| Pricing plan | **Free F1** — click *Change size* → *Dev/Test* → **F1** |

Review + create. It takes a minute or two.

### The URL will have a random hash in it. That is correct.

When you type the name, the portal shows you something like:

```
cvlab-jnu-a6gqaeashthkhkeu.centralindia-01.azurewebsites.net
```

Not a mistake, not encryption, and nothing you did wrong. Azure now gives every new app
a **secure unique default hostname**: the app name, a 16-character hash, and the region.

**Why.** The old `cvlab-jnu.azurewebsites.net` was globally predictable. If an app was
ever deleted while a DNS record somewhere still pointed at that hostname, anyone could
create a new app with the same name and inherit the traffic — a subdomain takeover. The
hash makes the hostname unguessable, so a dangling record leads nowhere.

**What it does and does not change:**

- **The app's name is still `cvlab-jnu`.** That is the resource name: it is what the
  portal lists, what `az webapp ... --name cvlab-jnu` takes, and what you put in the
  deploy workflow. Only the *hostname* carries the hash.
- **Nothing in this project cares.** No code, config or workflow builds a URL from the
  app name — `API_BASE` is empty and `SITE_ORIGIN` is unset because everything is served
  from one origin, whatever that origin happens to be called. The deploy workflow reads
  the real hostname from Azure rather than assembling one.
- **It cannot be switched off afterwards.** The setting only applies at creation. If you
  genuinely need the short form you would have to delete and recreate the app, and you
  would be choosing a weaker hostname to do it. Not worth it.

**So copy the full hostname from the portal** — Web App → **Overview** → *Default domain*
— and use that as your site's address. It is long. It is also just a URL: you will link to
it from the School of Engineering site and from your e-mail signature, and nobody types it
by hand.

If the length genuinely bothers you, that is an argument for a `jnu.ac.in` subdomain
later (last section), not for fighting Azure now.

If F1 does not appear in your region, pick another region rather than accepting B1 by
accident. That default is exactly how a student credit quietly disappears.

### Or from the CLI

```bash
az login
az group create --name cvlab-rg --location centralindia

az appservice plan create \
  --name cvlab-plan --resource-group cvlab-rg \
  --is-linux --sku F1

az webapp create \
  --name cvlab-jnu --resource-group cvlab-rg \
  --plan cvlab-plan --runtime "NODE:22-lts"

# The hostname you will actually use:
az webapp show --name cvlab-jnu --resource-group cvlab-rg \
  --query defaultHostName --output tsv
```

`--name` is the resource name. The command above prints the real hostname, hash and all.

## Step 2 — Application settings

App Service calls environment variables **Application settings**. The app reads exactly
the same names as everywhere else.

**Portal** → your Web App → **Settings → Environment variables → App settings**:

| Name | Value |
|---|---|
| `MONGODB_URI` | your Atlas connection string |
| `JWT_SECRET` | 64 fresh random hex characters — generate a new one, do not reuse another host's |
| `NODE_ENV` | `production` |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` |
| `WEBSITE_NODE_DEFAULT_VERSION` | `22-lts` |

Generate the secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Do **not** set `PORT` — App Service injects it, and the app already reads
`process.env.PORT`.

Do **not** set `SITE_ORIGIN`. Everything is served from this one app, so there is no
second origin to allow, and the app is same-origin with its own API.

Do **not** set `INSECURE_HTTP`. App Service gives you HTTPS on `azurewebsites.net` out of
the box, so the session cookie should keep its `Secure` flag.

**Why `SCM_DO_BUILD_DURING_DEPLOYMENT=true` matters here.** It tells Azure's build system
(Oryx) to run `npm install` *on the App Service instance*. This project depends on
**sharp**, which ships a compiled binary per platform. Building on the target machine
guarantees the right one. Without it you would be shipping whatever binary your laptop or
CI runner produced, and a mismatch shows up as `Something went wrong installing the
"sharp" module` at startup, which is a confusing way to learn this.

Then set the startup command — **Configuration → General settings → Startup Command**:

```
node server.js
```

Save. The app restarts.

## Step 3 — Let Atlas accept connections from Azure

Same problem you hit on Render, different addresses. App Service has a fixed set of
outbound IPs, so you can allow-list precisely rather than opening to the world.

Find them: **Web App → Networking → Outbound addresses**, and copy
**All possible outbound IP addresses** (not just the current ones — Azure rotates within
that set).

```bash
az webapp show --name cvlab-jnu --resource-group cvlab-rg \
  --query possibleOutboundIpAddresses --output tsv
```

Then in Atlas → **Network Access → IP Access List**, add each address. It is a dozen or
so entries, which is tedious but strictly better than `0.0.0.0/0`.

If you would rather not, `0.0.0.0/0` still works and is safe *only* because your database
user has a strong password and the connection string never reaches a browser.

> Scaling the plan or moving region changes the outbound set. If the site suddenly cannot
> reach the database after a change like that, this is why — the app prints the full
> checklist when the connection fails.

## Step 4 — Deploy from GitHub

**Portal** → your Web App → **Deployment Center**:

1. Source: **GitHub**, authorise, pick `akjiitbhu/cvlab-jnu`, branch `main`.
2. Build provider: **GitHub Actions**.
3. Save.

Azure commits a workflow to `.github/workflows/` and deploys. Watch it in the repo's
**Actions** tab; the first run takes a few minutes because it installs sharp.

The workflow in `.github/workflows/azure-webapp.yml` in this repository does the same
thing with the settings this project needs, if you would rather commit it yourself than
let the portal generate one. Either way you need the publish profile:
**Web App → Overview → Download publish profile**, then add its contents as a repository
secret named `AZURE_WEBAPP_PUBLISH_PROFILE`.

### Check it started

**Log stream** in the portal, or:

```bash
az webapp log tail --name cvlab-jnu --resource-group cvlab-rg
```

You want `[db] connected` followed by `[server] listening`. The `[cors] SITE_ORIGIN not
set — same-origin only` line is expected and correct here.

## Step 5 — Seed the database and create your login

App Service has a shell: **Development Tools → SSH** in the portal, or:

```bash
az webapp ssh --name cvlab-jnu --resource-group cvlab-rg
```

```bash
cd /home/site/wwwroot
npm run seed
npm run create-admin
```

If the SSH console misbehaves — it sometimes does on F1 — run both from your own machine
with `MONGODB_URI` temporarily pointed at the live Atlas string. It is the same database.

## Step 6 — Check it works

Get your real address first — **Overview → Default domain**, or:

```bash
az webapp show --name cvlab-jnu --resource-group cvlab-rg --query defaultHostName -o tsv
```

Call that `$SITE`. Then:

| URL | Expect |
|---|---|
| `https://$SITE/` | the site, fully populated |
| `https://$SITE/api/health` | `{"ok":true,…}` |
| `https://$SITE/admin` | the sign-in form |

Sign in, upload a photograph to a member, and confirm it appears on the public page. That
one action exercises the database, sharp, and the session cookie together — if it works,
the deployment is sound.

The first request after an idle period is slow, because F1 has no Always On. Subsequent
requests are fast.

---

## Managing storage — the limit that will actually bite you

Two separate quotas, easy to confuse:

| Store | Limit | Holds |
|---|---|---|
| Atlas M0 | **512 MB** | all content: text, photographs, course materials |
| App Service F1 | 1 GB | the deployed code only |

Photographs are not the problem. Course materials are.

A rough budget: a lecture deck exported to PDF is 2–15 MB, so the 512 MB fills after
perhaps 40–60 of them. The editor warns you past 380 MB, and this is what to do when it
does, cheapest first:

1. **Compress the PDFs before uploading.** Slide decks exported from PowerPoint embed
   images at full resolution. `ghostscript` typically cuts them by 60–80% with no visible
   loss:

   ```bash
   gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook \
      -dNOPAUSE -dQUIET -dBATCH -sOutputFile=small.pdf big.pdf
   ```

2. **Link the big things instead of uploading them.** Every course material row has an
   **External URL** field next to the upload. Datasets and video belong on Drive or an
   institutional store; the site just points at them. This is the right answer for
   anything over ~20 MB regardless of quota.

3. **Delete what students no longer need.** Previous semesters' materials can come out of
   the editor once the exam is done.

4. **Then, and only then, pay.** Atlas M10 is the first paid tier. It is billed by Atlas,
   not Azure, so it does not touch your student credit — but it is a real monthly cost, so
   exhaust the three free options first.

Check usage any time: sign in to the editor and start a file upload; the status line
reports the cluster's current storage. Atlas's own dashboard shows it too.

---

## Backups

Everything — text, photographs, course materials — is in MongoDB, so one `mongodump`
captures the site completely.

Atlas M0 does not include automated backups. Run this from your own machine, monthly:

```bash
mongodump --uri="<your MONGODB_URI>" --archive=cvlab-$(date +%F).gz --gzip
```

Restore:

```bash
mongorestore --uri="<your MONGODB_URI>" --archive=cvlab-YYYY-MM-DD.gz --gzip --drop
```

Keep the archives somewhere other than the laptop that made them.

---

## Watching the spend

Even on free tiers, set this up once — it takes two minutes and removes a category of
nasty surprise.

**Portal** → **Cost Management + Billing** → **Budgets** → **Add**:

- Amount: `$10`
- Alerts at 50%, 80%, 100% of budget, emailed to you.

If that ever fires while you are only running F1 and Atlas, something is running that you
did not intend. **Cost analysis** will name it.

Also worth knowing: **Cost Management** shows credit remaining and the expiry date. Look
at it now, so the date is not a surprise later.

---

## Later: a custom domain

F1 does not support custom domains, so a `jnu.ac.in` address means moving to B1 or above
— roughly $13/month, about 7 months of your credit. This is also the only way to get rid
of the hashed hostname: a custom domain replaces it entirely for visitors.

Before you spend it, ask JNU IT what they can host. You chair the Website and Social Media
Committee; a subdomain pointed at a school server costs nothing and outlives every credit.
`DEPLOY-UBUNTU.md` covers that path end to end.

If you do move to B1:

```bash
az appservice plan update --name cvlab-plan --resource-group cvlab-rg --sku B1
```

then **Custom domains → Add custom domain**, create the DNS records Azure asks for, and
add a **managed certificate** (free with the tier). Turn on **Always On** in
Configuration → General settings while you are there, which removes the cold start.

Your outbound IPs change when the plan changes — go back to step 3.

---

## Troubleshooting

**The URL has a long random hash in it** — expected. See *The URL will have a random hash
in it* under step 1. Your app name is still `cvlab-jnu`; only the hostname differs.

**The site is unreachable at `cvlab-jnu.azurewebsites.net`** — that short hostname does
not exist. Use the full one from **Overview → Default domain**.

**`Application Error` on the first load** — check the Log stream. Almost always either a
missing Application setting or Atlas refusing the connection; the app prints a specific
checklist for the latter.

**`Something went wrong installing the "sharp" module`** —
`SCM_DO_BUILD_DURING_DEPLOYMENT` is not set to `true`, so the wrong platform binary was
deployed. Set it, then redeploy.

**The site returns 403 and the logs are silent** — the F1 daily CPU quota is exhausted. It
resets at midnight UTC. **Quotas** in the portal confirms it. If this recurs, something is
polling the site, or it is time for B1.

**Login succeeds then bounces back to the form** — you have `INSECURE_HTTP=true` set. It
is for a plain-HTTP deployment on a bare IP; App Service is HTTPS, so remove it.

**Deployment succeeds but the site is the old version** — App Service caches
`/home/site/wwwroot`. Restart the app, and check the Deployment Center actually shows your
commit.

**Uploads fail with a write error, nothing else wrong** — the Atlas 512 MB ceiling. See
"Managing storage" above.

**First request after a quiet period takes 30+ seconds** — F1 has no Always On. Expected.
Do not "fix" it with a cron job pinging the site; that consumes your daily CPU quota for
no benefit.

---

## Sources

- [Azure App Service pricing — Linux](https://azure.microsoft.com/en-us/pricing/details/app-service/linux/) — F1 shared, 60 CPU minutes/day, 1 GB storage; B1 1 core, 1.75 GB RAM, 10 GB storage
- [Azure App Service plans](https://learn.microsoft.com/en-us/azure/app-service/overview-hosting-plans) — Free and Shared tiers run on a shared VM with CPU quotas and cannot scale out
- [Azure subscription and service limits](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits) — full per-tier limits table
- [Azure App Service quotas and metrics](https://learn.microsoft.com/en-us/azure/app-service/web-sites-monitor) — how quota usage is reported
