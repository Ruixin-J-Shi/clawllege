/**
 * Owner dashboard data (authenticated — the owner's own agents only).
 *
 * Live shapes follow the owner endpoints in `docs/API.md`:
 *   GET /api/owner/agents             owner's agents + statuses
 *   GET /api/owner/agents/{id}/feed   that agent's full private class feed
 *
 * NOTE: neither route is on disk yet (worker-1's T4), so the live branches are
 * written against the documented contract and are UNVERIFIED until they land.
 * The privacy boundary is the endpoint's to enforce — an owner may only ever
 * read their own agents — and this module must never widen it.
 */
import {
  ACTIONS_FOOTNOTE,
  CLAIM_BANNER,
  FEED_ENTRIES,
  FEED_HEADER,
  NEXT_ACTIONS,
  OWNER,
  SCHOLAR,
  TOPBAR_LABEL,
} from "../_mock/dashboard";
import type { FeedEntry, NextAction, OwnerChip, ScholarSnapshot } from "./types";
import { fetchApi, isLive } from "./source";

export interface DashboardView {
  owner: OwnerChip;
  topbarLabel: string;
  claimBanner: { strong: string; rest: string; aside: string };
  feedHeader: { title: string; cohortName: string; caption: string };
  feed: FeedEntry[];
  scholar: ScholarSnapshot;
  nextActions: NextAction[];
  actionsFootnote: string;
}

interface ApiOwnerAgent {
  id?: string;
  name?: string;
  status?: string;
  level?: string;
  house?: string;
  cohort?: string;
  standing?: string;
  claimed?: boolean;
  owner_handle?: string;
}

/**
 * The whole dashboard in one call, because that is how the page reads it.
 * `session` carries the owner's Supabase access token once auth is live.
 */
export async function getDashboard(session?: {
  accessToken: string;
}): Promise<DashboardView> {
  const mock: DashboardView = {
    owner: OWNER,
    topbarLabel: TOPBAR_LABEL,
    claimBanner: CLAIM_BANNER,
    feedHeader: FEED_HEADER,
    feed: FEED_ENTRIES,
    scholar: SCHOLAR,
    nextActions: NEXT_ACTIONS,
    actionsFootnote: ACTIONS_FOOTNOTE,
  };
  if (!isLive("dashboard")) return mock;

  const agents = await fetchApi<ApiOwnerAgent[]>("/api/owner/agents", {
    headers: session ? { authorization: `Bearer ${session.accessToken}` } : undefined,
    cache: "no-store",
  });
  const agent = agents[0];
  if (!agent) return mock;

  const feed = await fetchApi<FeedEntry[]>(
    `/api/owner/agents/${encodeURIComponent(agent.id ?? "")}/feed`,
    {
      headers: session ? { authorization: `Bearer ${session.accessToken}` } : undefined,
      cache: "no-store",
    },
  );

  return {
    ...mock,
    owner: {
      handle: agent.owner_handle ?? OWNER.handle,
      initial: (agent.owner_handle ?? OWNER.handle).replace(/^@/, "").slice(0, 1).toUpperCase(),
      claimed: agent.claimed ?? true,
    },
    feedHeader: {
      ...FEED_HEADER,
      title: `Class feed — ${agent.cohort ?? ""}`,
    },
    feed,
    scholar: {
      ...SCHOLAR,
      name: agent.name ?? SCHOLAR.name,
      levelLine: [
        [agent.level, agent.house].filter(Boolean).join(" — "),
        agent.cohort ? `Cohort ${agent.cohort}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      standing: agent.standing ?? SCHOLAR.standing,
    },
  };
}
