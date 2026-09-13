import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { courseDefFromCodes } from "./courseDef";
import type { TrackPoint } from "./types";
import {
  alignCourseVisits,
  findPunchIndex,
  matchCourseGraph,
} from "./sync";

function pt(lat: number, lon: number, time: number): TrackPoint {
  return { lat, lon, ele: null, time };
}

/** ~111_320 m per degree latitude. */
function northOf(lat: number, meters: number): number {
  return lat + meters / 111_320;
}

function lineTo(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  n: number,
  t0: number
): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    out.push(
      pt(
        from.lat + (to.lat - from.lat) * f,
        from.lon + (to.lon - from.lon) * f,
        t0 + i * 1000
      )
    );
  }
  return out;
}

function dwell(
  at: { lat: number; lon: number },
  closestM: number,
  count: number,
  t0: number
): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (let i = 0; i < count; i++) {
    const mid = (count - 1) / 2;
    const d = closestM + Math.abs(i - mid) * 4;
    out.push(pt(northOf(at.lat, d), at.lon, t0 + i * 1000));
  }
  return out;
}

describe("alignCourseVisits", () => {
  const c13 = { lat: 47.5, lon: 19.0 };
  const c14 = { lat: 47.5008, lon: 19.0 };
  const c15 = { lat: 47.5016, lon: 19.0 };
  const c16 = { lat: 47.5024, lon: 19.0 };
  const byCode = new Map([
    ["13", c13],
    ["14", c14],
    ["15", c15],
    ["16", c16],
  ]);

  it("keeps the closest hunt when the runner overshoots then returns", () => {
    let t = 0;
    const points: TrackPoint[] = [
      ...dwell(c13, 2, 5, t),
    ];
    t = points[points.length - 1].time + 1000;
    // First 14 pass ~18 m, then closer return ~3 m, then 15
    points.push(pt(northOf(c14.lat, 18), c14.lon, t));
    t += 1000;
    points.push(pt(northOf(c14.lat, 12), c14.lon, t));
    t += 1000;
    points.push(...lineTo({ lat: northOf(c14.lat, 40), lon: c14.lon }, { lat: northOf(c14.lat, 40), lon: c14.lon }, 2, t));
    t = points[points.length - 1].time + 1000;
    points.push(pt(northOf(c14.lat, 8), c14.lon, t));
    t += 1000;
    points.push(pt(northOf(c14.lat, 3), c14.lon, t));
    t += 1000;
    points.push(...dwell(c15, 2, 4, t));

    const aligned = alignCourseVisits(points, ["13", "14", "15"], byCode);
    assert.ok(aligned);
    assert.equal(aligned.codes.join(","), "13,14,15");
    const p14 = points[aligned.punchIndices[1]];
    const d14 = Math.abs((p14.lat - c14.lat) * 111_320);
    assert.ok(d14 < 6, `expected closer 14 punch, got ${d14.toFixed(1)} m`);
  });

  it("does not let a later revisit steal a punch after other controls", () => {
    let t = 0;
    const points: TrackPoint[] = [];
    points.push(...dwell(c13, 2, 4, t));
    t = points[points.length - 1].time + 1000;
    // Real 14 after 13, a bit sloppy (~9 m)
    points.push(...dwell(c14, 9, 5, t));
    t = points[points.length - 1].time + 1000;
    points.push(...dwell(c15, 1, 5, t));
    t = points[points.length - 1].time + 1000;
    points.push(...dwell(c16, 2, 4, t));
    t = points[points.length - 1].time + 1000;
    // Come back closer to 14
    points.push(...dwell(c14, 5, 5, t));

    const aligned = alignCourseVisits(
      points,
      ["13", "14", "15", "16"],
      byCode
    );
    assert.ok(aligned);
    assert.equal(aligned.codes.join(","), "13,14,15,16");

    const idx14 = aligned.punchIndices[1];
    const idx15 = aligned.punchIndices[2];
    assert.ok(idx14 < idx15, "14 must be assigned before 15, not the revisit");
  });

  it("does not consume a later control from an early fly-by", () => {
    let t = 0;
    const points: TrackPoint[] = [];
    points.push(...dwell(c13, 2, 4, t));
    t = points[points.length - 1].time + 1000;
    // Clip 15 early at ~22 m
    points.push(pt(northOf(c15.lat, 22), c15.lon, t));
    t += 1000;
    points.push(...dwell(c14, 2, 4, t));
    t = points[points.length - 1].time + 1000;
    points.push(...dwell(c15, 2, 4, t));

    const aligned = alignCourseVisits(points, ["13", "14", "15"], byCode, 0, {
      radiusM: 30,
    });
    assert.ok(aligned);
    assert.equal(aligned.codes.join(","), "13,14,15");
    const p15 = points[aligned.punchIndices[2]];
    const d15 = Math.abs((p15.lat - c15.lat) * 111_320);
    assert.ok(d15 < 8, `expected real 15, got ${d15.toFixed(1)} m`);
  });
});

describe("matchCourseGraph uses course alignment", () => {
  it("matches a linear course after a later revisit of an earlier control", () => {
    const s = { lat: 47.5, lon: 19.0 };
    const one = { lat: 47.5009, lon: 19.0 };
    const two = { lat: 47.5018, lon: 19.0 };
    const byCode = new Map([
      ["S", s],
      ["1", one],
      ["F", two],
    ]);
    let t = 0;
    const points: TrackPoint[] = [];
    points.push(...dwell(s, 2, 4, t));
    t = points[points.length - 1].time + 1000;
    points.push(...dwell(one, 10, 4, t));
    t = points[points.length - 1].time + 1000;
    points.push(...dwell(two, 2, 4, t));
    t = points[points.length - 1].time + 1000;
    points.push(...dwell(one, 4, 4, t));

    const match = matchCourseGraph(
      points,
      courseDefFromCodes(["S", "1", "F"]),
      byCode
    );
    assert.ok(match);
    assert.equal(match.codes.join(","), "S,1,F");
    assert.ok(match.punchIndices[1] < match.punchIndices[2]);
  });
});

describe("findPunchIndex still hunts locally", () => {
  it("prefers the closer return after an overshoot", () => {
    const control = { lat: 47.5, lon: 19.0 };
    const points: TrackPoint[] = [];
    let t = 0;
    const distances = [80, 50, 30, 18, 25, 40, 20, 8, 3, 6, 20];
    for (const d of distances) {
      points.push(pt(northOf(control.lat, d), control.lon, t));
      t += 1000;
    }
    const idx = findPunchIndex(points, control, 0, 15, "arrive");
    assert.ok(idx >= 0);
    const punchDist = Math.abs((points[idx].lat - control.lat) * 111_320);
    assert.ok(punchDist < 8, `got ${punchDist.toFixed(1)} m`);
  });
});
