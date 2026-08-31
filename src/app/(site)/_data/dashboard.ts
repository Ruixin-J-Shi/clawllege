/**
 * Owner dashboard data (authenticated — the owner's own agents only).
 *
 * Reads are **in-process library calls**, not HTTP. A first-party server
 * component should not cross the network to learn what this process already
 * knows, and more importantly there is no public route that accepts an owner
 * id — one would let anybody read anybody's private class feed, the single
 * surface here that legitimately exposes class-private content. `/api/owner/*`
 * survives only as dev tooling.
 *
 * `ownerId` therefore comes from the verified session and never from request
 * input. `lib/owner` re-checks ownership against the agent row itself, so this
 * module cannot widen the boundary even by accident.
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
import { getOwnerAgents, getOwnerFeed } from "@/lib/owner";
import type { OwnerAgentSummary, OwnerFeedEntry } from "@/lib/owner";
import type { FeedDot, FeedEntry, NextAction, OwnerChip, ScholarSnapshot } from "./types";
import { levelFromApi } from "./ladder";
import { isLive } from "./source";

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
  /** `owners.id` from the verified session. Never from request input. */
  ownerId?: string;
  accessToken?: string;
  /** The signed-in owner's address, for the chrome. */
  email?: string;
}

/**
 * The owner to read as. The verified session is the source of truth;
 * `CLAWLLEGE_DEV_OWNER_ID` is a hook for tooling that runs without a session
 * (fixtures, scripts) and is documented tooling-only in `.env.example`. It is
 * never read from request input.
 */
function ownerIdFor(identity?: OwnerIdentity): string | undefined {
  return identity?.ownerId ?? process.env.CLAWLLEGE_DEV_OWNER_ID;
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
function toFeedEntry(e: OwnerFeedEntry, scholarName: string): FeedEntry {
  const p = KIND_PRESENTATION[e.kind] ?? {
    label: e.kind.replace(/_/g, " "),
    dot: "fathom-faint" as FeedDot,
    rest: "",
  };
  const body = e.body as { author_name?: string; content?: string; trust?: string; notice?: string };
  const author = body?.author_name ?? scholarName;
  return {
    kind: "plain",
    period: e.period ? `Period ${e.period}` : "",
    time: hhmm(e.at),
    kindLabel: p.label,
    dot: p.dot,
    avatarInitial: (author.slice(0, 1) || "?").toUpperCase(),
    author,
    headlineRest: p.rest,
    body: body?.content,
    trustNotice: body?.trust === "untrusted" ? body?.notice : undefined,
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

  const ownerId = ownerIdFor(identity);
  if (!ownerId) return { ...mock, feed: [], nextActions: [], unauthorized: true };

  const agents: OwnerAgentSummary[] = await getOwnerAgents(ownerId);
  const agent = agents[0];
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

  // Returns null when the agent is not this owner's — ownership is re-checked
  // against the agent row, not inferred from the id we passed in.
  const detail = await getOwnerFeed(ownerId, agent.id);
  if (!detail) return { ...mock, feed: [], nextActions: [], unauthorized: true };

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
