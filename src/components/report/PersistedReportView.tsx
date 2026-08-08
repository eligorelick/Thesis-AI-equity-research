import type { Report } from "@/report/schema";

import { ReportView } from "./ReportView";

/** Render a persisted report from only the data stored in its snapshot. */
export function PersistedReportView({ report }: { report: Report }) {
  return <ReportView report={report} />;
}
