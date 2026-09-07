import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TrackPoint } from "./types";
import { findPunchIndex, PUNCH_RADIUS_M, punchIndexForControl } from "./sync";

function pt(lat: number, lon: number, time: number): TrackPoint {
  return { lat, lon, ele: null, time };
}

/** ~111_320 m per degree latitude. */
function northOf(lat: number, meters: number): number {
  return lat + meters / 111_320;
}

describe("findPunchIndex arrive", () => {
  const control = { lat: 47.5, lon: 19.0 };

  it("prefers the closer return after an overshoot, not the first pass", () => {
    const points: TrackPoint[] = [];
    let t = 0;
    // Approach from 80 m, pass ~18 m away (inside old 25 m circle), continue to 40 m,
    // then come back to ~3 m (actual punch).
    const distances = [80, 50, 30, 18, 25, 40, 20, 8, 3, 6, 20];
    for (const d of distances) {
      points.push(pt(northOf(control.lat, d), control.lon, t));
      t += 1000;
    }

    const idx = findPunchIndex(points, control, 0, 15, "arrive");
    assert.ok(idx >= 0);
    const punchDist = Math.abs(
      (points[idx].lat - control.lat) * 111_320
    );
    assert.ok(
      punchDist < 8,
      `expected punch near the flag, got ${punchDist.toFixed(1)} m at idx ${idx}`
    );
  });

  it("does not punch a 20 m fly-by when radius is 12 m", () => {
    const points: TrackPoint[] = [];
    let t = 0;
    for (const d of [60, 40, 20, 40, 70]) {
      points.push(pt(northOf(control.lat, d), control.lon, t));
      t += 1000;
    }
    const idx = findPunchIndex(points, control, 0, 12, "arrive");
    assert.equal(idx, -1);
  });

  it("honours a manual time override", () => {
    const points: TrackPoint[] = [];
    let t = 1_000;
    for (const d of [40, 25, 10, 4, 15]) {
      points.push(pt(northOf(control.lat, d), control.lon, t));
      t += 1000;
    }
    const overrideTime = points[1].time;
    const idx = punchIndexForControl(
      points,
      control,
      0,
      "arrive",
      { punchTimesByCode: { "31": overrideTime } },
      "31"
    );
    assert.equal(idx, 1);
  });
});

describe("PUNCH_RADIUS_M", () => {
  it("defaults to a tighter 15 m circle", () => {
    assert.equal(PUNCH_RADIUS_M, 15);
  });
});
