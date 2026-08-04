import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import logoUrl from "../public/iiit-new.png";
import "./index.css";

type PageMeta = {
  kind?: string;
  description?: string;
  contentType?: string;
  contentLength?: number;
  redirectTo?: string;
};

type Result = { url: string; title: string; meta: PageMeta; fetched_at: string; snippet: string };
type BrowseItem = { url: string; title: string; meta: PageMeta; versions?: BrowseItem[] };
type BrowseGroup = { id: string; title: string; items: BrowseItem[] };
type TimelineEntry = { url: string; title: string; meta: PageMeta; modified: string };
type TimelinePeriod = { id: string; label: string; items: TimelineEntry[] };
type SearchResponse = { query: string; indexed: boolean; results: Result[] };
type BrowseResponse = { groups: BrowseGroup[] };
type TimelineResponse = { periods: TimelinePeriod[] };

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileName(url: string): string {
  const last = url.split("/").pop() ?? url;
  try {
    return decodeURIComponent(last) || url;
  } catch {
    return last;
  }
}

function fileKind(m: PageMeta): string {
  const ct = m.contentType ?? "";
  if (ct.includes("pdf")) return "PDF";
  if (ct.includes("spreadsheet") || ct.includes("excel")) return "Excel";
  if (ct.includes("word") || ct.includes("officedocument.word")) return "Word";
  if (ct.includes("jpeg") || ct.includes("png") || ct.includes("gif") || ct.includes("webp")) return "Image";
  if (ct.includes("zip")) return "ZIP";
  if (ct.includes("html")) return "Web page";
  const short = ct.split("/").pop();
  return short ? short.toUpperCase() : "File";
}

function metaLine(m: PageMeta): string {
  if (!m || !m.kind) return "";
  if (m.kind === "file") return `${fileKind(m)} · ${formatSize(m.contentLength)}`;
  if (m.kind === "redirect") return `Redirects to ${m.redirectTo ?? ""}`;
  if (m.kind === "html") return m.description || "Web page";
  return "";
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export function App() {
  const [tab, setTab] = useState<"search" | "browse">("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [indexed, setIndexed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browse, setBrowse] = useState<BrowseGroup[] | null>(null);
  const [browseError, setBrowseError] = useState(false);
  const [periods, setPeriods] = useState<TimelinePeriod[] | null>(null);
  const [timelineError, setTimelineError] = useState(false);
  const [scanEnabled, setScanEnabled] = useState(false);
  const [scanState, setScanState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [scanMessage, setScanMessage] = useState("");

  useEffect(() => {
    fetch("/api/scan")
      .then((r) => r.json() as Promise<{ enabled: boolean }>)
      .then((d) => setScanEnabled(d.enabled))
      .catch(() => setScanEnabled(false));
  }, []);

  useEffect(() => {
    if (tab === "browse" && browse === null && !browseError) {
      fetch("/api/browse")
        .then((r) => r.json() as Promise<BrowseResponse>)
        .then((d) => setBrowse(d.groups))
        .catch(() => setBrowseError(true));
    }
  }, [tab, browse, browseError]);

  useEffect(() => {
    if (periods === null && !timelineError) {
      fetch("/api/timeline")
        .then((r) => r.json() as Promise<TimelineResponse>)
        .then((d) => setPeriods(d.periods))
        .catch(() => setTimelineError(true));
    }
  }, [periods, timelineError]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setError(null);
      return;
    }
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json() as Promise<SearchResponse>)
        .then((d) => {
          setIndexed(d.indexed);
          setResults(d.results);
          setError(null);
        })
        .catch(() => {
          setIndexed(false);
          setResults([]);
          setError("Intranet unreachable from this network. Connect to the campus network or VPN.");
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  async function startScan() {
    setScanState("running");
    setScanMessage("");
    try {
      const r = await fetch("/api/scan", { method: "POST" });
      const d = (await r.json()) as { started?: boolean; error?: string };
      if (!r.ok || !d.started) throw new Error(d.error ?? `HTTP ${r.status}`);
      // Poll until the background crawl finishes.
      for (;;) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 2000);
        await promise;
        const s = (await (await fetch("/api/scan")).json()) as {
          running: boolean;
          last: { fetched?: number; failed?: number; error?: string } | null;
        };
        if (!s.running) {
          if (s.last?.error) throw new Error(s.last.error);
          setScanState("done");
          setScanMessage(`Scanned: ${s.last?.fetched ?? 0} pages indexed, ${s.last?.failed ?? 0} failed`);
          return;
        }
      }
    } catch (e) {
      setScanState("error");
      setScanMessage(e instanceof Error ? e.message : "Scan failed");
    }
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-4xl px-6 py-10">
      <header className="mb-8 flex items-center gap-4">
        <img src={logoUrl} alt="IIIT" className="h-14 w-14 rounded-xl object-cover shadow-sm" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">IIIT Intranet Index</h1>
          <p className="text-muted-foreground text-sm">Search across the campus intranet</p>
        </div>
        {scanEnabled && (
          <div className="ml-auto flex items-center gap-3">
            {scanState === "running" && <span className="text-sm text-muted-foreground">Scanning…</span>}
            {(scanState === "done" || scanState === "error") && (
              <span className="text-sm text-muted-foreground">{scanMessage}</span>
            )}
            <Button onClick={startScan} disabled={scanState === "running"} variant="outline">
              Scan &amp; update index
            </Button>
          </div>
        )}
      </header>

      <div className="mb-8 flex gap-1 rounded-lg border bg-muted/40 p-1 w-fit">
        <TabButton active={tab === "search"} onClick={() => setTab("search")}>
          Search
        </TabButton>
        <TabButton active={tab === "browse"} onClick={() => setTab("browse")}>
          Browse
        </TabButton>
      </div>

      {tab === "search" && (
        <>
          <form
            className="mb-10 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(query.trim());
            }}
            role="search"
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the intranet…"
              className="h-11 text-base"
              autoFocus
            />
            <Button type="submit" className="h-11 px-6">
              Search
            </Button>
          </form>

          {error && (
            <Card className="mb-6 border-destructive/40">
              <CardContent className="py-4 text-destructive">{error}</CardContent>
            </Card>
          )}

          {results === null && !error && (
            <>
              {timelineError && (
                <Card>
                  <CardContent className="py-8 text-center text-muted-foreground">
                    Could not load the timeline. Try again later.
                  </CardContent>
                </Card>
              )}
              {periods === null && !timelineError && <p className="text-muted-foreground">Loading…</p>}
              {periods !== null && (
                <div className="space-y-8">
                  {periods.map((p) => (
                    <section key={p.id}>
                      <h2 className="mb-3 flex items-baseline gap-2 text-lg font-semibold">
                        {p.label}
                        <span className="text-sm font-normal text-muted-foreground">{p.items.length}</span>
                      </h2>
                      <ul className="divide-y rounded-lg border bg-card">
                        {p.items.map((it) => (
                          <li key={it.url}>
                            <a
                              href={it.url}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-baseline justify-between gap-4 px-4 py-2 hover:bg-accent"
                            >
                              <span className="min-w-0 truncate text-sm">{it.title}</span>
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {metaLine(it.meta)}
                                {metaLine(it.meta) && " · "}
                                {formatDateShort(it.modified)}
                              </span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </>
          )}

          {results !== null && results.length === 0 && !error && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {indexed === false
                  ? "No index yet. Run `bun run crawl` on the campus network (or point DATABASE_URL at the shared Postgres)."
                  : `No results for “${query.trim()}”.`}
              </CardContent>
            </Card>
          )}

          {results !== null && results.length > 0 && (
            <ul className="space-y-4">
              {results.map((r) => (
                <li key={r.url}>
                  <Card className="gap-2 py-4">
                    <CardHeader className="gap-1 px-4 py-0">
                      <CardTitle className="text-base">
                        <a href={r.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                          {r.title || fileName(r.url)}
                        </a>
                      </CardTitle>
                      <CardDescription className="break-all">{r.url}</CardDescription>
                    </CardHeader>
                    <CardContent className="px-4 py-0">
                      <p className="text-sm text-muted-foreground">
                        {r.meta?.kind === "html" ? r.snippet || metaLine(r.meta) : metaLine(r.meta)}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">Indexed {formatDate(r.fetched_at)}</p>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {tab === "browse" && (
        <div className="space-y-8">
          {browseError && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                Could not load the directory. Try again later.
              </CardContent>
            </Card>
          )}
          {browse === null && !browseError && <p className="text-muted-foreground">Loading…</p>}
          {browse !== null &&
            browse.map((g) => (
              <section key={g.id}>
                <h2 className="mb-3 flex items-baseline gap-2 text-lg font-semibold">
                  {g.title}
                  <span className="text-sm font-normal text-muted-foreground">{g.items.length}</span>
                </h2>
                <ul className="divide-y rounded-lg border bg-card">
                  {g.items.map((it) => (
                    <li key={it.url}>
                      {it.versions ? (
                        <details className="px-4 py-2 group">
                          <summary className="flex cursor-pointer list-none items-baseline justify-between gap-4">
                            <span className="min-w-0 truncate text-sm font-medium">{it.title}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {it.versions.length} versions
                            </span>
                          </summary>
                          <ul className="mt-2 space-y-1 border-t pt-2">
                            {it.versions.map((v) => (
                              <li key={v.url} className="flex items-baseline justify-between gap-4 pl-2 text-xs">
                                <a
                                  href={v.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="min-w-0 truncate hover:underline"
                                >
                                  {v.title}
                                </a>
                                <span className="shrink-0 text-muted-foreground">
                                  {formatSize(v.meta.contentLength)}
                                  {v.meta.lastModified &&
                                    ` · ${new Date(v.meta.lastModified).toLocaleDateString(undefined, {
                                      month: "short",
                                      year: "numeric",
                                    })}`}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : (
                        <a
                          href={it.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-baseline justify-between gap-4 px-4 py-2 hover:bg-accent"
                        >
                          <span className="min-w-0 truncate text-sm">{it.title}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{metaLine(it.meta)}</span>
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
      )}
    </div>
  );
}

export default App;
