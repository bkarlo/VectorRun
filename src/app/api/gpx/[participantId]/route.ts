import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { serializeGpx } from "@/lib/gpx";
import { getTrackForParticipant, loadTrackPoints } from "@/lib/events";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ participantId: string }> }
) {
  const { participantId } = await ctx.params;
  const track = getTrackForParticipant(participantId);
  if (!track) {
    return NextResponse.json({ error: "No track" }, { status: 404 });
  }

  const points = loadTrackPoints(track);
  if (points.length === 0) {
    return NextResponse.json({ error: "Empty track" }, { status: 404 });
  }

  const row = getDb()
    .prepare(`SELECT name FROM participants WHERE id = ?`)
    .get(participantId) as { name: string } | undefined;

  const baseName =
    track.source_filename?.replace(/\.gpx$/i, "") ||
    row?.name ||
    "track";
  const safeFile = `${baseName.replace(/[^\w.\-]+/g, "_")}.gpx`;
  const xml = serializeGpx(points, { name: row?.name || baseName });

  return new NextResponse(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/gpx+xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFile}"`,
      "Cache-Control": "no-store",
    },
  });
}
