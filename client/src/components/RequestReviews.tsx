import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Avatar } from "./Avatar";
import { Stars, StarPicker } from "./Stars";

interface ThreadMessage {
  type: "review" | "reply";
  id: string;
  author_id: string;
  author_name: string | null;
  rating: number | null;
  body: string | null;
  created_at: string;
}

interface MyReview {
  id: string;
  rating: number;
  comment: string | null;
  status: string;
  moderation_passed: boolean;
  created_at: string;
}

/**
 * One shared, AI-moderated chat thread per request — both parties always see the exact same
 * messages, in the same order, right on the request card. There is no more double-blind hold:
 * a review or reply joins the thread the moment it individually clears moderation, for everyone
 * at once (Technical_Debt_Plan.md documents this as a deliberate trade-off against the original
 * design's double-blind release). Nothing here is duplicated on Profile — that page only shows
 * the aggregate rating.
 */
export function RequestReviews({
  requestId,
  subjectId,
  canReview,
  interactive = true,
}: {
  requestId: string;
  subjectId: string;
  canReview: boolean;
  /** false once the request has moved to History — the conversation is frozen, read-only, no
   * rating form and no reply composer. Rate/reply while the request is still active. */
  interactive?: boolean;
}) {
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [mine, setMine] = useState<MyReview | null>(null);
  const [needsRating, setNeedsRating] = useState(false);

  function load() {
    api<{ messages: ThreadMessage[]; mine: MyReview | null; canReview: boolean }>(`/requests/${requestId}/reviews`)
      .then((d) => {
        setMessages(d.messages);
        setMine(d.mine);
        setNeedsRating(d.canReview);
      })
      .catch(() => setMessages([]));
  }

  useEffect(load, [requestId]);

  if (!messages) return null;

  return (
    <div className="stack" style={{ marginTop: 8 }}>
      {(messages.length > 0 || mine) && (
        <div className="card stack" style={{ background: "var(--paper)" }}>
          {messages.map((m) => (
            <div key={`${m.type}-${m.id}`} className="stack" style={{ gap: 2 }}>
              <div className="row" style={{ gap: 6 }}>
                <Avatar name={m.author_name} size={20} />
                <b style={{ fontSize: 12 }}>{m.author_name ?? "Someone"}</b>
                {m.rating != null && <Stars rating={m.rating} size={11} />}
              </div>
              {m.body && (
                <p style={{ fontSize: 13, marginLeft: 26 }}>{m.body}</p>
              )}
            </div>
          ))}
          {mine && mine.status !== "visible" && (
            <p className="muted" style={{ fontSize: 11.5 }}>
              Your rating is {mine.status === "flagged" ? "flagged — awaiting admin review" : "awaiting moderation"} —
              it'll appear here for both of you once it clears.
            </p>
          )}
        </div>
      )}

      {interactive &&
        (needsRating && canReview ? (
          <RatingComposer requestId={requestId} subjectId={subjectId} onSent={load} />
        ) : (
          canReview && <ReplyComposer messages={messages} onSent={load} />
        ))}
    </div>
  );
}

function RatingComposer({ requestId, subjectId, onSent }: { requestId: string; subjectId: string; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open)
    return (
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        Leave a review
      </button>
    );

  async function submit() {
    setBusy(true);
    try {
      await api("/reviews", { method: "POST", body: { subjectId, requestId, rating, comment: comment || undefined } });
    } catch {
      // A 409 here means "already reviewed" (e.g. a second tab) — either way, refresh from the
      // server's own view of the world rather than trusting local state.
    } finally {
      setBusy(false);
      setOpen(false);
      onSent();
    }
  }

  return (
    <div className="card stack" style={{ marginTop: 4 }}>
      <StarPicker value={rating} onChange={setRating} />
      <input
        className="field"
        placeholder="Optional comment (moderated before it's shared)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={500}
      />
      <button className="btn btn-green btn-sm" disabled={busy} onClick={submit}>
        Submit
      </button>
    </div>
  );
}

function ReplyComposer({ messages, onSent }: { messages: ThreadMessage[]; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const firstReview = messages.find((m) => m.type === "review");
  if (!firstReview) return null; // nothing to reply to yet — one side still needs to leave the opening rating

  async function send() {
    setBusy(true);
    try {
      await api(`/reviews/${firstReview!.id}/reply`, { method: "POST", body: { body } });
      setBody("");
      setOpen(false);
      onSent();
    } finally {
      setBusy(false);
    }
  }

  if (!open)
    return (
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        Reply
      </button>
    );
  return (
    <div className="row">
      <input className="field" value={body} onChange={(e) => setBody(e.target.value)} maxLength={500} placeholder="Your message…" />
      <button className="btn btn-green btn-sm" disabled={busy || !body.trim()} onClick={send}>
        Send
      </button>
    </div>
  );
}
