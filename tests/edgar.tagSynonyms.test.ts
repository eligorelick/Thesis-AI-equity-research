/**
 * The versioned tag-synonym table is the single source of the us-gaap element
 * names every statement chain resolves, so these tests pin the stamp, the
 * interest-expense contract the WACC depends on, and the fact that every
 * module resolving companyfacts reads the table rather than a second copy of
 * the names.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  EBIT_NON_OPERATING_ADJUSTMENTS,
  INTEREST_EXPENSE_STAND_INS,
  INTEREST_EXPENSE_TAGS,
  LINE_ITEM_TAGS,
  MATURITIES_NEXT_YEAR_TAG,
  TAG_SYNONYMS_REVIEWED_ON,
  TAG_SYNONYMS_TAXONOMY,
  standInsFor,
  tagsFor,
  type LineItem,
} from "@/edgar/tagSynonyms";

describe("tag synonyms — taxonomy stamp", () => {
  it("names the taxonomy year the element names were reviewed against, and the date", () => {
    expect(TAG_SYNONYMS_TAXONOMY).toMatch(/^us-gaap-\d{4}$/);
    expect(TAG_SYNONYMS_REVIEWED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns copies, so a caller cannot mutate the table", () => {
    const first = tagsFor("revenue");
    first.push("NotATag");
    expect(tagsFor("revenue")).not.toContain("NotATag");
  });

  it("lists no tag twice inside one line item", () => {
    for (const item of Object.keys(LINE_ITEM_TAGS) as LineItem[]) {
      const tags = tagsFor(item);
      expect(new Set(tags).size, `${item} repeats a tag`).toBe(tags.length);
      expect(tags.length, `${item} has no tags`).toBeGreaterThan(0);
    }
  });
});

describe("tag synonyms — interest expense", () => {
  it("keeps all five income-statement interest tags, with the operating one last", () => {
    expect(INTEREST_EXPENSE_TAGS).toEqual([
      "InterestExpense",
      "InterestExpenseNonoperating",
      "InterestExpenseDebt",
      "InterestAndDebtExpense",
      "InterestExpenseOperating",
    ]);
  });

  it("reaches the cash figures only after all five, and describes each one correctly", () => {
    expect(standInsFor("interestExpense").map((s) => s.tag)).toEqual(["InterestPaidNet", "InterestPaid"]);
    const [net, gross] = INTEREST_EXPENSE_STAND_INS;
    expect(net!.disclose).toMatch(/net of capitalized interest/);
    expect(net!.disclose).toMatch(/EXCLUDES the interest capitalized/);
    expect(net!.disclose).not.toMatch(/INCLUDES the interest capitalized/);
    expect(gross!.disclose).toMatch(/gross/);
    expect(gross!.disclose).toMatch(/INCLUDES the interest capitalized/);
  });
});

describe("tag synonyms — derived-EBIT adjustments and the debt-maturity stand-in", () => {
  it("names the three non-operating items, with investment income marked a component of the aggregate", () => {
    expect(EBIT_NON_OPERATING_ADJUSTMENTS.map((a) => a.label)).toEqual([
      "NonoperatingIncomeExpense",
      "InvestmentIncomeInterest",
      "IncomeLossFromEquityMethodInvestments",
    ]);
    expect(EBIT_NON_OPERATING_ADJUSTMENTS.find((a) => a.label === "InvestmentIncomeInterest")?.componentOf).toBe(
      "NonoperatingIncomeExpense",
    );
  });

  it("checks the four balance-sheet current-debt tags before the maturity schedule", () => {
    expect(tagsFor("debtCurrent")).toEqual(["DebtCurrent"]);
    expect(tagsFor("shortTermBorrowings")).toEqual(["ShortTermBorrowings"]);
    expect(tagsFor("commercialPaper")).toEqual(["CommercialPaper"]);
    expect(tagsFor("currentMaturitiesOfLongTermDebt")).toEqual([
      "LongTermDebtCurrent",
      "LongTermDebtAndCapitalLeaseObligationsCurrent",
    ]);
    const [standIn] = standInsFor("currentMaturitiesOfLongTermDebt");
    expect(standIn?.tag).toBe(MATURITIES_NEXT_YEAR_TAG);
    expect(standIn?.disclose).toMatch(/current maturities only/);
    expect(standIn?.disclose).toMatch(/filed annually only/);
  });
});

describe("tag synonyms — no module keeps a second copy of the names", () => {
  /**
   * Every module that resolves companyfacts concepts. `keyless.ts` joins the
   * scan because it kept its own
   * `DEI_SHARES_TAG = "EntityCommonStockSharesOutstanding"` literal — exactly
   * the drift the versioned module exists to prevent, and invisible while the
   * scan covered `statements.ts` alone.
   */
  const SCANNED: readonly string[][] = [
    ["src", "edgar", "statements.ts"],
    ["src", "pipeline", "keyless.ts"],
  ];

  it.each(SCANNED)("declares every element name of %s/%s/%s in the synonym module", (...parts) => {
    const declared = new Set<string>();
    for (const item of Object.keys(LINE_ITEM_TAGS) as LineItem[]) {
      for (const tag of tagsFor(item)) declared.add(tag);
      for (const standIn of standInsFor(item)) declared.add(standIn.tag);
    }
    for (const adjustment of EBIT_NON_OPERATING_ADJUSTMENTS) for (const tag of adjustment.tags) declared.add(tag);

    // Any bare "PascalCaseTagName" string literal left in the module that looks
    // like a us-gaap or dei element must come from the table above.
    const source = readFileSync(path.join(process.cwd(), ...parts), "utf8");
    const literals = source.match(/"[A-Z][A-Za-z0-9]{11,}"/g) ?? [];
    const strays = [...new Set(literals.map((l) => l.slice(1, -1)))].filter((name) => !declared.has(name));
    expect(strays).toEqual([]);
  });
});
