function initials(name: string | null | undefined): string {
  if (!name) return "?";
  // Only letter-led words count — drops parentheticals like "Ama (Osu)" -> "Ama", not "Ama ("
  const words = name.trim().split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  if (words.length === 0) return "?";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/** Colour-tinted initials avatar (borla_UI_design.html `.avatar`/`.avatar.g`) — green for
 * households, marigold for collectors, matching the design's role colour language. */
export function Avatar({
  name,
  role,
  size = 44,
}: {
  name: string | null | undefined;
  role?: "household" | "collector" | "admin";
  size?: number;
}) {
  return (
    <div
      className={`avatar ${role === "collector" ? "g" : ""}`}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials(name)}
    </div>
  );
}
