import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TrackPoint } from "./types";
import {
  averageSpeedMps,
  fillPrefixFromLegs,
  mergeTrackPoints,
  mpsToPaceMinPerKm,
  paceMinPerKmToMps,
  prependPrefix,
} from "./trackRepair";

function pt(
  lat: number,
  lon: number,
  time: number,
  ele: number | null = null
): TrackPoint {
  return { lat, lon, ele, time };
}

describe("mergeTrackPoints", () => {
  it("concatenates non-overlapping tracks in time order", () => {
    const a = [pt(47.0, 19.0, 1000), pt(47.001, 19.0, 2000)];
    const b = [pt(47.002, 19.0, 5000), pt(47.003, 19.0, 6000)];
    const { points, stats } = mergeTrackPoints(a, b);
    assert.equal(points.length, 4);
    assert.equal(points[0].time, 1000);
    assert.equal(points[3].time, 6000);
    assert.equal(stats.overlapped, false);
    assert.ok(stats.junctionGapMs >= 3000);
  });

  it("orders by earlier first point regardless of argument order", () => {
    const early = [pt(1, 1, 100), pt(1.001, 1, 200)];
    const late = [pt(2, 2, 1000), pt(2.001, 2, 1100)];
    const { points } = mergeTrackPoints(late, early);
    assert.equal(points[0].lat, 1);
    assert.equal(points[2].lat, 2);
  });

  it("on overlap keeps the longer contiguous run", () => {
    // A: long 0..10s; B: short overlapping 5..7s
    const a = [
      pt(47, 19, 0),
      pt(47.001, 19, 5000),
      pt(47.002, 19, 10000),
    ];
    const b = [pt(48, 19, 5000), pt(48.001, 19, 7000)];
    const { points, stats } = mergeTrackPoints(a, b);
    assert.equal(stats.overlapped, true);
    // Longer A kept; B entirely inside A → no tail
    assert.ok(points.every((p) => p.lat < 47.1));
    assert.equal(points.length, 3);
  });

  it("on overlap with longer second track, keeps second and earlier prefix", () => {
    const a = [pt(47, 19, 0), pt(47.001, 19, 2000)];
    const b = [
      pt(48, 19, 1000),
      pt(48.001, 19, 5000),
      pt(48.002, 19, 9000),
    ];
    const { points, stats } = mergeTrackPoints(a, b);
    assert.equal(stats.overlapped, true);
    assert.equal(points[0].lat, 47);
    assert.equal(points[0].time, 0);
    assert.ok(points.some((p) => p.lat === 48));
    assert.equal(points[points.length - 1].time, 9000);
  });
});

describe("fillPrefixFromLegs", () => {
  it("timestamps end just before first GPS and connect spatially", () => {
    const firstGps = pt(47.01, 19.01, 10_000);
    const waypoints = [{ lat: 47.0, lon: 19.0 }];
    const speeds = [2.5]; // m/s
    const prefix = fillPrefixFromLegs(waypoints, speeds, firstGps);
    assert.ok(prefix.length >= 1);
    assert.equal(prefix[0].lat, 47.0);
    assert.ok(prefix[prefix.length - 1].time < firstGps.time);
    const merged = prependPrefix(prefix, [firstGps]);
    assert.equal(merged[merged.length - 1].time, firstGps.time);
    assert.ok(merged[0].time < firstGps.time);
  });

  it("supports multiple legs with different speeds", () => {
    const firstGps = pt(47.02, 19.0, 60_000);
    const waypoints = [
      { lat: 47.0, lon: 19.0 },
      { lat: 47.01, lon: 19.0 },
    ];
    const speeds = [2, 4];
    const prefix = fillPrefixFromLegs(waypoints, speeds, firstGps);
    assert.ok(prefix.length > 2);
    assert.equal(prefix[0].lat, 47.0);
    // Mid waypoint should appear
    assert.ok(prefix.some((p) => Math.abs(p.lat - 47.01) < 1e-9));
    assert.ok(prefix.every((p) => p.time < firstGps.time));
  });

  it("rejects empty waypoints", () => {
    assert.throws(() =>
      fillPrefixFromLegs([], [], pt(0, 0, 1000))
    );
  });
});

describe("pace helpers", () => {
  it("round-trips pace and m/s", () => {
    const mps = paceMinPerKmToMps(5);
    const back = mpsToPaceMinPerKm(mps);
    assert.ok(Math.abs(back - 5) < 1e-9);
  });

  it("averageSpeedMps uses path over duration", () => {
    // ~111m north in 10s → ~11.1 m/s
    const points = [pt(47, 19, 0), pt(47.001, 19, 10_000)];
    const speed = averageSpeedMps(points);
    assert.ok(speed > 10 && speed < 12);
  });
});
