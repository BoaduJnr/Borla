import { useState } from "react";
import { api, ApiError } from "../api/client";
import { StarPicker } from "./Stars";
import { IconCheck } from "./Icon";

/**
 * Two-sided review composer (design §16). Deliberately has no "have I already reviewed this?"
 * pre-check endpoint — the unique-per-interaction DB constraint is the real guard; a 409 here
 * just means "already reviewed", which we render the same as success.
 */
export function ReviewForm({
  requestId,
  broadcastId,
  subjectId,
}: {
  requestId?: string;
  broadcastId?: string;
  subjectId: string;
}) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await api("/reviews", {
        method: "POST",
        body: { subjectId, requestId, broadcastId, rating, comment: comment || undefined },
      });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDone(true);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Could not submit review");
    }
  }

  if (done)
    return (
      <p className="muted row" style={{ fontSize: 12.5, gap: 5 }}>
        <IconCheck size={14} color="var(--green)" /> Review submitted — it becomes visible once the
        other side has also reviewed, or the review window closes. Check Profile → Reviews I've
        given for its status.
      </p>
    );
  if (!open)
    return (
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        Leave a review
      </button>
    );

  return (
    <div className="card stack" style={{ marginTop: 8 }}>
      {error && <div className="banner err">{error}</div>}
      <StarPicker value={rating} onChange={setRating} />
      <input
        className="field"
        placeholder="Optional comment (moderated before it's public)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={500}
      />
      <button className="btn btn-green btn-sm" onClick={submit}>
        Submit review
      </button>
    </div>
  );
}
