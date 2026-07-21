export const REPORT_SECTION_MANIFEST = [
  { key: "verdict", index: 1, label: "Verdict", printTitle: "Verdict", accent: false },
  { key: "business", index: 2, label: "Business", printTitle: "Business & Segments", accent: false },
  { key: "fundamentals", index: 3, label: "Fundamentals", printTitle: "Fundamentals", accent: false },
  { key: "balanceSheet", index: 4, label: "Balance Sheet", printTitle: "Balance Sheet & Capital", accent: false },
  { key: "valuation", index: 5, label: "Valuation", printTitle: "Valuation", accent: false },
  { key: "quality", index: 6, label: "Quality", printTitle: "Quality & Red Flags", accent: false },
  { key: "technicals", index: 7, label: "Technicals", printTitle: "Technicals", accent: false },
  { key: "leadership", index: 8, label: "Leadership", printTitle: "Leadership & Governance", accent: false },
  { key: "competitive", index: 9, label: "Competitive", printTitle: "Competitive Landscape", accent: false },
  { key: "catalystsRisks", index: 10, label: "Catalysts & Risks", printTitle: "Catalysts & Risks", accent: true },
  { key: "outlook", index: 11, label: "Outlook", printTitle: "Future Outlook", accent: false },
  { key: "projections", index: 12, label: "Projections", printTitle: "Weighted Projections", accent: false },
  { key: "macro", index: 13, label: "Macro", printTitle: "Macro Context", accent: false },
  { key: "appendix", index: 14, label: "Appendix", printTitle: "Appendix", accent: false },
] as const;

export type ReportSectionKey = (typeof REPORT_SECTION_MANIFEST)[number]["key"];

export function reportSection(key: ReportSectionKey) {
  const section = REPORT_SECTION_MANIFEST.find((entry) => entry.key === key);
  if (!section) throw new Error(`Unknown report section: ${key}`);
  return section;
}
