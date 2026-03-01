# Hatchet Local Setup

Run podpiper as a persistent Hatchet worker on macOS, surviving reboots and crashes.

## Components

- **Docker Compose** (`docker-compose.hatchet.yml`) — Hatchet Lite + Postgres
- **Wrapper script** (`scripts/serve.sh`) — sources `.env` and runs `bun run src/cli/cli.ts serve`
- **launchd plist** (`com.podpiper.serve.plist`) — keeps the worker alive, restarts on crash

## First-Time Setup

### 1. Start Hatchet

```bash
docker compose -f docker-compose.hatchet.yml up -d
```

### 2. Get an API token

Open http://localhost:8888 and log in:

- Email: `admin@example.com`
- Password: `Admin123!!`

Go to **Settings > API Tokens**, create a token, and add it to `.env`:

```
HATCHET_CLIENT_TOKEN=<token>
```

### 3. Configure Docker Desktop to start on login

Open Docker Desktop > **Settings > General** > enable **"Start Docker Desktop when you sign in"**. The compose services have `restart: always`, so they come back with Docker.

### 4. Install the launchd agent

```bash
cp com.podpiper.serve.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.podpiper.serve.plist
```

The worker starts immediately and will auto-start on every login.

## Managing the Worker

```bash
# Check status
launchctl list | grep podpiper

# Stop
launchctl unload ~/Library/LaunchAgents/com.podpiper.serve.plist

# Start
launchctl load ~/Library/LaunchAgents/com.podpiper.serve.plist

# View logs
tail -f logs/serve.stdout.log
tail -f logs/serve.stderr.log
```

## How It Survives Restarts

1. macOS boots → Docker Desktop starts (login item)
2. Docker restarts Hatchet + Postgres containers (`restart: always`)
3. launchd starts `scripts/serve.sh` (`RunAtLoad` + `KeepAlive`)
4. The script polls `localhost:8888` until Hatchet is reachable, then starts the worker
5. If the worker crashes, launchd restarts it after 30s (`ThrottleInterval`)

## Updating the Plist

After editing `com.podpiper.serve.plist` in the repo, reinstall it:

```bash
bun run install-plist
```
