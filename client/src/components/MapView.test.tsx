import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { MapView } from "./MapView";

/**
 * Real Leaflet needs real DOM layout (getBoundingClientRect, canvas) that jsdom doesn't provide
 * reliably, so react-leaflet itself is mocked out here rather than mounted for real. This fake
 * map is just enough of an event-emitter + setView/getZoom surface for `Recenter` (MapView.tsx)
 * — the component that owns the "follow the target, zoom in as it gets closer" behaviour — to
 * run its actual, unmodified logic against. No `route`/OSRM fetch involved: `Recenter` only
 * reacts to `center`/`zoom`, so every test here drives that directly via re-renders.
 *
 * The resume-after-a-gesture half of that behaviour is opt-in (`resumeFollowAfterMs`) — only
 * Route me's recipient page and a collector's own accepted-request route pass it in production;
 * every render below passes it explicitly too, since that mechanism is what these tests exist
 * to exercise.
 *
 * `setView` deliberately does NOT auto-fire zoomstart/zoomend itself. Real Leaflet's animated
 * zoom fires 'zoomstart' synchronously but 'zoomend' only once its CSS transition completes,
 * asynchronously, well after React has already committed and attached this component's
 * listeners. Auto-firing both synchronously inside setView (an earlier version of this test did)
 * fires them *before* Recenter's second effect has even registered its listener — a fake-only
 * timing artifact that isn't how the real event ever reaches the component, and it silently broke
 * the very state (`programmaticZoom`) these tests exist to exercise. Firing the pair as an
 * explicit, separate step (`fireZoomStartThenEnd` below) matches reality instead of an accident
 * of synchronous ordering.
 */
const { fakeMap } = vi.hoisted(() => {
  class FakeMap {
    listeners: Record<string, Array<() => void>> = {};
    zoomLevel = 14;
    setView = vi.fn((_latlng: [number, number], zoom: number) => {
      this.zoomLevel = zoom;
    });
    getZoom = () => this.zoomLevel;
    on(event: string, cb: () => void) {
      (this.listeners[event] ??= []).push(cb);
    }
    off(event: string, cb: () => void) {
      this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== cb);
    }
    fire(event: string) {
      (this.listeners[event] ?? []).slice().forEach((cb) => cb());
    }
  }
  return { fakeMap: new FakeMap() };
});

vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TileLayer: () => null,
  CircleMarker: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Polyline: () => null,
  Popup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  useMap: () => fakeMap,
}));

const POINT = { lon: -0.187, lat: 5.6037 };

// The resume-after-gesture behaviour these tests exercise is opt-in (MapView.tsx) — off by
// default so a plain overview map never snaps back under a user just looking around. Every test
// below passes it explicitly, the same way RouteMeReceive/CollectorHome's own RoutePanel call
// actually do in production, since that's the mechanism under test here.
const RESUME_MS = 15_000;

function renderMap(zoom: number) {
  return render(<MapView center={POINT} points={[]} zoom={zoom} resumeFollowAfterMs={RESUME_MS} />);
}

/**
 * Fires the zoomstart/zoomend pair real Leaflet emits once a zoom (animated or not) resolves.
 * Whether a given call represents "our own programmatic zoom completing" or "a genuine user
 * pinch/scroll" depends only on whether it immediately follows one of our own setView calls —
 * `Recenter`'s `programmaticZoom` ref is exactly what's supposed to tell those two apart, and
 * each test below is deliberately narrated with which one it means at each step.
 */
function fireZoomStartThenEnd() {
  act(() => {
    fakeMap.fire("zoomstart");
    fakeMap.fire("zoomend");
  });
}

describe("MapView auto-recentring/zoom (Recenter)", () => {
  beforeEach(() => {
    fakeMap.setView.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("zooms in automatically as the target gets closer, driven purely by the zoom prop", () => {
    const { rerender } = renderMap(14);
    expect(fakeMap.setView).toHaveBeenLastCalledWith([POINT.lat, POINT.lon], 14);
    fireZoomStartThenEnd(); // our own zoom completing, resets programmaticZoom for the next one

    // Simulates RoutePanel/RouteMeReceive re-rendering with a shrinking zoomForDistance() result
    // as the two points close in — three steps, not one, to prove this isn't a one-off initial
    // zoom but an ongoing "recompute on every update" behaviour.
    rerender(<MapView center={POINT} points={[]} zoom={16} resumeFollowAfterMs={RESUME_MS} />);
    expect(fakeMap.setView).toHaveBeenLastCalledWith([POINT.lat, POINT.lon], 16);
    fireZoomStartThenEnd();

    rerender(<MapView center={POINT} points={[]} zoom={18} resumeFollowAfterMs={RESUME_MS} />);
    expect(fakeMap.setView).toHaveBeenLastCalledWith([POINT.lat, POINT.lon], 18);

    expect(fakeMap.setView).toHaveBeenCalledTimes(3);
  });

  it("a manual zoom (genuine user pinch/scroll, not our own setView) pauses the auto zoom-in immediately", () => {
    const { rerender } = renderMap(14);
    expect(fakeMap.setView).toHaveBeenCalledTimes(1);
    fireZoomStartThenEnd(); // our own zoom completing

    fireZoomStartThenEnd(); // a genuine user pinch/scroll: programmaticZoom is false here, so this one disables follow

    const callsAfterManualZoom = fakeMap.setView.mock.calls.length;
    // The target keeps getting closer (zoom prop keeps shrinking towards it) exactly as it would
    // in a live request/route-me session — auto-recentring shouldn't act on any of it yet (see
    // the resume-after-15s tests below for what happens once the user actually leaves it alone).
    rerender(<MapView center={POINT} points={[]} zoom={17} resumeFollowAfterMs={RESUME_MS} />);
    rerender(<MapView center={POINT} points={[]} zoom={18} resumeFollowAfterMs={RESUME_MS} />);
    expect(fakeMap.setView).toHaveBeenCalledTimes(callsAfterManualZoom);
  });

  it("resumes the zoom-in effect on its own 15s after the last user gesture, catching up to the latest target", () => {
    vi.useFakeTimers();
    const { rerender } = renderMap(14);
    fireZoomStartThenEnd(); // our own zoom completing
    fireZoomStartThenEnd(); // genuine user zoom — pauses follow

    const callsAfterManualZoom = fakeMap.setView.mock.calls.length;
    // The target keeps closing in while the user has the map paused — ignored for now, exactly
    // like the immediate-pause test above.
    rerender(<MapView center={POINT} points={[]} zoom={18} resumeFollowAfterMs={RESUME_MS} />);
    expect(fakeMap.setView).toHaveBeenCalledTimes(callsAfterManualZoom);

    // Just under 15s: still paused.
    act(() => {
      vi.advanceTimersByTime(14_000);
    });
    expect(fakeMap.setView).toHaveBeenCalledTimes(callsAfterManualZoom);

    // Crossing the 15s mark: follow resumes and immediately catches up to zoom=18 — the *latest*
    // props, not whatever was current back when the gesture happened.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(fakeMap.setView).toHaveBeenCalledTimes(callsAfterManualZoom + 1);
    expect(fakeMap.setView).toHaveBeenLastCalledWith([POINT.lat, POINT.lon], 18);
  });

  it("does not resume mid-drag — the timer restarts on every drag tick, not just once at dragstart", () => {
    vi.useFakeTimers();
    renderMap(14);
    fireZoomStartThenEnd(); // our own zoom completing

    act(() => {
      fakeMap.fire("dragstart");
    });
    const callsAfterDragStart = fakeMap.setView.mock.calls.length;

    // 10s of an ongoing pan, then another movement tick — this must push the resume clock back
    // out, or a slow, deliberate drag would get yanked back to the target mid-gesture.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    act(() => {
      fakeMap.fire("drag");
    });
    act(() => {
      vi.advanceTimersByTime(10_000); // 20s since dragstart, but only 10s since the last "drag" tick
    });
    expect(fakeMap.setView).toHaveBeenCalledTimes(callsAfterDragStart);

    // Now genuinely idle for 15s since that last tick.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(fakeMap.setView).toHaveBeenCalledTimes(callsAfterDragStart + 1);
  });

  it("a manual drag/pan pauses it too, via the same guard as zoom", () => {
    const { rerender } = renderMap(14);
    expect(fakeMap.setView).toHaveBeenCalledTimes(1);
    fireZoomStartThenEnd(); // our own zoom completing

    act(() => {
      fakeMap.fire("dragstart");
    });

    const callsAfterDrag = fakeMap.setView.mock.calls.length;
    rerender(<MapView center={{ lon: -0.19, lat: 5.61 }} points={[]} zoom={16} resumeFollowAfterMs={RESUME_MS} />);
    expect(fakeMap.setView).toHaveBeenCalledTimes(callsAfterDrag);
  });

  it("remounting the map (e.g. navigating away and back) starts following again immediately", () => {
    const first = render(<MapView center={POINT} points={[]} zoom={14} resumeFollowAfterMs={RESUME_MS} />);
    fireZoomStartThenEnd();
    fireZoomStartThenEnd(); // pause follow on this instance
    first.unmount();

    fakeMap.setView.mockClear();
    render(<MapView center={POINT} points={[]} zoom={16} resumeFollowAfterMs={RESUME_MS} />);
    // A fresh Recenter instance starts with follow=true again, with no 15s wait needed — the
    // pause above is scoped to one mounted map instance, not the app's lifetime.
    expect(fakeMap.setView).toHaveBeenCalledWith([POINT.lat, POINT.lon], 16);
  });
});
