# IIIT Intranet Index

Crawls the IIIT intranet into a local SQLite + FTS5 index and serves a
searchable web UI over it.

## How it works

- `src/lib/crawler.ts` — BFS crawler (same-origin only, robots.txt
  exact-prefix disallow, rate limited, redirects recorded as 302 stubs) that
  stores extracted title/meta/text/links in `index/intranet.db` and rebuilds
  an FTS5 (`porter`) index after each run. Also exposes `search()` /
  `recentPages()` over that DB.
- `src/index.ts` — Bun server: `/api/search?q=…` (FTS5 phrase match with
  `LIKE` fallback for garbage queries), `/api/pages`, and the React UI.
  On first boot without an index it attempts an initial crawl.
- `src/App.tsx` — search UI with results, snippets, and an indexed-pages grid.

## Usage

```bash
bun install
bun run crawl          # build the index (needs campus network / VPN)
bun dev                # serve the UI + API on http://localhost:3000
bun start              # production serve (bun run build first)
bun test               # crawler self-check against a local fixture server
```

### Crawl options

```bash
bun run crawl --base-url https://intranet.iiit.ac --max-pages 500 --delay-ms 250 \
  --timeout-ms 10000 --cookie "session=…" --db index/intranet.db --fresh
```

- `--cookie` — session cookie for SSO-protected sections.
- `--fresh` — wipe the DB before crawling.
- Incremental re-crawl: run again without `--fresh`; pages are re-fetched and
  replaced (`INSERT OR REPLACE`). There is no skip-if-fresh logic: every run
  re-fetches up to `--max-pages`.
- `INTRANET_DB=/path/to/db` env var overrides the default DB location for
  both the crawler and the server.

## Notes / limitations

- **The host is `intranet.iiit.ac.in`** — `intranet.iiit.ac` (without `.in`)
  does not exist publicly (NXDOMAIN). The host answers on 10.4.21.84, so it
  is reachable from the campus network / VPN.
- The site's `/robots.txt` answers 400, so no robots rules are honored (the
  crawler treats a non-200 robots response as "no restrictions").
- Non-HTML files (PDF/XLS/…, ~450 on this site) are recorded with their URL
  and content type; filenames are searchable via the FTS index, contents are
  not. PDF text extraction is the known upgrade path.
- JS-rendered pages (if the intranet turns out to be a SPA) index as empty
  text. Adding a headless-render pass is the known upgrade path.
- Query strings are kept (tracking params are not stripped); hashes are.
- Non-200 pages are recorded (status only) so broken/login-gated links stay
  visible in `/api/pages`.
- robots.txt (when present): only exact-prefix `Disallow:` rules are honored;
  `Allow:`, wildcards and crawl-delay are ignored.
