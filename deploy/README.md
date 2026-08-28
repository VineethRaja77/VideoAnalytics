# Production deploy (Linux)

## 1. Install dependencies

```bash
sudo apt-get update
sudo apt-get install -y nodejs npm postgresql postgresql-contrib \
  gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav \
  gstreamer1.0-rtsp gstreamer1.0-vaapi gstreamer1.0-nice

# MediaMTX (no Docker dependency — single static binary)
curl -L -o /tmp/mediamtx.tar.gz \
  https://github.com/bluenviron/mediamtx/releases/download/v1.19.2/mediamtx_v1.19.2_linux_amd64.tar.gz
sudo tar -xzf /tmp/mediamtx.tar.gz -C /usr/local/bin mediamtx
sudo chmod +x /usr/local/bin/mediamtx
```

## 2. Create the `vms` service user and directories

```bash
sudo useradd -r -s /usr/sbin/nologin vms
sudo mkdir -p /etc/vms /var/lib/vms/recordings /var/log/vms /opt/vms
sudo chown -R vms:vms /var/lib/vms /var/log/vms
```

## 3. Database

```bash
sudo -u postgres createuser -P vms   # set a real password
sudo -u postgres createdb -O vms rest_express
```

## 4. App code + config

```bash
# Deploy the built app to /opt/vms (npm run build first), then:
sudo cp deploy/mediamtx.yml /etc/vms/mediamtx.yml
sudo cp deploy/vms.env.example /etc/vms/vms.env   # edit with real DATABASE_URL/SESSION_SECRET
sudo chown vms:vms /etc/vms/vms.env
sudo chmod 600 /etc/vms/vms.env

sudo cp deploy/vms-mediamtx.service /etc/systemd/system/
sudo cp deploy/vms-app.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vms-mediamtx vms-app
```

### 4a. Analytics Python environments — REQUIRED before any AI feature works

Each analytics module runs under its **own** interpreter at
`models/<module>/.venv/bin/python`. Build them:

```bash
cd /opt/vms
sudo -u vms ./scripts/install-models.sh          # all modules
sudo -u vms ./scripts/install-models.sh vehicle  # or just the ones licensed
```

Do not skip this. Without a module's venv the supervisor cannot start its
worker; the analytic silently produces no events. The server now refuses to
spawn such a worker and tells the client admin instead of restart-looping, but
the feature is still dead until this runs.

Why per-module and not one shared environment: PPE currently pulls in
`ultralytics` (AGPL-3.0) and `torch` (~5.8 GB), and neither belongs on a site
that only licensed vehicle counting. Separate environments keep an AGPL
dependency off disk entirely at sites that do not need it.

Model **weights** are not installed by this script — copy them into
`models/<module>/weights/`. Confirm both at boot:

```
🧩 model "vehicle": ok (checksums verified)
```

## 5. Domain, TLS, and firewall

This assumes the domain is proxied through Cloudflare (orange-cloud) with an
A/AAAA record pointing at this box's public IP, and that Cloudflare's
SSL/TLS mode is "Full" or "Full (strict)" (both work with the origin cert
below; "Flexible" would never actually reach nginx's TLS listener).

```bash
sudo apt-get install -y nginx certbot python3-certbot-dns-cloudflare

# Scoped Cloudflare API token: Zone - DNS - Edit, restricted to the one zone
# (dash.cloudflare.com -> profile -> API Tokens -> "Edit zone DNS" template)
echo "dns_cloudflare_api_token = <token>" | sudo tee /etc/vms/cloudflare-credentials.ini
sudo chmod 600 /etc/vms/cloudflare-credentials.ini

# DNS-01 challenge — no port 80 exposure needed for issuance, works fine
# behind Cloudflare's proxy (unlike HTTP-01, which needs a direct path in)
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/vms/cloudflare-credentials.ini \
  --dns-cloudflare-propagation-seconds 30 \
  -d your.domain.here --agree-tos -m you@example.com --non-interactive

# nginx reverse-proxies :443 -> 127.0.0.1:5002 (deploy/nginx-vms.hyperspark.in.conf
# is the config actually running — copy it as a reference for a new domain)
sudo cp deploy/nginx-websocket-upgrade.conf /etc/nginx/conf.d/websocket-upgrade.conf
sudo cp deploy/nginx-vms.hyperspark.in.conf /etc/nginx/sites-available/your.domain.here
sudo ln -s /etc/nginx/sites-available/your.domain.here /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
# IMPORTANT: if nginx was already running (e.g. auto-started by apt
# install), `enable --now` on an already-active service is a no-op and
# won't load a newly-added/changed site config — use `restart` explicitly:
sudo systemctl restart nginx

# certbot auto-renews via its own systemd timer; add a deploy hook so nginx
# actually picks up the renewed cert (it doesn't watch the files for changes)
sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/bash\nsystemctl reload nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# Firewall — only what genuinely needs to be public. Everything else
# (app:5002, MediaMTX's RTSP:8554/HLS:8888/WebRTC-HTTP:8889) is reverse-
# proxied through nginx already, or is a localhost-only connection
# (recordingWorker.ts's GStreamer processes, the Control API on 9997).
# WebRTC's ICE/media (8189/udp) is the one exception: it's a direct
# UDP path that bypasses both nginx and Cloudflare (Cloudflare's proxy
# doesn't carry arbitrary UDP), so it must stay open.
sudo ufw limit 22/tcp    # SSH, rate-limited — do this BEFORE enabling, or you can lock yourself out
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 8189/udp
sudo ufw enable
```

## Why GStreamer recorders aren't individual systemd units

At 300-1000 cameras, per-camera unit files would mean 300-1000 files to
generate/reload and no way to express staggered startup, exponential
backoff+jitter, or a stall watchdog — systemd's `Restart=` has no concept of
any of that. `recordingWorker.ts` supervises GStreamer child processes
directly in Node instead, co-located with the DB/MediaMTX calls it needs to
react to. `vms-app.service`'s own `Restart=always` plus a boot-time
reconciliation pass in `initRecordersFromDB()` covers the case where Node
itself crashes mid-recording.
