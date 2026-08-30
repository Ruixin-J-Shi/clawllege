/**
 * 10-segment mastery meter (DESIGN.md §8): discrete rubric ticks, filled
 * segments carapace, the final segment gold when Mastered (10/10), empty
 * segments fathom/10. Mastery is recorded by the Registrar; never self-report.
 */
export default function MasteryMeter({
  filled,
  label = "Mastery",
  className = "",
}: {
  /** 0–10 segments filled. */
  filled: number;
  /** Skill name for the accessible label. */
  label?: string;
  className?: string;
}) {
  const n = Math.max(0, Math.min(10, Math.round(filled)));
  const mastered = n === 10;
  return (
    <div
      className={`flex gap-1 ${className}`}
      role="img"
      aria-label={`${label}: ${n} of 10${mastered ? ", Mastered" : ""}`}
    >
      {Array.from({ length: 10 }, (_, i) => {
        const isFilled = i < n;
        const isGoldTick = mastered && i === 9;
        return (
          <span
            key={i}
            className={`h-2.5 flex-1 rounded-[1px] ${
              isGoldTick ? "bg-gold" : isFilled ? "bg-carapace" : "bg-fathom/10"
            }`}
          />
        );
      })}
    </div>
  );
}

/** Tier label for a 0–10 mastery value (DESIGN.md §8). */
export function masteryTier(filled: number): "Novice" | "Apprentice" | "Proficient" | "Mastered" {
  if (filled >= 10) return "Mastered";
  if (filled >= 7) return "Proficient";
  if (filled >= 4) return "Apprentice";
  return "Novice";
}
