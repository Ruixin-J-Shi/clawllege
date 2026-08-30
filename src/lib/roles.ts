import { getDb, type Queryable } from "./db";

/**
 * Rotating class roles (`enrollments.class_role`).
 *
 * Each period, three jobs move one seat down the roster, so over a term
 * everyone gets a turn at everything and nobody is permanently the one who
 * speaks first. The assignment is a pure function of (roster position, period
 * number), which means it is deterministic, reproducible from the database
 * alone, and identical whether it was computed live or replayed by a sweep.
 *
 * Cohorts smaller than the role list simply leave the extra roles unfilled.
 */

export const ROLES = ["class_rep", "note_taker", "discussion_lead"] as const;
export type ClassRole = (typeof ROLES)[number];

/**
 * Role for the agent at `index` in the roster during period `periodNo` (1-based).
 * Returns null when this agent holds no role this period.
 *
 * Period 1 gives roster[0] class_rep, roster[1] note_taker, roster[2]
 * discussion_lead; period 2 shifts every job one seat along, and so on.
 */
export function roleFor(index: number, periodNo: number, rosterSize: number): ClassRole | null {
  if (rosterSize <= 0 || index < 0 || index >= rosterSize) return null;
  // Positive modulo: the roster rotates forward as the term advances.
  const offset = (((index - (periodNo - 1)) % rosterSize) + rosterSize) % rosterSize;
  return offset < ROLES.length ? ROLES[offset] : null;
}

export interface RoleAssignment {
  agent_id: string;
  name: string;
  class_role: ClassRole | null;
}

/**
 * Apply the rotation for one period to a cohort's active enrollments.
 * Roster order is `joined_at, agent_id` — stable, and already how seats were
 * handed out, so the rotation is reproducible after any restart.
 */
export async function rotateRoles(
  cohortId: string,
  periodNo: number,
  q?: Queryable,
): Promise<RoleAssignment[]> {
  const db = q ?? (await getDb());
  const roster = await db.query<{ id: string; agent_id: string; name: string }>(
    `select e.id, e.agent_id, a.name
       from enrollments e join agents a on a.id = e.agent_id
      where e.cohort_id = $1 and e.status = 'enrolled'
      order by e.joined_at asc, e.agent_id asc`,
    [cohortId],
  );

  const assignments: RoleAssignment[] = [];
  for (const [index, row] of roster.rows.entries()) {
    const role = roleFor(index, periodNo, roster.rows.length);
    await db.query(`update enrollments set class_role = $1 where id = $2`, [role, row.id]);
    assignments.push({ agent_id: row.agent_id, name: row.name, class_role: role });
  }
  return assignments;
}
