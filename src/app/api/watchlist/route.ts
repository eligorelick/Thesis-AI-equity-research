/**
 * /api/watchlist — CRUD over the watchlist table (the application contract §8 sidebar).
 *
 * Contract:
 *   GET                         → 200 { watchlist: WatchlistEntry[] }   (raw rows)
 *   POST   { symbol: string }   → 200 { watchlist: WatchlistEntry[] }   (after add)
 *   DELETE { symbol: string }   → 200 { watchlist: WatchlistEntry[] }   (after remove)
 *
 * Tickers are validated (alphanumeric + . / -) and normalized to UPPERCASE by
 * the data layer. All three verbs return the updated raw list so the client can
 * update optimistically; the enriched sidebar view is rebuilt by a
 * router.refresh() on the server component.
 *
 * Server-only route (nodejs runtime): imports @/db via the watchlist data layer.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSameOrigin } from "@/app/api/sameOrigin";
import { SYMBOL_MAX_LENGTH, SYMBOL_PATTERN } from "@/symbol";
import {
  addToWatchlist,
  listWatchlist,
  removeFromWatchlist,
  type WatchlistEntry,
} from "@/watchlist/watchlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const symbolBody = z.object({
  symbol: z
    .string()
    .trim()
    .min(1, "symbol is required")
    .max(SYMBOL_MAX_LENGTH, "symbol too long")
    .regex(SYMBOL_PATTERN, "symbol must start/end alphanumeric (with . or - inside)"),
});

interface WatchlistPayload {
  watchlist: WatchlistEntry[];
}

export function GET(): NextResponse<WatchlistPayload> {
  return NextResponse.json({ watchlist: listWatchlist() });
}

export async function POST(request: Request): Promise<NextResponse> {
  // CSRF trust boundary: reject provably cross-site browser requests before
  // parsing or touching the table.
  const crossSite = assertSameOrigin(request);
  if (crossSite !== null) return crossSite;

  const parsed = await parseSymbol(request);
  if ("error" in parsed) return parsed.error;
  addToWatchlist(parsed.symbol);
  return NextResponse.json({ watchlist: listWatchlist() });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const crossSite = assertSameOrigin(request);
  if (crossSite !== null) return crossSite;

  const parsed = await parseSymbol(request);
  if ("error" in parsed) return parsed.error;
  removeFromWatchlist(parsed.symbol);
  return NextResponse.json({ watchlist: listWatchlist() });
}

/** Parse + validate the { symbol } body, or return a 400 NextResponse. */
async function parseSymbol(
  request: Request,
): Promise<{ symbol: string } | { error: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      error: NextResponse.json({ error: "request body must be JSON" }, { status: 400 }),
    };
  }
  const result = symbolBody.safeParse(raw);
  if (!result.success) {
    return {
      error: NextResponse.json(
        { error: "invalid request", issues: result.error.issues },
        { status: 400 },
      ),
    };
  }
  return { symbol: result.data.symbol };
}
