/**
 * Shared with Profile.tsx (global "Reviews I've given" list) and RequestReviews.tsx (the same
 * review shown in context on its originating request) — one place for what each review status
 * actually means to the person who wrote it, so the two views never drift out of sync.
 */
export interface GivenReview {
  status: string;
  moderation_passed: boolean;
}

export function givenStatusLabel(r: GivenReview): string {
  if (r.status === "visible") return "Public";
  if (r.status === "removed") return "Removed by admin";
  if (r.status === "flagged") return "Flagged — awaiting admin review";
  if (r.moderation_passed) return "Approved — waiting on the other side (or the review window to close)";
  return "Awaiting moderation";
}

export function givenStatusChipClass(r: GivenReview): string {
  if (r.status === "visible") return "t-green";
  if (r.status === "removed" || r.status === "flagged") return "t-coral";
  return "t-gold";
}
