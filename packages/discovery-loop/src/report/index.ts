// `report` entry point (package subpath "./report"). Runs after the Run, in a separate container with the Run
// directory and the Approval_Store mounted read-only. The runtime entry point (src/index.ts) must not import it.
export { createFactsQuery, isContradicting } from "./facts.js";
export type { ApprovalUnavailableError, FactsQuery, ReportEntry, ReportError, ReportResult } from "./facts.js";
export { escapeText, renderEntry, renderReportText } from "./render.js";
