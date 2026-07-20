import Link from "next/link";
import { actionCreateEvent, actionDeleteEvent } from "./actions";
import { listEvents } from "@/lib/events";
import { EXERCISE_LABELS, type ExerciseType } from "@/lib/types";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const events = listEvents();

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-4xl px-6 py-16">
        <header className="mb-12">
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
        </header>

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
              Create and open
            </button>
          </form>
        </section>

        <section>
          <h2 className="font-display text-xl text-forest-900 mb-4">Events</h2>
          {events.length === 0 ? (
            <p className="text-forest-600">
              No events yet. Create one above, or run{" "}
              <code className="font-mono text-sm bg-forest-100 px-1.5 py-0.5 rounded">
                npm run seed
              </code>{" "}
              for a demo.
            </p>
          ) : (
            <ul className="space-y-3">
              {events.map((e) => (
                <li
                  key={e.id}
                  className="panel rounded-xl px-4 py-3 flex items-center gap-4 justify-between"
                >
                  <div>
                    <Link
                      href={`/events/${e.id}`}
                      className="font-medium text-forest-900 hover:text-forest-600"
                    >
                      {e.name}
                    </Link>
                    <p className="text-sm text-forest-600">
                      {EXERCISE_LABELS[e.exercise_type as ExerciseType] ??
                        e.exercise_type}{" "}
                      · {new Date(e.created_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Link
                      href={`/events/${e.id}/setup`}
                      className="text-sm px-3 py-1.5 rounded-lg border border-forest-200 hover:bg-forest-50"
                    >
                      Setup
                    </Link>
                    <Link
                      href={`/events/${e.id}`}
                      className="text-sm px-3 py-1.5 rounded-lg bg-forest-700 text-white hover:bg-forest-800"
                    >
                      Open
                    </Link>
                    <form action={actionDeleteEvent}>
                      <input type="hidden" name="id" value={e.id} />
                      <button
                        type="submit"
                        className="text-sm px-3 py-1.5 rounded-lg text-red-700 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
