import Link from "next/link";
import { notFound } from "next/navigation";
import { actionLockSetup } from "@/app/actions";
import DeleteEventButton from "@/components/DeleteEventButton";
import { getEventBundle } from "@/lib/events";
import { isAuthRequired, isSetupUnlocked } from "@/lib/auth";
import { EXERCISE_LABELS, type ExerciseType } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function EventHubPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const bundle = getEventBundle(id);
  if (!bundle) notFound();

  const canSetup = await isSetupUnlocked();
  const authOn = isAuthRequired();
  const courses = bundle.dayPhases.filter((p) => p.kind === "course");
  const { event } = bundle;

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <Link href="/" className="text-sm text-forest-600 hover:underline">
              ← VectorRun
            </Link>
            <h1 className="font-display text-3xl text-forest-900 mt-1">
              {event.name}
            </h1>
            <p className="text-sm text-forest-600 mt-1">
              {EXERCISE_LABELS[event.exercise_type as ExerciseType] ??
                event.exercise_type}{" "}
              · {new Date(event.created_at).toLocaleString()}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            {canSetup ? (
              <Link
                href={`/events/${id}/setup`}
                className="text-sm px-3 py-1.5 rounded-lg border border-forest-200 hover:bg-forest-50"
              >
                Setup
              </Link>
            ) : authOn ? (
              <Link
                href={`/login?next=${encodeURIComponent(`/events/${id}`)}`}
                className="text-sm px-3 py-1.5 rounded-lg border border-forest-200 hover:bg-forest-50"
              >
                Coach login
              </Link>
            ) : null}
            {authOn && canSetup ? (
              <form action={actionLockSetup}>
                <button
                  type="submit"
                  className="text-sm px-3 py-1.5 rounded-lg border border-forest-200 hover:bg-forest-50"
                >
                  Lock
                </button>
              </form>
            ) : null}
          </div>
        </div>

        {event.description ? (
          <section className="panel rounded-xl p-5 mb-8">
            <h2 className="text-xs uppercase tracking-wide text-forest-600 mb-2">
              About this session
            </h2>
            <p className="text-forest-800 whitespace-pre-wrap leading-relaxed">
              {event.description}
            </p>
          </section>
        ) : null}

        <section className="mb-10">
          <h2 className="font-display text-xl text-forest-900 mb-4">Courses</h2>
          {courses.length === 0 ? (
            <p className="text-forest-600">
              No course defined yet.
              {canSetup ? (
                <>
                  {" "}
                  <Link
                    href={`/events/${id}/setup`}
                    className="underline"
                  >
                    Add controls and a day plan in Setup
                  </Link>
                  , or{" "}
                  <Link href={`/events/${id}/session`} className="underline">
                    open the map
                  </Link>{" "}
                  with GPX only.
                </>
              ) : (
                <>
                  {" "}
                  <Link href={`/events/${id}/session`} className="underline">
                    Open map
                  </Link>
                </>
              )}
            </p>
          ) : (
            <ul className="space-y-3">
              {courses.map((c, i) => (
                <li key={c.id}>
                  <Link
                    href={`/events/${id}/session?course=${encodeURIComponent(c.id)}`}
                    className="panel rounded-xl px-4 py-3 flex items-center justify-between hover:bg-forest-50"
                  >
                    <div>
                      <p className="font-medium text-forest-900">{c.name}</p>
                      <p className="text-sm text-forest-600">
                        {c.controlCodes.length} controls
                        {courses.length > 1 ? ` · course ${i + 1}` : ""}
                      </p>
                    </div>
                    <span className="text-sm text-forest-700">Replay →</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {courses.length === 1 ? (
            <p className="text-xs text-forest-500 mt-3">
              Single-course events skip this page from the home list.
            </p>
          ) : null}
        </section>

        {canSetup ? (
          <div className="border-t border-forest-200 pt-6">
            <p className="text-xs uppercase tracking-wide text-forest-500 mb-2">
              Danger zone
            </p>
            <DeleteEventButton eventId={id} eventName={event.name} />
          </div>
        ) : null}
      </div>
    </main>
  );
}
