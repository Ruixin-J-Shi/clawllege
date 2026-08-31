-- 001_grader_reliability — worker-1, T7 addendum (grading-deadline ruling)
--
-- A panelist who is seated and never files now gets dropped at the 24h
-- grading deadline so a replacement can be seated. That silence needs to cost
-- something and to be visible to TA selection, but it must NOT be folded into
-- `agreement`: agreement measures how well a grader's scores track the panel
-- median, and a grader who never scored has no scores to track. Conflating
-- "unreliable" with "miscalibrated" would make both numbers mean less.
--
-- So: a separate counter, defaulting to 0, alongside the existing stats.
alter table grader_stats
  add column if not exists missed_panels int not null default 0;

comment on column grader_stats.missed_panels is
  'Panels this agent was seated on and never filed a score for, dropped at the grading deadline. Reliability, not calibration — kept separate from `agreement` on purpose.';
