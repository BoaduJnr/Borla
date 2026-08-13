import { IconStar } from "./Icon";

/** Read-only star rating, e.g. profile cards and review lists. */
export function Stars({ rating, size = 13 }: { rating: number; size?: number }) {
  const rounded = Math.round(rating);
  return (
    <span className="stars" style={{ display: "inline-flex", gap: 1, verticalAlign: "middle" }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <IconStar key={n} size={size} filled={n <= rounded} />
      ))}
    </span>
  );
}

/** Interactive star picker, e.g. leaving a review. */
export function StarPicker({ value, onChange, size = 32 }: { value: number; onChange: (n: number) => void; size?: number }) {
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          style={{ background: "none", border: 0, padding: 0, cursor: "pointer", lineHeight: 0 }}
        >
          <IconStar size={size} filled={n <= value} />
        </button>
      ))}
    </span>
  );
}
