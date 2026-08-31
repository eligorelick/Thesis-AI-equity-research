import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { reportToMarkdown } from "@/report/export/markdown";
import { reportToPrintHtml } from "@/report/export/printHtml";
import { ReportSchema, type Report } from "@/report/schema";

/**
 * A forensic battery that does not apply to a route (Altman and Beneish are
 * suppressed for banks, for instance) carries the reason WHY on
 * `notApplicableReason`. The on-screen report shows it; the Markdown and print
 * exports rendered only Battery/Variant/Score/Zone, so an export reader saw a
 * bare dash with no explanation for a missing forensic score.
 */
const REASON = "not meaningful for a bank balance sheet (no working-capital cycle)";

function reportWithNotApplicableAltman(): Report {
  const parsed = ReportSchema.parse(
    JSON.parse(
      readFileSync(path.join(process.cwd(), "fixtures", "report", "DEMO-sample.json"), "utf8"),
    ),
  );
  parsed.quality.forensicScores.altman = {
    variant: "original",
    score: null,
    zone: null,
    notApplicableReason: REASON,
  };
  return parsed;
}

describe("forensic not-applicable reasons reach the exports", () => {
  it("Markdown discloses why a battery did not apply", () => {
    expect(reportToMarkdown(reportWithNotApplicableAltman())).toContain(REASON);
  });

  it("print HTML discloses why a battery did not apply", () => {
    expect(reportToPrintHtml(reportWithNotApplicableAltman())).toContain(REASON);
  });

  it("omits the column content for batteries that did apply", () => {
    const markdown = reportToMarkdown(reportWithNotApplicableAltman());
    const start = markdown.indexOf("### Forensic scores");
    const section = markdown.slice(start, start + 900);

    // Exactly one battery is not applicable in this fixture.
    expect(section.split(REASON)).toHaveLength(2);
  });
});
