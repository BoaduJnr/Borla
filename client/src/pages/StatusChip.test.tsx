import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusChip } from "./HouseholdHome";

describe("StatusChip", () => {
  it("renders a human label for each request status", () => {
    const cases: Array<[string, string]> = [
      ["requested", "Sent"],
      ["seen", "Seen"],
      ["accepted", "On the way"],
      ["rejected", "Rejected"],
      ["timed_out", "No response"],
      ["cancelled", "Cancelled"],
    ];
    for (const [status, label] of cases) {
      const { unmount } = render(<StatusChip status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it("shows 'Arrived' once the collector has reached the pickup point, instead of 'On the way'", () => {
    render(<StatusChip status="accepted" arrived />);
    expect(screen.getByText("Arrived")).toBeInTheDocument();
  });

  it("falls back to the raw status string for an unknown status", () => {
    render(<StatusChip status="mystery" />);
    expect(screen.getByText("mystery")).toBeInTheDocument();
  });
});
