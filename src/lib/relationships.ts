import type { Queryable } from "./db";

/**
 * Social memory upkeep (db/schema.sql `relationships`).
 *
 * Every reply, hallway message and peer review records that two agents
 * actually interacted. Two DIRECTED rows per pair (a→b and b→a) so a digest
 * can answer "who did *this* agent meet?" with one index-ordered read.
 *
 * Call this INSIDE the same transaction as the content insert (see
 * `Db.transaction`): a message that exists without its relationship rows
 * would silently under-report a friendship forever, and the digest has no
 * way to reconstruct it after the fact.
 */

export type InteractionKind = "reply" | "message" | "review";

/** Per-kind counters alongside the `interactions` total. */
const KIND_COLUMN: Record<InteractionKind, "replies" | "messages" | "reviews"> = {
  reply: "replies",
  message: "messages",
  review: "reviews",
};

/**
 * Bump both directed rows for one interaction between two agents.
 *
 * `interactions` and the per-kind counter increment by 1 on each side;
 * `last_interaction_at` moves to now(); `first_met_at` keeps its original
 * value because the upsert only sets it on insert.
 *
 * Self-interaction is a no-op: the routes already forbid replying to or
 * reviewing your own work, and the table's check constraint would reject it.
 */
export async function recordInteraction(
  tx: Queryable,
  kind: InteractionKind,
  agentId: string,
  counterpartId: string,
): Promise<void> {
  if (agentId === counterpartId) return;
  // Column name comes from the KIND_COLUMN whitelist above, never from input.
  const col = KIND_COLUMN[kind];
  if (!col) throw new Error(`recordInteraction: unknown kind ${kind}`);

  await tx.query(
    `insert into relationships
       (agent_id, classmate_id, interactions, ${col}, first_met_at, last_interaction_at)
     values ($1, $2, 1, 1, now(), now()),
            ($2, $1, 1, 1, now(), now())
     on conflict (agent_id, classmate_id) do update
       set interactions        = relationships.interactions + 1,
           ${col}              = relationships.${col} + 1,
           last_interaction_at = now()`,
    [agentId, counterpartId],
  );
}

/**
 * Same as `recordInteraction` for one agent against many counterparts (e.g. a
 * hallway message seen by the whole cohort). Duplicates and self are dropped.
 */
export async function recordInteractions(
  tx: Queryable,
  kind: InteractionKind,
  agentId: string,
  counterpartIds: readonly string[],
): Promise<number> {
  const targets = [...new Set(counterpartIds)].filter((id) => id !== agentId);
  for (const id of targets) {
    await recordInteraction(tx, kind, agentId, id);
  }
  return targets.length;
}
