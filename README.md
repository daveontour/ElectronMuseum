# Digital Museum

A personal digital archive and AI-powered memory explorer packaged as an **Electron desktop app**. Digital Museum aggregates your emails, messages, photos, and social media into a single searchable SQLite archive, then lets you explore it through a conversational AI that has direct access to your data.

## Features

- **AI chat with tool access** — ask the AI to search your emails, messages, photos, Facebook posts, and more. Supports Anthropic Claude, Google Gemini, DeepSeek, and local Ollama/Gemma4.
- **Multi-source archiving** — import from Gmail/IMAP, WhatsApp, iMessage, Instagram, Facebook, and local filesystems.
- **Voice personalities** — choose how the AI responds: as an expert, a friend, or in the subject's own voice with a selectable mood.
- **Relationship tracking** — contact profiles, interaction graphs, and relationship analysis.
- **Sensitive data vault** — encrypted key-value store protected by a master key.
- **Custom voices** — create AI personas with custom instructions and creativity levels.
- **Today's Thing of Interest** — daily AI-generated prompts based on the subject's interests.
- **Reference documents** — attach documents for the AI to consult when answering questions; mark them to be inlined directly into every system prompt.
- **Statistics and visualisations** — email counts, contact maps, media timelines, and location maps.
- **Artefacts** — a place to store documents and images and the stories behind them.
- **Interview Mode** — have the AI interview you based on your background. Choose the style and purpose of the interview.
- **Random Question** — have the AI generate a random question based on your profile, then have the AI answer it.
- **Have a Chat** — start a conversation between two AIs about you and see where it goes.
- **Voice Input and Output** — create input via voice and listen to the response.
- **Visitor Access** — allow visitors access to your archive with fine-grained access control.
- **Admin Panel** — web-based user management, LLM usage reporting, and system instruction editing at `/admin`.

## Tech Stack

- **Desktop shell:** Electron (Node.js) — `electron/main.js` manages the Go server process, Ollama, system tray, and IPC
- **Backend:** Go 1.25, [Chi v5](https://github.com/go-chi/chi) router, `database/sql` with `modernc.org/sqlite`
- **Database:** SQLite (two files — main app DB and billing DB)
- **AI providers:** Anthropic Claude (`claude-sonnet-4-6`), Google Gemini (`gemini-2.5-flash`), DeepSeek (`deepseek-chat`), and local Ollama (`gemma4`)
- **Email:** IMAP via `go-imap`, Gmail via OAuth2
- **Frontend:** Vanilla JS, Leaflet (maps), Cytoscape (relationship graphs), Marked (Markdown), Highlight.js, Font Awesome

## Prerequisites

- Go 1.25+
- Node.js (for the Electron shell)
- At least one AI provider API key (Gemini, Anthropic, or DeepSeek), or a running Ollama instance

## Running

```bash
# Run dev Go server (reads .env automatically)
make run                # go run ./cmd/server

# Build the Go binary
make build-exe          # bin/digitalmuseum.exe

# Run the full Electron app in dev mode (from the electron/ directory)
npx electron .
```

On first run the server applies all migrations and seeds reference data from `static/data/`.

## Configuration (`.env`)

The server reads `.env` from the executable directory or working directory. In Electron, user-editable settings also live in `%APPDATA%\Digital Museum\.env` (layered on top).

### Database

| Variable | Required | Description |
|---|---|---|
| `SQLITE_PATH` | Yes | Absolute path to the main SQLite database file |
| `BILLING_SQLITE_PATH` | No | Absolute path to the billing SQLite database file (defaults to `billing.sqlite` next to main DB) |

### AI Providers (at least one required for chat)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key |
| `CLAUDE_MODEL_NAME` | Model override (default `claude-sonnet-4-6`) |
| `GEMINI_API_KEY` | Google Gemini API key |
| `GEMINI_MODEL_NAME` | Model override (default `gemini-2.5-flash`) |
| `DEEPSEEK_API_KEY` | DeepSeek API key (Anthropic-compatible endpoint) |
| `DEEPSEEK_MODEL_NAME` | Model override (default `deepseek-chat`) |
| `LOCALAI_BASE_URL` | Ollama base URL, e.g. `http://localhost:11434` |
| `LOCALAI_MODEL_NAME` | Ollama model name (default `local-model`; use `gemma4`) |
| `LOCALAI_API_KEY` | Not required by Ollama; kept for compatibility |
| `LOCALAI_EMBEDDING_MODEL` | Embedding model (falls back to `LOCALAI_MODEL_NAME`) |
| `TAVILY_API_KEY` | Tavily web search key (optional — enables AI web search) |

### Server

| Variable | Description |
|---|---|
| `HOST_PORT` | HTTP port (default `8000`; Electron overrides to `8081`) |
| `SESSION_COOKIE_SECURE` | Set `true` when running behind HTTPS |
| `TLS_CERT_FILE` | Path to TLS certificate file (both vars required for HTTPS) |
| `TLS_KEY_FILE` | Path to TLS private key file |
| `ENABLE_PPROF` | Set `true` to enable pprof on `:6060` |
| `DEPLOYMENT_NATURE` | `local` (Electron default) or `web` |
| `TEMPLATES_DIR` | Override templates directory path |
| `ASSET_STATIC_DIR` | Override static assets directory path |
| `LOG_LEVEL` | Go server log level: `debug`, `info`, `warn` (default), `error` |

### Admin

| Variable | Description |
|---|---|
| `ADMIN_EMAIL` | Email for initial admin user (created at startup if no admin exists) |
| `ADMIN_PASSWORD` | Password for initial admin user |

### Upload / Import

| Variable | Description |
|---|---|
| `TUS_CHUNK_SIZE_MB` | Chunk size (MB) for resumable tus uploads (default `10`) |
| `TUS_MAX_UPLOAD_GB` | Maximum ZIP/tus upload size in GiB (default `32`, max `512`) |
| `TUS_UPLOAD_DIR` | Directory for in-progress tus upload chunks (default: OS temp on Windows) |
| `ATTACHMENT_ALLOWED_TYPES` | Comma-separated MIME types to import (empty = all) |
| `ATTACHMENT_MIN_SIZE` | Minimum attachment size in bytes (default `0`) |
| `FILESYSTEM_IMPORT_EXCLUDE_PATTERNS` | Comma-separated glob patterns to skip during filesystem import |

### Gmail / OAuth2

| Variable | Description |
|---|---|
| `GMAIL_CLIENT_ID` | Google OAuth2 client ID |
| `GMAIL_CLIENT_SECRET` | Google OAuth2 client secret |
| `GMAIL_REDIRECT_URL` | OAuth2 callback URL (set automatically by Electron) |

### Import Defaults (all optional)

| Variable | Description |
|---|---|
| `DEFAULT_IMAP_HOST` | Pre-fill IMAP host in the import UI |
| `DEFAULT_IMAP_PORT` | Pre-fill IMAP port (default `993`) |
| `DEFAULT_IMAP_USERNAME` | Pre-fill IMAP username |
| `DEFAULT_IMESSAGE_DIRECTORY_PATH` | Default path to iMessage database directory |
| `DEFAULT_NEW_ONLY_OPTION` | Import only new items by default (`true`/`false`) |

## Data Import

Imports are managed from the **Data Import** panel. Supported sources:

| Source | Notes |
|---|---|
| **Facebook** | Requires a JSON archive downloaded from https://accountscenter.facebook.com/info_and_permissions/dyi |
| **Instagram** | Requires a JSON archive downloaded from https://accountscenter.facebook.com/info_and_permissions/dyi |
| **WhatsApp** | Upload a ZIP archive of an iMazing backup |
| **iMessage** | Upload a ZIP archive of an iMazing backup |
| **Gmail** | OAuth2 flow — link your Google account in settings |
| **IMAP** | Any IMAP mailbox with folder selection |
| **Filesystem** | Import images by directory or individual files |

All imports run as background jobs with real-time progress streamed to the UI.

## Seed Data Files

Three JSON files in `static/data/` are read at server startup and upserted into the database. Editing them and restarting is safe.

### `static/data/email_classifications.json`

Maps relationship-category labels to contact display names. Used during contact import to tag each contact with a relationship type.

```json
{
  "friend":       ["Alice Smith", "Bob Jones"],
  "family":       ["Carol Burton"],
  "colleague":    ["Dan Nguyen"],
  "acquaintance": ["Eve Taylor"],
  "business":     ["Acme Corp"],
  "social":       ["Book Club Group"],
  "promotional":  ["SomeBrand Newsletter"],
  "spam":         [],
  "important":    [],
  "unknown":      []
}
```

### `static/data/email_matches.json`

Maps a canonical display name to all email addresses that person has used. Consolidates messages from the same person under one name.

```json
[
  {
    "primary_name": "Alice Smith",
    "emails": ["alice@gmail.com", "alice.smith@work.com"]
  }
]
```

### `static/data/exclusions.json`

Patterns for senders that should be excluded from contact processing.

```json
{
  "email": ["noreply", "no-reply", "marketing"],
  "name":  ["marketing", "no-reply"],
  "name_email": [
    { "name": "Alice Smith", "email": "notifications@someservice.com" }
  ]
}
```

## Architecture

```
electron/
  main.js           ← Electron main process: spawns Go server + Ollama, IPC handlers, tray
  preload.js        ← IPC bridge (contextBridge) exposed to renderer pages
bin/
  digitalmuseum.exe ← Compiled Go server
  Ollama/           ← Bundled Ollama executable
cmd/server/         ← HTTP server entry point
internal/
  ai/               ← Claude, Gemini, DeepSeek & LocalAI providers, tool definitions & executor
  api/router/       ← Route wiring
  handler/          ← HTTP request handlers
  service/          ← Business logic
  repository/       ← Database access (database/sql + modernc.org/sqlite)
  model/            ← Shared data types / DTOs
  crypto/           ← Encryption and key derivation
  config/           ← Environment-based configuration
  database/         ← Migrations and connection pool
  middleware/        ← Logger, Recoverer, AuthMiddleware
  sqlutil/          ← SQLite dialect helpers
static/
  js/museum/        ← Frontend JavaScript modules
  css/              ← Stylesheets (museum_of.css)
  data/             ← Seed data (voice instructions, email classifications)
templates/          ← index.template.html (SPA), login.html, share.html
sqlc/               ← schema.sql (full DB schema reference)
```

## Security Notes

- Never commit `.env` or any file containing `KEYRING_PEPPER` or API keys.
- `KEYRING_PEPPER` is used to derive encryption keys for the sensitive data vault. Changing it will make existing encrypted data unreadable.
- Set `SESSION_COOKIE_SECURE=true` when deploying behind HTTPS.
- The master key system controls access to subject configuration, imported data management, and sensitive data. Visitor access is read-only by default.
- The admin panel (`/admin`) uses a separate session cookie (`dm_admin_sid`) and requires `is_admin = true` on the user row.
