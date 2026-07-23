import Link from "next/link";
import { notFound } from "next/navigation";
import SetupWizard from "@/components/SetupWizard";
import { actionUpdateEventMeta } from "@/app/actions";
import { getEvent, getMap, listControls, listDayPhases, listSetupTracks } from "@/lib/events";
import {
  EXERCISE_LABELS,
  type ExerciseType,
  type GeorefPair,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SetupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const event = getEvent(id);
  if (!event) notFound();
  const map = getMap(id);
  const controls = listControls(id);
  const dayPhases = listDayPhases(id);
  const tracks = listSetupTracks(id);
  const georef: GeorefPair[] = map
    ? (JSON.parse(map.georef_json) as GeorefPair[])
    : [];

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
          <div>
            <Link href="/" className="text-sm text-forest-600 hover:underline">
              ← VectorRun
            </Link>
            <h1 className="font-display text-3xl text-forest-900 mt-1">
              Setup · {event.name}
            </h1>
            <p className="text-sm text-forest-600 mt-1">
              Upload tracks first if you like — add the orienteering map later
              and drag/scale it over OSM until it fits.
            </p>
          </div>
          <Link
            href={`/events/${id}`}
            className="rounded-lg bg-forest-700 text-white px-4 py-2 text-sm font-medium hover:bg-forest-800"
          >
            Open session →
          </Link>
        </div>

        <form
          action={actionUpdateEventMeta}
          className="panel rounded-xl p-4 mb-6 flex flex-wrap gap-3 items-end"
        >
          <input type="hidden" name="id" value={id} />
          <label className="flex flex-col gap-1 flex-1 min-w-[180px]">
            <span className="text-xs uppercase tracking-wide text-forest-600">
              Name
            </span>
            <input
              name="name"
              defaultValue={event.name}
              className="rounded-lg border border-forest-200 px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-forest-600">
              Exercise
            </span>
            <select
              name="exercise_type"
              defaultValue={event.exercise_type}
              className="rounded-lg border border-forest-200 px-3 py-2"
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
            className="rounded-lg border border-forest-200 px-4 py-2 text-sm hover:bg-forest-50"
          >
            Save meta
          </button>
        </form>

        <SetupWizard
          eventId={id}
          eventName={event.name}
          exerciseType={event.exercise_type}
          hasMap={!!map}
          mapWidth={map?.width ?? 0}
          mapHeight={map?.height ?? 0}
          initialGeoref={georef}
          initialControls={controls.map((c) => ({
            code: c.code,
            sequence: c.sequence,
            lat: c.lat,
            lon: c.lon,
            map_x: c.map_x,
            map_y: c.map_y,
          }))}
          tracks={tracks}
          initialMapOpacity={map?.opacity ?? 0.55}
          initialRaceWindowEnabled={event.race_window_enabled !== false}
          initialDayPhases={dayPhases.map((p) => ({
            kind: p.kind,
            name: p.name,
            controlCodes: p.controlCodes,
            courseDef: p.courseDef,
          }))}
        />
      </div>
    </main>
  );
}
