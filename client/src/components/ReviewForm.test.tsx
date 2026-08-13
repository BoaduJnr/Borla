import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewForm } from "./ReviewForm";

describe("ReviewForm", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("submits a rating+comment and shows the thank-you state", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ review: { id: "r1", status: "pending" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReviewForm requestId="req-1" subjectId="user-2" />);

    fireEvent.click(screen.getByText("⭐ Leave a review"));
    fireEvent.click(screen.getByText("Submit review"));

    await waitFor(() => expect(screen.getByText(/Review submitted/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/reviews",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("treats a 409 (already reviewed) as success, not an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ error: "You already reviewed this interaction" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReviewForm broadcastId="b-1" subjectId="user-2" />);
    fireEvent.click(screen.getByText("⭐ Leave a review"));
    fireEvent.click(screen.getByText("Submit review"));

    await waitFor(() => expect(screen.getByText(/Review submitted/)).toBeInTheDocument());
  });
});
