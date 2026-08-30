/**
 * The one place pages get data from.
 *
 * Pages must not import `_mock/` directly. Three surfaces are exempt because no
 * endpoint exists or is planned behind them: the landing page (marketing copy),
 * and the letter and report previews, which render fixed pre-launch demo
 * content by design. Everything else — campus, dashboard, verify — reads here,
 * so taking a domain live is an env change in `source.ts`, not a page edit.
 */
export * from "./types";
export { isLive, apiBaseUrl, ApiError } from "./source";
export type { DataDomain } from "./source";
export {
  getHighlights,
  getDirectory,
  getGraduation,
  getYearbookQuotes,
} from "./campus";
export { getVerifiedRecord, getPublishedRecordIds, getPublishedRecords } from "./credentials";
export { getDashboard } from "./dashboard";
export type { DashboardView } from "./dashboard";
