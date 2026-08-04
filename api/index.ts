// Vercel function entry (Bun runtime, bunVersion 1.x in vercel.json).
// On Vercel the intranet is unreachable, so scanning stays disabled
// (no INTRANET_ALLOW_SCAN) and the index is served read-only from Postgres.
import { handleApiRequest } from "../src/api";

export default {
  async fetch(request: Request): Promise<Response> {
    return handleApiRequest(request);
  },
};
