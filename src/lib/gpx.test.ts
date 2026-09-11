import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TrackPoint } from "./types";
import { trimTrackByFraction, trimTrackPoints } from "./gpx";

function pt(lat: number, lon: number, time: number): TrackPoint {
  return { lat, lon, ele: null, time };
}

describe("trimTrackByFraction", () => {
  const points = [
    pt(47.0, 19.0, 0),
    pt(47.001, 19.0, 1000),
    pt(47.002, 19.0, 2000),
    pt(47.003, 19.0, 3000),
    pt(47.004, 19.0, 4000),
  ];

  it("keeps the middle of the time span", () => {
    const kept = trimTrackByFraction(points, 0.25, 0.75);
    assert.equal(kept[0].time, 1000);
    assert.equal(kept[kept.length - 1].time, 3000);
    assert.ok(kept.length >= 2);
  });

  it("start=0 end=1 is a no-op copy", () => {
    const kept = trimTrackByFraction(points, 0, 1);
    assert.deepEqual(
      kept.map((p) => p.time),
      points.map((p) => p.time)
    );
  });

  it("swaps inverted fractions", () => {
    const a = trimTrackByFraction(points, 0.75, 0.25);
    const b = trimTrackByFraction(points, 0.25, 0.75);
    assert.deepEqual(
      a.map((p) => p.time),
      b.map((p) => p.time)
    );
  });

  it("leaves short tracks unchanged", () => {
    const one = [pt(1, 1, 0)];
    assert.equal(trimTrackByFraction(one, 0.2, 0.8).length, 1);
  });
});

describe("trimTrackPoints", () => {
  const points = [
    pt(47.0, 19.0, 100),
    pt(47.001, 19.0, 200),
    pt(47.002, 19.0, 300),
  ];

  it("keeps inclusive time bounds", () => {
    const kept = trimTrackPoints(points, 200, 300);
    assert.equal(kept.length, 2);
    assert.equal(kept[0].time, 200);
    assert.equal(kept[1].time, 300);
  });
});
