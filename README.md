# Ping

A small self-hosted monitor for a home server. Every minute it checks your apps, the disk and your backups, keeps an incident log, and sends a notification to your phone when something breaks and again when it recovers. No dependencies, one Node.js file, one Docker container.

## What it watches
- **Apps:** each target URL is requested every minute. An app counts as down after 2 failed checks in a row (configurable), so one slow response does not wake you up.
- **Disk:** usage of the disk that holds your backups. Alerts above 85%.
- **Backups:** the newest archive per volume in the backup folder must be recent (under 26 hours), not empty, and a readable gzip file. An old, missing or corrupt backup raises an alert.

Every alert opens an incident that is closed, with its duration, when the problem goes away.

## Dashboard
A password-protected page shows the services with 60 days of history, disk usage, the state of every backup, the incident log, and a **Send test alert** button. A separate public endpoint, `/status.json`, only exposes up/down, response time and uptime per app (no disk or backup details), so a portfolio page can show a status badge.

## Run it
Ping is built for the `srv` layout (a Caddy front door, one folder per app), but it works anywhere Docker does.
1. `cp .env.example .env` and set `PING_PASSWORD` and `NTFY_URL` (a private [ntfy](https://ntfy.sh) topic; install the ntfy app on your phone and subscribe to the same topic).
2. Edit `TARGETS` in `docker-compose.yml` to list your apps, and check that the backup folder in the `volumes` section points at your backups.
3. `docker compose up -d --build`, then open the dashboard and press **Send test alert**.

## Settings
| Variable | Default | Meaning |
|---|---|---|
| `PING_PASSWORD` | empty | Dashboard password. Empty disables the dashboard. |
| `NTFY_URL` | empty | Full ntfy topic URL. Empty means alerts are only logged. |
| `TARGETS` | `[]` | JSON list of `{name, url, path, note}` to check. |
| `FAILS_BEFORE_ALERT` | 2 | Failed checks in a row before an app counts as down. |
| `DISK_ALERT_PERCENT` | 85 | Disk usage that raises an alert. |
| `BACKUP_MAX_HOURS` | 26 | Age of the newest backup that raises an alert. |
| `INTERVAL_MS` | 60000 | Time between checks. |

## Security choices
- The container has **no access to Docker** (no socket) and reads the backup folder **read-only**. It can only make HTTP requests and read files.
- Dashboard password is compared in constant time, and 5 wrong attempts from one address lock it for a minute.
- The container runs as an unprivileged user with a read-only filesystem, no capabilities and `no-new-privileges`.
- The ntfy topic works like a password: anyone who knows it can send you notifications. Use a long random name.

## Tests
`npm test` starts the real server against fake apps and a fake ntfy server and checks: one alert per outage, a recovery alert, old and corrupt backups, the disk alert, the password and the login limit.

## Limits
- Checks run from the same machine they watch, so if the server or its internet connection is down, Ping cannot tell you. Pair it with an outside check (a free uptime service pinging your public address) if that matters.
- The disk figure comes from the backup folder's filesystem, which is right when backups live on the main disk.

MIT licensed.
