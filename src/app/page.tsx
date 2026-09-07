import Link from "next/link";
import { actionCreateEvent, actionLockSetup } from "./actions";
import DeleteEventButton from "@/components/DeleteEventButton";
import { listEventCards } from "@/lib/events";
import { isAuthRequired, isSetupUnlocked } from "@/lib/auth";
import { EXERCISE_LABELS, type ExerciseType } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cards = listEventCards();
  const canSetup = await isSetupUnlocked();
  const authOn = isAuthRequired();

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-4xl px-6 py-16">
        <header className="mb-12">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium tracking-[0.2em] uppercase text-forest-600 mb-3">
                Orienteering coaching
              </p>
              <h1 className="font-display text-5xl md:text-6xl text-forest-900 tracking-tight">
                VectorRun
              </h1>
              <p className="mt-4 max-w-xl text-lg text-forest-700 leading-relaxed">
                Compare route decisions. Replay sessions together. Learn from every
                leg — not just the finish time. Map image is optional: upload GPX
                tracks and analyze on OpenStreetMap.
              </p>
            </div>
            {authOn && (
              <div className="shrink-0">
                {canSetup ? (
                  <form action={actionLockSetup}>
                    <button
                      type="submit"
                      className="text-sm px-3 py-1.5 rounded-lg border border-forest-200 hover:bg-forest-50"
                    >
                      Lock setup
                    </button>
                  </form>
                ) : (
                  <Link
                    href="/login"
                    className="text-sm px-3 py-1.5 rounded-lg border border-forest-200 hover:bg-forest-50"
                  >
                    Coach login
                  </Link>
                )}
              </div>
            )}
          </div>
        </header>

        {canSetup ? (
          <section className="panel rounded-2xl p-6 mb-10">
            <h2 className="font-display text-xl text-forest-900 mb-4">
              New event
            </h2>
            <form action={actionCreateEvent} className="flex flex-wrap gap-3 items-end">
              <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
                <span className="text-xs font-medium uppercase tracking-wide text-forest-600">
                  Name
                </span>
                <input
                  name="name"
                  required
                  placeholder="Thursday night training"
                  className="rounded-lg border border-forest-200 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-forest-400"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wide text-forest-600">
                  Exercise
                </span>
                <select
                  name="exercise_type"
                  className="rounded-lg border border-forest-200 bg-white px-3 py-2"
                  defaultValue="normal"
                >
                  {(Object.keys(EXERCISE_LABELS) as ExerciseType[]).map((k) => (
                    <option key={k} value={k}>
                      {EXERCISE_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="rounded-lg bg-forest-700 text-white px-5 py-2.5 font-medium hover:bg-forest-800 transition"
              >
                Create
              </button>
            </form>
          </section>
        ) : authOn ? (
          <p className="text-sm text-forest-600 mb-8">
            Viewing is open.{" "}
            <Link href="/login" className="underline">
              Coach login
            </Link>{" "}
            to create or edit events.
          </p>
        ) : null}

        <section>
          <h2 className="font-display text-xl text-forest-900 mb-4">Events</h2>
          {cards.length === 0 ? (
            <p className="text-forest-600">
              No events yet.
              {canSetup ? (
                <>
                  {" "}
                  Create one above, or run{" "}
                  <code className="font-mono text-sm bg-forest-100 px-1.5 py-0.5 rounded">
                    npm run seed
                  </code>{" "}
                  for a demo.
                </>
              ) : null}
            </p>
          ) : (
            <ul className="space-y-3">
              {cards.map(({ event: e, courses }) => {
                const openHref =
                  courses.length > 1
                    ? `/events/${e.id}`
                    : `/events/${e.id}/session`;
                return (
                  <li
                    key={e.id}
                    className="panel rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 justify-between"
                  >
                    <div className="min-w-0">
                      <Link
                        href={openHref}
                        className="font-medium text-forest-900 hover:text-forest-600"
                      >
                        {e.name}
                      </Link>
                      <p className="text-sm text-forest-600">
                        {EXERCISE_LABELS[e.exercise_type as ExerciseType] ??
                          e.exercise_type}
                        {courses.length > 0
                          ? ` · ${courses.length} course${
                              courses.length === 1 ? "" : "s"
                            }`
                          : ""}{" "}
                        · {new Date(e.created_at).toLocaleString()}
                      </p>
                      {e.description ? (
                        <p className="text-sm text-forest-700 mt-1 line-clamp-2">
                          {e.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2 items-center shrink-0">
                      <Link
                        href={openHref}
                        className="text-sm px-3 py-1.5 rounded-lg bg-forest-700 text-white hover:bg-forest-800"
                      >
                        {courses.length > 1 ? "Courses" : "Open"}
                      </Link>
                      {canSetup ? (
                        <Link
                          href={`/events/${e.id}/setup`}
                          className="text-sm px-3 py-1.5 rounded-lg border border-forest-200 hover:bg-forest-50"
                        >
                          Setup
                        </Link>
                      ) : null}
                      {canSetup ? (
                        <DeleteEventButton eventId={e.id} eventName={e.name} />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
