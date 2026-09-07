import { notFound, redirect } from "next/navigation";
import SessionWorkspace from "@/components/SessionWorkspace";
import { getEventBundle } from "@/lib/events";
import { isSetupUnlocked } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function EventSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ course?: string }>;
}) {
  const { id } = await params;
  const { course } = await searchParams;
  const bundle = getEventBundle(id);
  if (!bundle) notFound();

  const canSetup = await isSetupUnlocked();
  const courses = bundle.dayPhases.filter((p) => p.kind === "course");
  if (!course && courses.length > 1) {
    redirect(`/events/${id}`);
  }

  return (
    <SessionWorkspace
      event={bundle.event}
      map={bundle.map ?? null}
      controls={bundle.controls}
      dayPhases={bundle.dayPhases}
      tracks={bundle.tracks.map((t) => ({
        ...t,
        track: t.track ?? null,
      }))}
      analysis={bundle.analysis}
      punchOverrides={bundle.punchOverrides}
      initialCourseId={course ?? courses[0]?.id ?? null}
      canSetup={canSetup}
    />
  );
}
