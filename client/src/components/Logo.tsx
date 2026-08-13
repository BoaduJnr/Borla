/** The approved Borla mark (borla_UI_design.html) — a pin shape with a marigold radar ring/dot,
 * literally "the collector's bell" as a locator signal. Reused everywhere a plain "Borla" text
 * wordmark was standing in for it. */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path
        d="M24 45c8-9 13-15.5 13-22A13 13 0 1 0 11 23c0 6.5 5 13 13 22Z"
        fill="var(--green)"
      />
      <circle cx="24" cy="21" r="9" fill="none" stroke="var(--marigold)" strokeWidth="2.4" opacity={0.9} />
      <circle cx="24" cy="21" r="4.4" fill="var(--marigold)" />
    </svg>
  );
}

export function Logo({ size = 32, wordmark = true }: { size?: number; wordmark?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <Mark size={size} />
      {wordmark && (
        <span className="h-disp" style={{ fontSize: size * 0.72, color: "var(--green-d)" }}>
          Borla
        </span>
      )}
    </span>
  );
}
