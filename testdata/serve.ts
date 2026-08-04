/** Standalone fixture server for local smoke runs: `bun testdata/serve.ts`. */
import { serveFixtures } from "./fixtures";

const port = Number(process.env.PORT ?? 3999);
const server = serveFixtures({ port });
console.log(`fixture intranet up at ${server.url}`);
