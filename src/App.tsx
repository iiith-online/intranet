import { useCallback, useEffect, useState } from "react";
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
type Page = { url: string; title: string; status: number; fetched_at: string };
type SearchResponse = { query: string; indexed: boolean; results: Result[] };
type PagesResponse = { pages: Page[] };

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function metaLine(r: Result): string {
  const m = r.meta ?? {};
  if (m.kind === "file") return `${m.contentType ?? "file"} · ${formatSize(m.contentLength)}`;
  if (m.kind === "redirect") return `Redirects to ${m.redirectTo ?? ""}`;
  return m.description ?? "";
}

export function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [indexed, setIndexed] = useState<boolean | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scanEnabled, setScanEnabled] = useState(false);
  const [scanState, setScanState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [scanMessage, setScanMessage] = useState("");

  const loadPages = useCallback(() => {
    fetch("/api/pages")
      .then((r) => r.json() as Promise<PagesResponse>)
      .then((d) => setPages(d.pages))
      .catch(() => setPages([]));
  }, []);

  useEffect(() => {
    loadPages();
    fetch("/api/scan")
      .then((r) => r.json() as Promise<{ enabled: boolean }>)
      .then((d) => setScanEnabled(d.enabled))
      .catch(() => setScanEnabled(false));
  }, [loadPages]);

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
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const s = (await (await fetch("/api/scan")).json()) as {
          running: boolean;
          last: { fetched?: number; failed?: number; error?: string } | null;
        };
        if (!s.running) {
          if (s.last?.error) throw new Error(s.last.error);
          setScanState("done");
          setScanMessage(`Scanned: ${s.last?.fetched ?? 0} pages indexed, ${s.last?.failed ?? 0} failed`);
          loadPages();
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
      <header className="mb-10 flex items-center gap-4">
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

      {results === null && !error && pages.length > 0 && (
        <section>
          <h2 className="mb-4 text-lg font-semibold">Indexed pages</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {pages.map((p) => (
              <Card key={p.url} className="gap-3 py-4">
                <CardHeader className="gap-1 px-4">
                  <CardTitle className="text-base">
                    <a href={p.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {p.title || p.url}
                    </a>
                  </CardTitle>
                  <CardDescription className="break-all">{p.url}</CardDescription>
                </CardHeader>
                <CardContent className="px-4 text-xs text-muted-foreground">
                  Indexed {formatDate(p.fetched_at)}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
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
              <Card className="gap-3 py-4">
                <CardHeader className="gap-1 px-4">
                  <CardTitle className="text-base">
                    <a href={r.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      {r.title || r.url}
                    </a>
                  </CardTitle>
                  <CardDescription className="break-all">{r.url}</CardDescription>
                </CardHeader>
                <CardContent className="px-4">
                  <p className="text-sm text-muted-foreground">{r.snippet || metaLine(r)}</p>
                  <p className="mt-2 text-xs text-muted-foreground">Indexed {formatDate(r.fetched_at)}</p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default App;
