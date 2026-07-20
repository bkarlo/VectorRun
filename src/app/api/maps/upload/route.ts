import { NextRequest, NextResponse } from "next/server";
import { saveMapImage } from "@/lib/events";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const eventId = String(form.get("eventId") || "");
  const file = form.get("file") as File | null;
  const width = Number(form.get("width") || 0);
  const height = Number(form.get("height") || 0);

  if (!eventId || !file || !width || !height) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const map = saveMapImage(eventId, file.name, buffer, width, height);
  return NextResponse.json({ map });
}
