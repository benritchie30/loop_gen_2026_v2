# Putting the site online

The public demo runs on one small rented Linux server (a VPS). Nothing about it is special
to a provider; these steps use Hetzner and Ubuntu 24.04 as the example.

```
visitor's browser ──https://loops.example.com──▶ Caddy (on the VPS)
                                                   ├─ /            the built UI (route-loop-finder/dist)
                                                   ├─ /ws          ─▶ python server.py (localhost:8765)
                                                   └─ /healthz     ─▶ python server.py
                                          server.py ─▶ /var/lib/loop-finder (map tiles, elevation cache)
```

- **Caddy** is the web server: it gets and renews the HTTPS certificate by itself, serves the
  UI's files, and passes `/ws` (the WebSocket) and `/healthz` to the backend.
- **The backend** runs as a system service (systemd): started at boot, restarted if it stops
  or runs out of memory, only allowed to write `/var/lib/loop-finder`.
- **Visitors' routes** stay in their browsers. The server keeps only map tiles (shared by
  everyone) and short-lived state in memory.

Cost: the server about $5–7 a month (4 GB of memory), a domain about $10–15 a year.

The files for all this are in `deploy/`:

| File | What it is |
|---|---|
| `setup.sh` | first-time setup of the server (packages, Caddy, firewall, swap, service, build) |
| `update.sh` | put the newest version from GitHub live |
| `Caddyfile` | the web server's configuration (the domain is filled in by `setup.sh`) |
| `loop-finder.service` | the backend as a system service |
| `loop-finder.env.example` | the backend's settings (becomes `/etc/loop-finder.env`) |
| `Caddyfile.local` | the same setup on your own computer, for a rehearsal (below) |
| `test_setup.sh` | tests `setup.sh` / `update.sh` on a Linux machine without a server |

---

## 0. Rehearse on your own computer (optional, 10 minutes)

The same setup as the server, on http://localhost:8080: Caddy serving the built UI and
forwarding `/ws` to the backend, with the site restriction on.

1. Get Caddy: download it from https://caddyserver.com/download (Windows amd64), rename the
   file to `caddy.exe` and put it in the project folder.
2. Build the UI: `cd route-loop-finder`, `npm run build`.
3. Start the backend with the site restriction (Anaconda Prompt, in `backend`):
   ```
   set LOOP_ALLOWED_ORIGINS=http://localhost:8080
   python server.py
   ```
4. Start Caddy from the project folder (another window):
   ```
   caddy.exe run --config deploy\Caddyfile.local
   ```
5. Open http://localhost:8080. It should work like `npm run dev`. What to check is in
   "Checks" at the end of this file.

---

## 1. Put the project on GitHub

The repository's top folder should be the project folder (the one with `backend/`,
`route-loop-finder/` and `deploy/`). If the project sits in a subfolder of the repository,
that works too; see the note in step 4.

`.gitignore` already keeps out what must not go up: `venv/`, `node_modules/`, `dist/` (built
on the server), `backend/map_data/` (downloaded map tiles), test output.

A **public** repository is simplest. A **private** one needs a deploy key so the server may
read it: on the server (after step 3) `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""`,
then `cat ~/.ssh/id_ed25519.pub`, and add that line on GitHub under the repository's
*Settings → Deploy keys* (read access only). Clone with the `git@github.com:...` address.

## 2. Rent the server

1. Make an SSH key on your computer if you have none (PowerShell): `ssh-keygen -t ed25519`.
   Press Enter at the questions. The public key is in `C:\Users\<you>\.ssh\id_ed25519.pub`.
2. At https://www.hetzner.com/cloud: create a project, then *Add server*:
   - Location: any (US locations are closer for US visitors).
   - Image: **Ubuntu 24.04**.
   - Type: shared vCPU with **4 GB** of memory (names and prices change; in 2025 that was
     CX22 in Europe or CPX21 in the US, around €4–8 a month). Keep the public IPv4 address.
   - SSH key: paste the contents of `id_ed25519.pub`.
3. Note the server's IPv4 address (e.g. `203.0.113.10`).
4. Log in: `ssh root@203.0.113.10` (answer `yes` the first time).

## 3. Point the domain at it

Buy a domain at any registrar (Cloudflare, Porkbun, Namecheap, ...) and, in its DNS settings,
add a record:

| Type | Name | Value |
|---|---|---|
| A | `loops` (or `@` for the bare domain) | the server's IPv4 address |

Then `loops.example.com` (your name) leads to the server. It can take a few minutes; check
with `nslookup loops.example.com` until it shows the address. **Do this before step 4:** Caddy
can only get the certificate once the name points at the server.

## 4. Set up the server

Logged in as root:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/YOU/REPO.git /opt/loop-finder
bash /opt/loop-finder/deploy/setup.sh loops.example.com you@example.com
```

The two arguments are the domain (no `https://`) and a contact for the public map data
servers (an email or your GitHub page; their usage policy asks that heavy users can be
reached). It takes a few minutes and prints each step; at the end "Done."

- Project in a subfolder of the repository: clone elsewhere and link the folder:
  `git clone ... /opt/loop-finder-repo && ln -s /opt/loop-finder-repo/SUBFOLDER /opt/loop-finder`
- A step failed: it says which. Fix the cause and run `setup.sh` again (it skips what is done).
- The settings file `/etc/loop-finder.env` is written once; later runs keep your edits.

### Bring your map tiles along (optional)

The map data you already downloaded at home works on the server too, so the places you
tried load at once instead of downloading again. From the project folder on your computer:

```
scp -r backend\map_data\tiles-v1 root@203.0.113.10:/var/lib/loop-finder/map_data/
```

then on the server: `chown -R loop-finder:loop-finder /var/lib/loop-finder/map_data`.

## 5. Check it

- https://loops.example.com opens the app (the first visit may take a minute: the certificate).
- https://loops.example.com/healthz shows `ok`.
- On the server, `journalctl -u loop-finder -n 30` shows the `Limits:` line with your domain
  under "sites allowed" and your contact, and no `WARNING`.
- Then the checks at the end of this file.

**Watch it from outside:** a free uptime monitor (for example UptimeRobot or Better Stack)
checking `https://loops.example.com/healthz` every few minutes emails you when the site is down.

**Test a long route once:** the largest searches need the most memory. Plan a 50 mi loop in a
big city (search a downtown) and watch memory on the server meanwhile:
`systemctl status loop-finder` (the `Memory:` line; the limit is 3 GB, with 2 GB of swap
behind it). If it gets close, lower `LOOP_MAX_AREAS` or `LOOP_MAX_MILES` (next section).

## 6. Running it

| Task | Command (on the server, as root) |
|---|---|
| Put a new version live (after `git push`) | `bash /opt/loop-finder/deploy/update.sh` |
| Backend output, live | `journalctl -u loop-finder -f` |
| Is it running, memory use | `systemctl status loop-finder` |
| Restart the backend | `systemctl restart loop-finder` |
| Change a setting | edit `/etc/loop-finder.env` (`nano /etc/loop-finder.env`), then restart |
| Web server output | `journalctl -u caddy -n 50` |
| Size of the map data | `du -sh /var/lib/loop-finder/map_data` |
| System updates | `apt-get update && apt-get upgrade`, then `reboot` if it asks (Ubuntu also installs security updates by itself) |

A change to `deploy/Caddyfile` or `deploy/loop-finder.service`: run `setup.sh` again (same
arguments) after `update.sh`. A restart or update disconnects visitors for a few seconds; their
browsers reconnect and their routes are safe (they are in the browser).

Settings (all in `RUNNING.md`): `LOOP_ALLOWED_ORIGINS` must be exactly the address in the
browser (`https://loops.example.com`; add `https://www.loops.example.com` with a comma if
you also serve that). The limits default to a 4 GB server: one search at a time, 4 map areas
and 12 generations in memory, routes up to 50 mi.

## 7. When something is wrong

| Symptom | Cause and fix |
|---|---|
| The site does not load, or a certificate warning | The domain does not point at the server yet (`nslookup`), or the first certificate is still being fetched. `journalctl -u caddy -n 50` says which. Ports 80 and 443 must be open (`ufw status`). |
| "Server Disconnected" all the time | The backend is not running (`systemctl status loop-finder`, then `journalctl -u loop-finder -n 50`), or the page's address is not in `LOOP_ALLOWED_ORIGINS`: the backend output then says `Refused a page from https://...`. |
| `/healthz` gives "502 Bad Gateway" | Caddy runs but the backend does not: as above. |
| The service stops at once with `status=31/SYS` | The system call filter blocked something Python needed. Delete the `SystemCallFilter=` line in `/etc/systemd/system/loop-finder.service`, `systemctl daemon-reload`, `systemctl restart loop-finder`, and note it (the repository's copy should change too). |
| The backend restarts during big searches (`oom` / `Killed` in its output) | Out of memory: lower `LOOP_MAX_AREAS` (e.g. 2) or `LOOP_MAX_MILES` (e.g. 40). |
| "Could not download map data" for new places | The public map data servers are busy or limiting; the backend already retries and switches servers. Try again later. |
| `npm run build` fails in `setup.sh` / `update.sh` | Read the first error. Ubuntu 24.04's Node.js 18 is enough for this project; if it says a newer Node.js is required, install Node.js 20 from https://github.com/nodesource/distributions and run the script again. |

---

## Checks (the rehearsal and the real site)

On http://localhost:8080 (rehearsal) or https://loops.example.com:

1. **It works:** the app loads, "Server Connected" shows briefly, finding loops works.
   `/healthz` shows `ok`.
2. **The privacy line** is under Advanced settings in the plan panel.
3. **A link into the app** (e.g. `/anything`) opens the app, not an error page.
4. **Other sites are refused:** rehearsal: open http://127.0.0.1:8080 instead of localhost.
   That is a different address to the browser, so it shows "Server Disconnected", and the
   backend says `Refused a page from http://127.0.0.1:8080: not in LOOP_ALLOWED_ORIGINS`.
5. **Browser caching:** developer tools (F12) → Network, reload. `index.html` has
   `Cache-Control: no-cache`; files under `/assets/` have `max-age=31536000, immutable` and
   come compressed (`Content-Encoding: gzip` or `zstd`). A made-up `/assets/nope.js` is a 404.
6. **Two visitors:** a normal and a private window, as in the earlier waiting-line test; both
   go through the site address.
7. **After an update** (real site): `update.sh`; an open tab shows "Server Disconnected" for a
   few seconds, then works again with its routes still there.
