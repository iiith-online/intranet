# IIIT Intranet Index

Crawls the IIIT intranet (`intranet.iiit.ac.in`) into a SQLite + FTS5 index,
mirrors it into Postgres (Neon), and serves a searchable web UI over it.
The site is only reachable from the campus network / VPN, so indexing runs
locally on a campus device — either via the CLI or a button in the UI — and
writes into the shared Postgres database.

## How it works

- `src/lib/crawler.ts` — BFS crawler (same-origin only, robots.txt
  exact-prefix disallow, rate limited, redirects recorded as stubs). Extracts
  title, meta tags, canonical link, link graph and text per HTML page; files
  (PDF/XLS/…) are **recorded with metadata only** (content-type, size,
  last-modified) — bodies are cancelled at fetch time. Stores into
  `index/intranet.db` (bun:sqlite, FTS5 porter) and, with `--push` or
  `DATABASE_URL`, upserts every page into Postgres plus a row in `scans`.
- `src/index.ts` — Bun server:
  - `/api/search?q=` — FTS phrase match (SQLite FTS5, or Postgres
    `to_tsvector`/`ts_headline` when `DATABASE_URL` is set), `LIKE` fallback
    for garbage queries.
  - `/api/pages` — recently indexed pages.
  - `/api/scan` — device-side scan. `POST` runs a full crawl in the
    background and upserts everything into Postgres; `GET` reports
    `{enabled, running, last}`. Guarded by `INTRANET_ALLOW_SCAN=1` because a
    deployment that cannot reach the intranet must not attempt it.
  - On boot, if the index is missing or empty, it auto-crawls (pushing to
    Postgres when configured).
- `src/App.tsx` — search UI with snippets, metadata (content type/size for
  files, redirect targets), recent-pages grid, and a "Scan & update index"
  button (visible when `/api/scan` reports enabled).

## Usage

```bash
bun install
bun run crawl                 # index the intranet locally (needs campus net/VPN)
bun run crawl --push          # ... and mirror the index into Postgres (DATABASE_URL)
bun dev                       # serve the UI + API on http://localhost:3000
bun test                      # crawler self-check against a local fixture server
```

### Environment

| Var | Meaning |
|---|---|
| `DATABASE_URL` | Neon/Postgres connection string. When set, the server reads from Postgres and `--push` crawls write to it. |
| `INTRANET_ALLOW_SCAN=1` | Enable the `/api/scan` endpoint (set it when running the server on the campus network). |
| `INTRANET_DB` | Override the SQLite index path (default `index/intranet.db`). |
| `PORT` | Server port (default 3000). |

### Crawl options

```bash
bun run crawl --base-url https://intranet.iiit.ac.in --max-pages 5000 --delay-ms 200 \
  --timeout-ms 10000 --cookie "session=…" --db index/intranet.db --fresh --push
```

- `--fresh` — wipe SQLite (and Postgres `pages`, when pushing) before crawling.
- `--max-pages 5000` is the default; the intranet currently exhausts its link
  graph at ~760 pages (43 HTML pages, ~710 files).
- `--cookie` — session cookie for SSO-protected sections.

### Device-side scanning (shared index)

The intranet does not resolve off-campus and serves no CORS headers, so a
browser cannot crawl it directly. Instead: run the app on a campus device
(`INTRANET_ALLOW_SCAN=1 DATABASE_URL=… bun start`), open the UI, and click
"Scan & update index" — or run `bun run crawl --push` from the CLI. Every
scan upserts pages into the shared Postgres and logs a row in `scans`.

## Notes / limitations

- **Host is `intranet.iiit.ac.in`** — `intranet.iiit.ac` (without `.in`) does
  not exist publicly (NXDOMAIN). The host answers on 10.4.21.84.
- `/robots.txt` answers 400, so no robots rules are honored.
- Non-HTML files are searchable by filename (URL is FTS-indexed); their
  contents are not downloaded. PDF text extraction is the known upgrade path.
- JS-rendered pages would index as empty text; headless rendering is the
  known upgrade path if the intranet turns SPA.
- Query strings are kept; hashes are dropped. Non-200 pages are recorded
  (status only) so broken/login-gated links stay visible.
- robots.txt (when present): only exact-prefix `Disallow:` rules are honored.
