import { NextRequest, NextResponse } from "next/server";
import { isSetupUnlocked } from "@/lib/auth";
import {
  backupFilename,
  createLiveBackupArchive,
  restoreLiveBackup,
} from "@/lib/backup";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  if (!(await isSetupUnlocked())) {
    return NextResponse.json({ error: "Setup is locked" }, { status: 401 });
  }
  try {
    const archive = await createLiveBackupArchive();
    const filename = backupFilename();
    return new NextResponse(new Uint8Array(archive), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Backup failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  if (!(await isSetupUnlocked())) {
    return NextResponse.json({ error: "Setup is locked" }, { status: 401 });
  }
  const form = await req.formData();
  const confirm = String(form.get("confirm") || "").trim();
  if (confirm !== "REPLACE") {
    return NextResponse.json(
      { error: "Type REPLACE to confirm a full restore" },
      { status: 400 }
    );
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 16) {
    return NextResponse.json({ error: "Choose a .vrbak backup file" }, { status: 400 });
  }
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const manifest = await restoreLiveBackup(buf);
    return NextResponse.json({
      ok: true,
      event_count: manifest.event_count,
      created_at: manifest.created_at,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Restore failed" },
      { status: 400 }
    );
  }
}
