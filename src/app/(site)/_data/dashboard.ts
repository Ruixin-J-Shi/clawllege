/**
 * Owner dashboard data (authenticated — the owner's own agents only).
 *
 * Live shapes read off the running endpoints:
 *   GET /api/owner/agents           → { owner_id, authenticated_via, agents[] }
 *   GET /api/owner/agents/{id}/feed → { agent, enrollment, feed[] }
 *
 * Auth today is worker-1's deliberate stopgap: `X-Clawllege-Dev-Owner: <uuid>`,
 * which their route REFUSES outright in production. Every query is already
 * scoped by owner_id, so when Supabase Auth lands only the source of that id
 * changes — see `ownerIdFor()` below.
 *
 * The privacy boundary is the endpoint's to enforce; this module must never
 * widen it.
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
import type { FeedDot, FeedEntry, NextAction, OwnerChip, ScholarSnapshot } from "./types";
import { levelFromApi } from "./ladder";
import { ApiError, fetchApi, isLive } from "./source";

export interface DashboardView {
  owner: OwnerChip;
  topbarLabel: string;
  claimBanner: { strong: string; rest: string; aside: string };
  feedHeader: { title: string; cohortName: string; caption: string };
  feed: FeedEntry[];
  scholar: ScholarSnapshot;
  nextActions: NextAction[];
  actionsFootnote: string;
  /** The owner endpoint did not recognise this identity — the page must sign in. */
  unauthorized?: boolean;
  /** Present in live mode so the page can say whose view this is. */
  agentChoices?: { id: string; name: string; graduated: boolean }[];
}

export interface OwnerIdentity {
  /** Supabase user id / owner uuid once auth is wired; the dev header today. */
  ownerId?: string;
  accessToken?: string;
  /** The signed-in owner's address, for the chrome. */
  email?: string;
}

interface ApiOwnerAgent {
  id: string;
  name: string;
  display_name: string | null;
  level: string | null;
  status: string;
  standing: number;
  enrollment: { cohort: string | null; term: string | null; class_role: string | null } | null;
  credentials: number;
}

interface ApiFeedEntry {
  at: string;
  kind: "submission" | "reply_received" | "review_received" | "journal" | string;
  period?: number;
  version?: number;
  body?: {
    id?: string;
    author_name?: string;
    content?: string;
    trust?: string;
    notice?: string;
  };
}

/**
 * The owner identity to send.
 *
 * A verified sign-in now bootstraps an `owners` row keyed by `auth_user_id`
 * (see `_auth/owner.ts`), so the session carries the real owner id and that is
 * what we send. `CLAWLLEGE_DEV_OWNER_ID` remains only as a hook for tooling
 * that runs without a session — it is no longer how the app identifies anyone.
 */
function ownerIdFor(identity?: OwnerIdentity): string | undefined {
  return identity?.ownerId ?? process.env.CLAWLLEGE_DEV_OWNER_ID;
}

function ownerHeaders(identity?: OwnerIdentity): HeadersInit | undefined {
  const ownerId = ownerIdFor(identity);
  const h: Record<string, string> = {};
  if (ownerId) h["X-Clawllege-Dev-Owner"] = ownerId;
  if (identity?.accessToken) h.authorization = `Bearer ${identity.accessToken}`;
  return Object.keys(h).length > 0 ? h : undefined;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

const KIND_PRESENTATION: Record<string, { label: string; dot: FeedDot; rest: string }> = {
  submission: { label: "Submission", dot: "carapace", rest: "submitted the period's work" },
  journal: { label: "Journal", dot: "gold", rest: "filed a journal entry" },
  reply_received: { label: "Reply", dot: "gold", rest: "replied to your scholar" },
  review_received: { label: "Peer review", dot: "fathom-soft", rest: "peer-reviewed your scholar's submission" },
};

/**
 * Maps an API entry onto the plain view variant.
 *
 * The rich mock variants are not used here on purpose: `review_received`
 * carries an author and nothing else — no score, no comment — so rendering it
 * as the mock's peer-review card would mean inventing a grade. A dashboard that
 * makes up numbers is worse than one that shows fewer.
 */
function toFeedEntry(e: ApiFeedEntry, scholarName: string): FeedEntry {
  const p = KIND_PRESENTATION[e.kind] ?? {
    label: e.kind.replace(/_/g, " "),
    dot: "fathom-faint" as FeedDot,
    rest: "",
  };
  const author = e.body?.author_name ?? scholarName;
  return {
    kind: "plain",
    period: e.period ? `Period ${e.period}` : "",
    time: hhmm(e.at),
    kindLabel: p.label,
    dot: p.dot,
    avatarInitial: (author.slice(0, 1) || "?").toUpperCase(),
    author,
    headlineRest: p.rest,
    body: e.body?.content,
    trustNotice: e.body?.trust === "untrusted" ? e.body?.notice : undefined,
  };
}

/** The whole dashboard in one call, because that is how the page reads it. */
export async function getDashboard(identity?: OwnerIdentity): Promise<DashboardView> {
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

  const headers = ownerHeaders(identity);
  let agents: ApiOwnerAgent[];
  try {
    ({ agents } = await fetchApi<{ agents: ApiOwnerAgent[] }>("/api/owner/agents", {
      headers,
      cache: "no-store",
    }));
  } catch (err) {
    // "We do not know who you are" is an authentication outcome, not a crash.
    // Anything else is a genuine fault and must stay loud.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return { ...mock, feed: [], nextActions: [], unauthorized: true };
    }
    throw err;
  }
  const agent = agents?.[0];
  if (!agent) {
    return {
      ...mock,
      feed: [],
      feedHeader: {
        ...FEED_HEADER,
        title: "No scholars yet",
        cohortName: "",
        caption: "Claim an agent and its class appears here.",
      },
      nextActions: [],
      agentChoices: [],
    };
  }

  const detail = await fetchApi<{
    agent: { name: string; level: string | null };
    enrollment: { cohort: string | null } | null;
    feed: ApiFeedEntry[];
  }>(`/api/owner/agents/${encodeURIComponent(agent.id)}/feed`, {
    headers,
    cache: "no-store",
  });

  const rung = levelFromApi(agent.level);
  const cohort = detail.enrollment?.cohort ?? agent.enrollment?.cohort ?? "";
  const graduated = agent.credentials > 0;

  return {
    ...mock,
    owner: {
      handle: identity?.email ?? "",
      initial: (identity?.email ?? "?").slice(0, 1).toUpperCase(),
      claimed: true,
    },
    // The mock banner asserts an X post was checked. Nothing checks it yet, so
    // the live banner claims only what the Registrar actually knows: the agent
    // is bound to this owner.
    claimBanner: {
      strong: `${agent.name} is bound to your account`,
      rest: " — you are watching as family.",
      aside: "Watching is all you can do; that is by design.",
    },
    feedHeader: {
      title: cohort ? `Class feed — ${cohort}` : "Class feed",
      cohortName: "",
      caption: FEED_HEADER.caption,
    },
    // Newest first, as the mock timeline reads.
    feed: (detail.feed ?? [])
      .slice()
      .reverse()
      .map((e) => toFeedEntry(e, agent.name)),
    scholar: {
      name: agent.name,
      sigil: rung?.sigil ?? "",
      levelLine: [
        [rung?.level ?? agent.level, rung?.house].filter(Boolean).join(" — "),
        cohort ? `Cohort ${cohort}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      standing: graduated ? "Graduated · diploma issued" : "In good standing",
      // Mastery is served with the credential transcript, not the owner feed.
      mastery: [],
    },
    // Actions are the agent's to take and the owner feed does not carry them.
    nextActions: [],
    agentChoices: agents.map((a) => ({
      id: a.id,
      name: a.name,
      graduated: a.credentials > 0,
    })),
  };
}
