import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getMap } from "@/lib/events";
import { getUploadsDir } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await params;
  const map = getMap(eventId);
  if (!map) {
    return NextResponse.json({ error: "No map" }, { status: 404 });
  }
  const full = path.join(getUploadsDir(), path.basename(map.image_path));
  if (!fs.existsSync(full)) {
    return NextResponse.json({ error: "File missing" }, { status: 404 });
  }
  const buf = fs.readFileSync(full);
  const ext = path.extname(full).toLowerCase();
  const type =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : "image/png";
  return new NextResponse(buf, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
