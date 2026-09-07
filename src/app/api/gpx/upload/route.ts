import { NextRequest, NextResponse } from "next/server";
import { parseGpx } from "@/lib/gpx";
import { addParticipant, saveTrack } from "@/lib/events";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { isSetupUnlocked } = await import("@/lib/auth");
  if (!(await isSetupUnlocked())) {
    return NextResponse.json({ error: "Setup is locked" }, { status: 401 });
  }
  const form = await req.formData();
  const eventId = String(form.get("eventId") || "");
  const participantId = String(form.get("participantId") || "");
  const runnerName = String(form.get("runnerName") || "").trim();
  const file = form.get("file") as File | null;

  if (!eventId || !file) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const text = await file.text();
  const points = parseGpx(text);
  if (points.length === 0) {
    return NextResponse.json(
      { error: "No track points found in GPX" },
      { status: 400 }
    );
  }

  let pid = participantId;
  if (!pid) {
    const name =
      runnerName ||
      file.name.replace(/\.gpx$/i, "") ||
      "Runner";
    const p = addParticipant(eventId, name);
    pid = p.id;
  }

  const track = saveTrack(pid, file.name, points);
  return NextResponse.json({
    participantId: pid,
    trackId: track.id,
    pointCount: points.length,
  });
}
