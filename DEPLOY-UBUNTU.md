# Deploying on your own Ubuntu server, reached by IP address

From a fresh Ubuntu server to a working site at `http://YOUR.SERVER.IP/`, with the whole
thing — public pages, API, and editor — on that one machine.

Roughly 30–40 minutes. Every command runs on the server over SSH.

---

## Read this before you start

### 1. No domain means no HTTPS. That has a real cost.

Certificate authorities do not issue certificates for bare IP addresses. Let's Encrypt
cannot, and neither can anyone else you would want to use. So the site runs on plain
`http://`, and:

- **Your admin password crosses the network in cleartext** every time you sign in.
  Anyone able to observe traffic between your browser and the server — someone on the
  same Wi-Fi, anyone operating a router along the path — can read it, and can copy your
  session cookie.
- **Use a password here that you use nowhere else.** Not your JNU password, not your
  email password. Treat it as compromised from the start.
- Browsers will mark the site "Not secure". That is accurate, not a glitch.

This is fine as a temporary state while you wait for a domain, and fine on a network you
control. It is not fine long-term for a page with a login. The last section of this guide
is the upgrade to a domain and a real certificate; do it when you can.

### 2. You cannot keep GitHub Pages with an HTTP API

A page served over HTTPS is not allowed to fetch from an `http://` address — browsers
block it as mixed content, with no way for you to override it. Your `github.io` pages are
HTTPS, so they cannot talk to an HTTP API on your server.

So while you have no certificate, **serve everything from this server**. That is what
this guide sets up, and it needs no code change: the Node app already serves `docs/`.
Once you have a domain and HTTPS you can go back to the split if you want it.

### 3. Check the IP is actually reachable

If your server sits on JNU's internal network, its address may only work from campus or
over the VPN. Find out before you debug anything else:

```bash
hostname -I                              # addresses the server itself sees
curl -s https://api.ipify.org; echo      # how the outside world sees it, if it has a route out
```

`10.x.x.x`, `172.16–31.x.x` and `192.168.x.x` are private. A private address will not work
from outside the network, no matter how correctly you configure everything below. If that
is your situation, it is worth asking JNU IT for either a public address or a DNS name
before going further — a name gets you HTTPS too, which fixes point 1.

---

## Step 1 — Log in and update

```bash
ssh youruser@YOUR.SERVER.IP
sudo apt update && sudo apt upgrade -y
```

A reboot may be needed if the kernel was updated:

```bash
[ -f /var/run/reboot-required ] && sudo reboot
```

## Step 2 — Create a user for the app

The app should not run as root, and not as you. A dedicated system account with no login
shell means a flaw in the web app cannot become a shell on your server.

```bash
sudo useradd --system --create-home --home-dir /srv/cvlab --shell /usr/sbin/nologin cvlab
```

Check it:

```bash
id cvlab
```

## Step 3 — Install Node.js

Ubuntu's own `nodejs` package is usually too old. Use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify — and note the path, because the systemd unit needs it:

```bash
node -v          # expect v22.x
which node       # expect /usr/bin/node
```

If `which node` prints something else, edit `ExecStart` in the service file at step 7.

## Step 4 — Install MongoDB

Two choices.

### Option A — MongoDB on this server (recommended)

Keeps the data on your machine, needs no IP allow-list, and has no network latency.

Ubuntu does not package MongoDB, so use MongoDB's own repository. **Check the current
version** at <https://www.mongodb.com/docs/manual/administration/install-community/> —
`8.0` below was current at the time of writing and the number changes:

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
  | sudo gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg

echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/8.0 multiverse" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list

sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
```

Check it is running and, importantly, that it is **only** listening on localhost:

```bash
sudo systemctl status mongod --no-pager
ss -tlnp | grep 27017
```

You want to see `127.0.0.1:27017`. If it shows `0.0.0.0:27017`, MongoDB is exposed to the
whole network with no password — fix it now in `/etc/mongod.conf`:

```yaml
net:
  port: 27017
  bindIp: 127.0.0.1
```

then `sudo systemctl restart mongod`. Because it only listens on localhost, a database
password is not strictly required; the firewall in step 8 is the second layer.

Two things that can bite you: MongoDB 8.x needs a CPU with AVX support, so a very old
machine may need MongoDB 4.4; and if `apt update` reports the repository is not found,
your Ubuntu release is probably not supported by that MongoDB version — check the docs
page above for which releases are.

Your connection string is then:

```
mongodb://127.0.0.1:27017/cvlab
```

### Option B — MongoDB Atlas

If you would rather not run a database, use the Atlas cluster from the main README. Your
server has a fixed IP, so you can add just that one address to Atlas → Network Access
instead of `0.0.0.0/0` — better than the free-host situation. Use the `mongodb+srv://…`
string in step 6.

## Step 5 — Put the code on the server

### From GitHub (easiest to update later)

```bash
sudo apt install -y git
sudo -u cvlab git clone https://github.com/akjiitbhu/cvlab-jnu.git /srv/cvlab/app
```

`/srv/cvlab` is the `cvlab` user's home, so the code lands in `/srv/cvlab/app`. The rest
of this guide uses that path — adjust if you put it elsewhere.

### Or upload the zip from your own machine

```bash
scp cvlab-jnu-website.zip youruser@YOUR.SERVER.IP:/tmp/
```

then on the server:

```bash
sudo apt install -y unzip
sudo unzip /tmp/cvlab-jnu-website.zip -d /srv/cvlab/
sudo mv /srv/cvlab/cvlab-jnu /srv/cvlab/app
sudo chown -R cvlab:cvlab /srv/cvlab/app
```

Install dependencies:

```bash
cd /srv/cvlab/app
sudo -u cvlab npm ci --omit=dev
```

## Step 6 — Configuration

Generate a signing key:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Create the environment file:

```bash
sudo -u cvlab tee /srv/cvlab/app/.env >/dev/null <<'EOF'
MONGODB_URI=mongodb://127.0.0.1:27017/cvlab
JWT_SECRET=PASTE_THE_64_CHARACTERS_HERE
NODE_ENV=production

# No domain yet, so no certificate, so no HTTPS. This tells the app to send the
# session cookie WITHOUT the Secure flag — otherwise the browser silently
# discards it over http:// and the login appears to succeed and then fail.
# DELETE THIS LINE the moment you have a domain and a certificate.
INSECURE_HTTP=true

# Everything is served from this one machine, so there is no second origin to
# allow. Leave SITE_ORIGIN unset.
EOF
```

Lock the file down — it holds your secrets, and the systemd unit is world-readable:

```bash
sudo chmod 600 /srv/cvlab/app/.env
sudo chown cvlab:cvlab /srv/cvlab/app/.env
```

Point the pages at their own origin. `docs/assets/config.js` must have an empty
`API_BASE`, which is how it ships — check:

```bash
grep API_BASE /srv/cvlab/app/docs/assets/config.js    # expect: API_BASE: '',
```

## Step 7 — Load content and create your login

```bash
cd /srv/cvlab/app
sudo -u cvlab npm run seed
sudo -u cvlab --preserve-env=HOME npm run create-admin
```

`create-admin` prompts for a username and password. Nothing is echoed, and only the
bcrypt hash is stored.

**Because this is running over HTTP, choose a password you use nowhere else.** At least
12 characters; four unrelated words is easier to type and harder to guess than a short
scramble.

Confirm it starts before wiring up systemd:

```bash
sudo -u cvlab node server.js
```

You should see the `INSECURE_HTTP` warning block, then `[db] connected` and
`[server] listening on http://localhost:3000`. Press `Ctrl-C`.

## Step 8 — Run it as a service

```bash
sudo cp /srv/cvlab/app/deploy/cvlab.service /etc/systemd/system/cvlab.service
```

The shipped unit expects the app in `/srv/cvlab` — point it at `/srv/cvlab/app`:

```bash
sudo sed -i 's#/srv/cvlab#/srv/cvlab/app#g' /etc/systemd/system/cvlab.service
sudo systemctl daemon-reload
sudo systemctl enable --now cvlab
sudo systemctl status cvlab --no-pager
```

Logs:

```bash
sudo journalctl -u cvlab -f          # follow
sudo journalctl -u cvlab -n 50       # last 50 lines
```

Check it answers locally:

```bash
curl -s http://127.0.0.1:3000/api/health; echo
```

Expect `{"ok":true,…}`. If `ok` is `false`, Node is running but cannot reach MongoDB — the
log will say which of the causes it is.

The unit is deliberately hardened: read-only filesystem, no access to `/home`, no new
privileges, a system-call filter. Nothing in the app needs to write to disk, so if you
later add file uploads you will need to grant exactly that one directory with
`ReadWritePaths=` and nothing more.

## Step 9 — Put nginx in front

Node listens on 3000. Visitors expect port 80. Binding 80 directly needs root, which the
app must not have, so nginx handles it — and serves the static files without waking Node.

```bash
sudo apt install -y nginx

sudo cp /srv/cvlab/app/deploy/nginx-cvlab.conf /etc/nginx/sites-available/cvlab
sudo sed -i 's#/srv/cvlab/docs#/srv/cvlab/app/docs#g' /etc/nginx/sites-available/cvlab

sudo ln -sf /etc/nginx/sites-available/cvlab /etc/nginx/sites-enabled/cvlab
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t
sudo systemctl reload nginx
```

`nginx -t` must say *test is successful* before you reload. If it fails with

```
[emerg] socket() [::]:80 failed (97: Address family not supported by protocol)
```

your server has IPv6 disabled. The IPv6 `listen` line is already commented out in the
shipped config for exactly this reason; if you uncommented it, put it back. Check what you
have with `ip -6 addr show`.

The static-file paths in that config need `docs/` to be readable by nginx's user:

```bash
sudo chmod o+rx /srv/cvlab /srv/cvlab/app /srv/cvlab/app/docs
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/assets/site.css
```

A `200` means nginx is reading the file itself. A `502` means it fell through to Node,
which still works but wastes the optimisation.

## Step 10 — Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw enable
sudo ufw status verbose
```

Allow SSH **before** enabling, or you will lock yourself out of your own server.

Note what is *not* opened: 3000 and 27017 stay closed. Node and MongoDB are reachable only
from the machine itself, through nginx. Confirm from your own laptop:

```bash
curl -m 5 http://YOUR.SERVER.IP:3000/    # should hang then fail — correct
curl -m 5 http://YOUR.SERVER.IP:27017/   # should hang then fail — correct
```

## Step 11 — Check it works

In a browser on another machine:

| URL | Expect |
|---|---|
| `http://YOUR.SERVER.IP/` | the lab site, fully populated |
| `http://YOUR.SERVER.IP/api/health` | `{"ok":true,…}` |
| `http://YOUR.SERVER.IP/admin` | the sign-in form |

Sign in, change something, reload the public page, confirm it appears. **If the login
bounces you straight back to the form, `INSECURE_HTTP=true` is missing or misspelled in
`.env`** — that is the one failure this whole setup is most likely to produce. Check with:

```bash
sudo grep INSECURE /srv/cvlab/app/.env
sudo journalctl -u cvlab -n 40 | grep -A2 INSECURE
```

The startup warning block must be in the log. If it is not, the variable is not reaching
the process — check the `EnvironmentFile` path in the unit matches where `.env` actually
is.

---

## Updating the site later

```bash
cd /srv/cvlab/app
sudo -u cvlab git pull
sudo -u cvlab npm ci --omit=dev
sudo systemctl restart cvlab
```

Content changes — members, publications, courses, metrics — need none of this. They go
through `/admin` and take effect immediately.

Course PDFs are the exception, since they are files: put them in
`/srv/cvlab/app/docs/files/`, either by committing and pulling, or directly:

```bash
sudo -u cvlab mkdir -p /srv/cvlab/app/docs/files/dip
sudo -u cvlab cp ~/unit1-slides.pdf /srv/cvlab/app/docs/files/dip/
```

then reference `/files/dip/unit1-slides.pdf` in the material's URL field.

## Back up the database

Everything you type into the editor lives in MongoDB — **including uploaded
photographs**, which are stored as documents rather than files on disk. That means this
one backup covers the whole site's content; there is no separate uploads directory to
remember. Without it, one bad disk loses the lot.

```bash
sudo mkdir -p /var/backups/cvlab
sudo tee /usr/local/bin/cvlab-backup >/dev/null <<'EOF'
#!/bin/bash
set -euo pipefail
STAMP=$(date +%F)
OUT=/var/backups/cvlab
mongodump --uri="mongodb://127.0.0.1:27017/cvlab" --archive="$OUT/cvlab-$STAMP.gz" --gzip --quiet
# keep 30 days
find "$OUT" -name 'cvlab-*.gz' -mtime +30 -delete
echo "backed up to $OUT/cvlab-$STAMP.gz"
EOF
sudo chmod +x /usr/local/bin/cvlab-backup
sudo /usr/local/bin/cvlab-backup
```

Daily at 02:30:

```bash
echo '30 2 * * * root /usr/local/bin/cvlab-backup >> /var/log/cvlab-backup.log 2>&1' \
  | sudo tee /etc/cron.d/cvlab-backup
```

A backup on the same disk is only half a backup — copy the archives off the machine
periodically. To restore:

```bash
mongorestore --uri="mongodb://127.0.0.1:27017" --archive=/var/backups/cvlab/cvlab-YYYY-MM-DD.gz --gzip --drop
```

## Refresh the citation figures on a schedule

This server has cron, so unlike a free host it can do this by itself:

```bash
echo '0 6 * * 1 cvlab cd /srv/cvlab/app && /usr/bin/node scripts/refresh-metrics.js >> /var/log/cvlab-metrics.log 2>&1' \
  | sudo tee /etc/cron.d/cvlab-metrics
sudo touch /var/log/cvlab-metrics.log && sudo chown cvlab /var/log/cvlab-metrics.log
```

Read the "Keeping the citation figures current" section of the README first — it explains
why this reads OpenAlex rather than Google Scholar, and why the number will differ.

---

## When you get a domain: switching to HTTPS

This is the step that removes the cleartext-password problem. Do it as soon as you have a
name pointing at the server.

**1. DNS.** Create an `A` record for the name pointing at the server's public IP. Confirm
it has propagated before continuing — certbot will fail otherwise:

```bash
dig +short lab.example.ac.in
```

**2. Tell nginx the name:**

```bash
sudo sed -i 's/server_name _;/server_name lab.example.ac.in;/' /etc/nginx/sites-available/cvlab
sudo nginx -t && sudo systemctl reload nginx
```

**3. Get the certificate.** Certbot edits the nginx config and sets up renewal:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d lab.example.ac.in
```

Choose the redirect option when asked, so `http://` sends visitors to `https://`.

**4. Open 443:**

```bash
sudo ufw allow 443/tcp
```

**5. Turn the security back on.** This is the part people forget, and leaving it is worse
than never having set it:

```bash
sudo sed -i '/^INSECURE_HTTP/d' /srv/cvlab/app/.env
sudo systemctl restart cvlab
sudo journalctl -u cvlab -n 30 | grep INSECURE     # must print nothing now
```

The cookie gets its `Secure` flag back, HSTS is sent, and the CSP upgrades insecure
requests.

**6. Change your admin password.** The old one travelled in cleartext for however long
the site ran on HTTP; treat it as known:

```bash
cd /srv/cvlab/app && sudo -u cvlab --preserve-env=HOME npm run create-admin
```

**7. Renewal** is automatic via a systemd timer. Confirm it:

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

---

## Troubleshooting

**`http://IP/` times out** — a network problem, not an app problem. Check `sudo ufw status`
shows 80 allowed, `sudo systemctl status nginx` is active, and whether the address is
private (see the start of this guide). A cloud provider may also have its own firewall or
security group in front of the machine.

**502 Bad Gateway** — nginx is up, Node is not. `sudo systemctl status cvlab` and
`sudo journalctl -u cvlab -n 50`.

**The site loads but every section says "could not be loaded"** — Node is up, MongoDB is
not. `curl -s http://127.0.0.1:3000/api/health`; if `ok` is false, check
`sudo systemctl status mongod`. The app prints a specific checklist for whichever cause it
detects.

**Login succeeds then immediately bounces back to the form** — the `Secure` cookie problem.
`INSECURE_HTTP=true` must be in `.env` and the warning block must be in the startup log.

**The page loads with no styling** — the stylesheet is not being served. Try
`curl -I http://127.0.0.1/assets/site.css`. A 403 means nginx's user cannot traverse the
directories; re-run the `chmod o+rx` from step 9. If you had set `INSECURE_HTTP` wrongly,
`upgrade-insecure-requests` would also break assets — check the startup log.

**`nginx -t` fails on `[::]:80`** — IPv6 disabled; keep that `listen` line commented out.

**Editing files does nothing** — you edited the repo but did not restart:
`sudo systemctl restart cvlab`. Static files under `docs/` do not need a restart, but your
browser may be caching them; hard-reload.

**MongoDB will not install** — your Ubuntu release may not be supported by that MongoDB
version, or the CPU may lack AVX. Check the version and supported releases at the MongoDB
docs link in step 4, or fall back to Atlas (Option B).

---

## Security checklist for this deployment

Done for you by the steps above:

- [x] App runs as a dedicated non-login user, not root
- [x] systemd unit hardened: read-only filesystem, no `/home`, syscall filter
- [x] MongoDB listens on `127.0.0.1` only
- [x] Firewall allows only SSH and 80; 3000 and 27017 are not reachable from outside
- [x] Secrets in `.env`, mode 600, owned by `cvlab`, never in git
- [x] nginx hides its version and caps request bodies
- [x] Real client IP forwarded, so the login rate limiter works per visitor
- [x] Login rate limited and the account locks after 8 failures

Your responsibility:

- [ ] **A unique admin password** — it is sent in cleartext until you have HTTPS
- [ ] SSH keys rather than password login (`PasswordAuthentication no` in
      `/etc/ssh/sshd_config`)
- [ ] `sudo apt update && sudo apt upgrade` on a schedule, or `unattended-upgrades`
- [ ] Backups copied off the machine
- [ ] **Get a domain and run certbot**, then delete `INSECURE_HTTP` and change the password

The last one is the one that matters. Everything else here is solid; running a login over
plain HTTP is the single genuine weakness, and it is temporary by choice.

---

## Appendix: Oracle Cloud Always Free — a server that never sleeps, for ₹0

If you want a site that never cold-starts and you do not want to spend anything, this is
the one platform that can do it without a card. Oracle's **Always Free** tier includes
real virtual machines, and a VM does not sleep — there is nothing to wake.

What you get, for the life of the account:

| | |
|---|---|
| Ampere A1 (ARM) | **1,500 OCPU hours and 9,000 GB hours per month** — enough to run **2 OCPUs and 12 GB of memory** continuously |
| or AMD micro | **two** `VM.Standard.E2.1.Micro` instances, **1/8 OCPU and 1 GB** each |
| Block storage | **200 GB** total, five volume backups |
| Outbound data | **10 TB per month** |
| Expiry | none — "for the life of the account" |

Either shape runs this site. The A1 is enormously more than it needs; even a 1 GB micro
instance is adequate for a lab site with MongoDB alongside, though you should add swap.

Follow this guide from Step 1 once the instance exists. Three things differ, and the
first one is the one nobody warns you about.

### 1. Oracle may delete an idle instance. Read this before you rely on it.

From Oracle's own documentation:

> "Idle Always Free compute instances may be reclaimed by Oracle. Oracle will deem virtual
> machine and bare metal compute instances as idle if, during a 7-day period, the following
> are true: CPU utilization for the 95th percentile is less than 20%; Network utilization is
> less than 20%; Memory utilization is less than 20% (applies to A1 shapes only)."

**A quiet lab website sits far below all of those.** This is a genuine risk of losing the
server, not a theoretical one, and most guides recommending Oracle's free tier never
mention it.

What to do about it, honestly:

- **Keep backups off the machine.** The `cvlab-backup` script above, with the archives
  copied somewhere else. Then losing the VM costs you an afternoon, not the site.
- **Upgrade the account to Pay As You Go.** Oracle states: *"Oracle doesn't charge for
  Always Free resources after you upgrade, and will only charge you for resource usage
  above the Always Free limits."* That removes the reclamation risk and still costs $0
  while you stay inside the limits — but it requires a card on file, and going over a
  limit then bills you. If "not a penny" is a hard rule, do not do this.
- **Treat it as a good free option, not a permanent home.** A JNU server has no such
  clause. See the end of this appendix.

Do not try to defeat the check by generating artificial load. It burns the shared
resources the free tier depends on, and the network criterion makes it a losing game.

### 2. The firewall has TWO layers, and `ufw` is the wrong tool here

Step 10 of this guide uses `ufw`. **On Oracle's Ubuntu images, do not.** Oracle's
documentation is explicit:

> "the use of UFW is discouraged because it can lead to serious trouble. UFW is therefore
> disabled by default."

OCI Ubuntu images ship iptables rules that accept SSH only, and those rules sit *behind*
the cloud-level firewall. Both must be opened or the site is unreachable with no error to
read:

**Layer 1 — the virtual network.** Console → your instance → *Virtual cloud network* →
*Security Lists* → the default list → **Add Ingress Rules**:

| Field | Value |
|---|---|
| Source CIDR | `0.0.0.0/0` |
| IP Protocol | TCP |
| Destination Port Range | `80` |

**Layer 2 — the host.** On the instance, add the rule *before* the final REJECT:

```bash
sudo sed -i '/-A INPUT -j REJECT/i -A INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT' \
  /etc/iptables/rules.v4
sudo iptables-restore < /etc/iptables/rules.v4
sudo iptables -L INPUT -n --line-numbers | head -20
```

You should see the port 80 ACCEPT above the REJECT. Skip step 10's `ufw` commands
entirely — leave UFW disabled.

If the site is unreachable from outside but `curl http://127.0.0.1/` works on the
instance, it is one of these two layers, and layer 2 is the usual culprit.

### 3. On ARM, check the two native pieces

The A1 shape is `arm64`, and two dependencies compile native code:

- **sharp** ships prebuilt `linux-arm64` binaries, so `npm ci` works unchanged.
- **MongoDB** publishes `arm64` packages; the apt line in step 4 already includes
  `arch=amd64,arm64`, so it works as written.

Verify after installing:

```bash
node -e "console.log(require('sharp').versions)"
mongod --version | head -1
```

On a 1 GB micro instance, add swap before installing MongoDB or the install can be killed:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### And the option that beats all of this

A server from JNU's School of Engineering is free to you, never sleeps, has no
reclamation clause, and comes with a `jnu.ac.in` address — which also gets you HTTPS and
removes the hashed Azure hostname problem in one move. You chair the Website and Social
Media Committee. Ask before you invest a weekend in Oracle.
