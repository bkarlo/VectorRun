import { notFound } from "next/navigation";
import SessionWorkspace from "@/components/SessionWorkspace";
import { getEventBundle } from "@/lib/events";

export const dynamic = "force-dynamic";

export default async function EventSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const bundle = getEventBundle(id);
  if (!bundle) notFound();

  return (
    <SessionWorkspace
      event={bundle.event}
      map={bundle.map ?? null}
      controls={bundle.controls}
      tracks={bundle.tracks.map((t) => ({
        ...t,
        track: t.track ?? null,
      }))}
      analysis={bundle.analysis}
    />
  );
}
