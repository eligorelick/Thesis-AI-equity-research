import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { reportToMarkdown } from "@/report/export/markdown";
import { formatCostUsd, roundedDisplayedCostTotal } from "@/report/format";
import { ReportSchema, type Report } from "@/report/schema";

/**
 * The cost appendix is a ledger: its Total must equal the sum of the rows
 * printed beside it, and it must read the same as the on-screen and print
 * surfaces. Markdown reimplemented both — four decimals instead of the
 * canonical six, and a total summed from UNROUNDED values — so sub-cent steps
 * printed as $0.0000 and the rows need not add up to the total.
 */
function reportWithCosts(costs: number[]): Report {
  const parsed = ReportSchema.parse(
    JSON.parse(
      readFileSync(path.join(process.cwd(), "fixtures", "report", "DEMO-sample.json"), "utf8"),
    ),
  );
  parsed.appendix.costBreakdown = costs.map((costUsd, index) => ({
    step: `step-${index}`,
    model: "claude-opus-4-8",
    costUsd,
  }));
  return parsed;
}

function costSection(markdown: string): string {
  const start = markdown.indexOf("### Cost breakdown");
  expect(start).toBeGreaterThan(-1);
  return markdown.slice(start, start + 1200);
}

describe("Markdown cost appendix", () => {
  it("prints a total equal to the sum of its own displayed rows", () => {
    const costs = [0.00005, 0.00005, 0.00005];
    const section = costSection(reportToMarkdown(reportWithCosts(costs)));

    const expectedTotal = formatCostUsd(roundedDisplayedCostTotal(costs));
    expect(section).toContain(`Total: **${expectedTotal}**`);

    // Every row is rendered with the same canonical formatter, so a reader can
    // add the printed numbers and land on the printed total.
    for (const cost of costs) expect(section).toContain(formatCostUsd(cost));
  });

  it("does not flatten a sub-cent step to zero", () => {
    const section = costSection(reportToMarkdown(reportWithCosts([0.000123, 1.5])));

    expect(section).toContain("$0.000123");
    expect(section).not.toContain("$0.0000\n");
  });

  it("renders costs identically to the shared formatter", () => {
    const section = costSection(reportToMarkdown(reportWithCosts([1.234567, 2])));

    expect(section).toContain(formatCostUsd(1.234567));
    expect(section).toContain(formatCostUsd(2));
  });
});
