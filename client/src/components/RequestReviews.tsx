import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Stars } from "./Stars";
import { ReviewForm } from "./ReviewForm";
import { givenStatusLabel, givenStatusChipClass } from "../utils/reviewStatus";

interface ReviewSide {
  id: string;
  author_id: string;
  subject_id: string;
  rating: number;
  comment: string | null;
  status: string;
  moderation_passed: boolean;
  author_name?: string;
  reply_id?: string | null;
  reply_body?: string | null;
}

/**
 * Review + reply shown *on the request they belong to*, not only in a flat Profile list — the
 * request card is where the interaction actually happened, so that's where its review lives.
 * `GET /requests/:id/reviews` returns both directions in one call: `mine` (what I wrote, any
 * status) and `theirs` (what they wrote about me, only once visible — same privacy rule as
 * everywhere else review visibility is checked).
 */
export function RequestReviews({
  requestId,
  subjectId,
  canReview,
}: {
  requestId: string;
  subjectId: string;
  canReview: boolean;
}) {
  const [data, setData] = useState<{ mine: ReviewSide | null; theirs: ReviewSide | null } | null>(null);

  useEffect(() => {
    api<{ mine: ReviewSide | null; theirs: ReviewSide | null }>(`/requests/${requestId}/reviews`)
      .then(setData)
      .catch(() => setData({ mine: null, theirs: null }));
  }, [requestId]);

  if (!data) return null;

  return (
    <div className="stack" style={{ marginTop: 8 }}>
      {data.theirs && (
        <div className="card stack" style={{ background: "var(--paper)" }}>
          <div className="spread">
            <b style={{ fontSize: 12.5 }}>{data.theirs.author_name ?? "Review"}</b>
            <Stars rating={data.theirs.rating} size={12} />
          </div>
          {data.theirs.comment && <p style={{ fontSize: 13 }}>{data.theirs.comment}</p>}
          {data.theirs.reply_body ? (
            <p className="muted" style={{ fontSize: 12 }}>
              <b>Your reply:</b> {data.theirs.reply_body}
            </p>
          ) : (
            <InlineReply
              reviewId={data.theirs.id}
              onSent={(body) => setData((d) => (d && d.theirs ? { ...d, theirs: { ...d.theirs, reply_body: body } } : d))}
            />
          )}
        </div>
      )}

      {data.mine ? (
        <div className="row" style={{ gap: 6, alignItems: "center" }}>
          <Stars rating={data.mine.rating} size={12} />
          <span className={`tag-chip ${givenStatusChipClass(data.mine)}`} style={{ fontSize: 11 }}>
            {givenStatusLabel(data.mine)}
          </span>
        </div>
      ) : (
        canReview && <ReviewForm requestId={requestId} subjectId={subjectId} />
      )}
    </div>
  );
}

function InlineReply({ reviewId, onSent }: { reviewId: string; onSent: (body: string) => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [sent, setSent] = useState(false);

  async function send() {
    await api(`/reviews/${reviewId}/reply`, { method: "POST", body: { body } }).catch(() => null);
    setSent(true);
    onSent("(pending moderation)");
  }

  if (sent) return <p className="muted" style={{ fontSize: 12 }}>Reply submitted (awaiting moderation).</p>;
  if (!open)
    return (
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        Reply
      </button>
    );
  return (
    <div className="row">
      <input className="field" value={body} onChange={(e) => setBody(e.target.value)} maxLength={500} placeholder="Your reply…" />
      <button className="btn btn-green btn-sm" onClick={send}>
        Send
      </button>
    </div>
  );
}
