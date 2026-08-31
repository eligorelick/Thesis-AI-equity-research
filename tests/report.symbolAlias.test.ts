import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { reports } from "@/db/schema";
import { getLatestDoneReport } from "@/report/query";
import { listReportsForSymbol } from "@/report/history";

/**
 * Share-class tickers are written either way round (BRK.B / BRK-B), and
 * `canonicalEntitySymbol` folds the hyphen to a dot precisely so one spelling
 * finds the other. `listReportsForSymbol` does that fold in SQL; the latest-done
 * lookup that the company page and the watchlist row use must agree with it,
 * otherwise History lists a report that the page says does not exist.
 */
let handle: DatabaseHandle;

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
  handle.db
    .insert(reports)
    .values({
      symbol: "BRK.B",
      status: "done",
      createdAt: "2026-08-30T00:00:00.000Z",
      model: "claude-opus-4-8",
      costUsd: null,
      verificationRate: null,
      specVersion: null,
      reportJson: "{}",
    })
    .run();
});

afterEach(() => {
  setDbForTests(null);
  handle.sqlite.close();
});

describe("share-class alias lookups agree across report reads", () => {
  it("history finds the dot-spelled report from the hyphen spelling", () => {
    expect(listReportsForSymbol("BRK-B").map((r) => r.symbol)).toEqual(["BRK.B"]);
  });

  it("getLatestDoneReport finds it from the hyphen spelling too", () => {
    expect(getLatestDoneReport("BRK-B")?.symbol).toBe("BRK.B");
  });

  it("getLatestDoneReport is case-insensitive like its siblings", () => {
    expect(getLatestDoneReport("brk.b")?.symbol).toBe("BRK.B");
  });

  it("still returns null for a genuinely different symbol", () => {
    expect(getLatestDoneReport("AAPL")).toBeNull();
  });

  it("still matches the exact stored spelling", () => {
    expect(getLatestDoneReport("BRK.B")?.symbol).toBe("BRK.B");
  });
});
