import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { watchlist } from "@/db/schema";
import { addToWatchlist, removeFromWatchlist } from "@/watchlist/watchlist";

/**
 * The watchlist key was only uppercased, not canonicalized, so `BRK.B` and
 * `BRK-B` produced two rows for one company. Every report and run read now
 * folds that share-class alias, so both rows would resolve to the same report
 * and the sidebar would list the company twice.
 *
 * The stored spelling stays as the user entered it — provider lookups use it —
 * but a second spelling of the same entity must not create a second row.
 */
let handle: DatabaseHandle;

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
});

afterEach(() => {
  setDbForTests(null);
  handle.sqlite.close();
});

const rows = () => handle.db.select().from(watchlist).all();

describe("watchlist share-class alias handling", () => {
  it("does not add a second row for the other separator spelling", () => {
    addToWatchlist("BRK.B");
    addToWatchlist("BRK-B");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.symbol).toBe("BRK.B");
  });

  it("is case-insensitive as before", () => {
    addToWatchlist("aapl");
    addToWatchlist("AAPL");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.symbol).toBe("AAPL");
  });

  it("still stores genuinely different tickers separately", () => {
    addToWatchlist("AAPL");
    addToWatchlist("MSFT");

    expect(rows()).toHaveLength(2);
  });

  it("removes the entry from either spelling", () => {
    addToWatchlist("BRK.B");
    removeFromWatchlist("BRK-B");

    expect(rows()).toHaveLength(0);
  });

  it("returns the spelling that is actually stored", () => {
    expect(addToWatchlist("BRK.B")).toBe("BRK.B");
    // The row already exists under the first spelling, so that is what the
    // caller should get back rather than a second, divergent form.
    expect(addToWatchlist("BRK-B")).toBe("BRK.B");
  });
});
