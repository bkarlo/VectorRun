"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addParticipant,
  createEvent,
  deleteEvent,
  deleteParticipant,
  getTrackForParticipant,
  listControls,
  listParticipants,
  loadTrackPoints,
  renameParticipant,
  replaceControls,
  replaceDayPlan,
  saveGeoref,
  saveMapOpacity,
  saveTrack,
  setManualDelta,
  setParticipantSyncStrategy,
  setRaceWindowEnabled,
  setPlaybackTrailEnabled,
  setReferenceParticipant,
  updateEvent,
} from "@/lib/events";
import { parseGpx } from "@/lib/gpx";
import {
  fillPrefixFromLegs,
  mergeTrackPoints,
  prependPrefix,
} from "@/lib/trackRepair";
import type {
  ControlRow,
  DayPhaseKind,
  ExerciseType,
  GeorefPair,
  SyncStrategy,
} from "@/lib/types";

export async function actionCreateEvent(formData: FormData) {
  const name = String(formData.get("name") || "Untitled event").trim();
  const exercise_type = String(
    formData.get("exercise_type") || "normal"
  ) as ExerciseType;
  const event = createEvent(name, exercise_type);
  redirect(`/events/${event.id}`);
}

export async function actionDeleteEvent(formData: FormData) {
  const id = String(formData.get("id"));
  deleteEvent(id);
  revalidatePath("/");
}

export async function actionUpdateEventMeta(formData: FormData) {
  const id = String(formData.get("id"));
  const name = String(formData.get("name") || "").trim();
  const exercise_type = String(formData.get("exercise_type")) as ExerciseType;
  updateEvent(id, { name, exercise_type });
  revalidatePath(`/events/${id}`);
  revalidatePath(`/events/${id}/setup`);
}

export async function actionSaveGeoref(eventId: string, pairs: GeorefPair[]) {
  saveGeoref(eventId, pairs);
  revalidatePath(`/events/${eventId}/setup`);
  revalidatePath(`/events/${eventId}`);
}

export async function actionSaveMapOpacity(eventId: string, opacity: number) {
  saveMapOpacity(eventId, opacity);
  revalidatePath(`/events/${eventId}/setup`);
  revalidatePath(`/events/${eventId}`);
}

export async function actionSaveRaceWindow(
  eventId: string,
  enabled: boolean
) {
  setRaceWindowEnabled(eventId, enabled);
  revalidatePath(`/events/${eventId}/setup`);
  revalidatePath(`/events/${eventId}`);
}

export async function actionSavePlaybackTrail(
  eventId: string,
  enabled: boolean
) {
  setPlaybackTrailEnabled(eventId, enabled);
  revalidatePath(`/events/${eventId}/setup`);
  revalidatePath(`/events/${eventId}`);
}

export async function actionSaveDayPlan(
  eventId: string,
  phases: {
    kind: DayPhaseKind;
    name: string;
    controlCodes?: string[];
    courseDef?: import("@/lib/courseDef").CourseDef | null;
  }[]
) {
  replaceDayPlan(eventId, phases);
  revalidatePath(`/events/${eventId}/setup`);
  revalidatePath(`/events/${eventId}`);
}

export async function actionSaveControls(
  eventId: string,
  controls: Omit<ControlRow, "id" | "event_id">[]
) {
  replaceControls(eventId, controls);
  revalidatePath(`/events/${eventId}/setup`);
  revalidatePath(`/events/${eventId}`);
}

export async function actionAddParticipant(formData: FormData) {
  const eventId = String(formData.get("event_id"));
  const name = String(formData.get("name") || "").trim();
  if (!name) return;
  addParticipant(eventId, name);
  revalidatePath(`/events/${eventId}`);
}

export async function actionDeleteParticipant(formData: FormData) {
  const participantId = String(formData.get("participant_id"));
  const eventId = String(formData.get("event_id"));
  deleteParticipant(participantId);
  revalidatePath(`/events/${eventId}`);
}

export async function actionRenameParticipant(formData: FormData) {
  const participantId = String(formData.get("participant_id"));
  const eventId = String(formData.get("event_id"));
  const name = String(formData.get("name") || "").trim();
  if (!name) return;
  renameParticipant(participantId, name);
  revalidatePath(`/events/${eventId}`);
}

export async function actionSetReference(formData: FormData) {
  const eventId = String(formData.get("event_id"));
  const participantId = String(formData.get("participant_id"));
  setReferenceParticipant(eventId, participantId);
  revalidatePath(`/events/${eventId}`);
}

export async function actionSetRunnerSyncStrategy(formData: FormData) {
  const eventId = String(formData.get("event_id"));
  const participantId = String(formData.get("participant_id"));
  const strategy = String(formData.get("sync_strategy")) as SyncStrategy;
  setParticipantSyncStrategy(participantId, strategy);
  revalidatePath(`/events/${eventId}`);
}

export async function actionSetRunnerDelta(formData: FormData) {
  const eventId = String(formData.get("event_id"));
  const participantId = String(formData.get("participant_id"));
  const deltaSec = Number(formData.get("delta_sec") || 0);
  setManualDelta(participantId, Math.round(deltaSec * 1000));
  revalidatePath(`/events/${eventId}`);
}

function assertParticipantInEvent(
  eventId: string,
  participantId: string
): void {
  const parts = listParticipants(eventId);
  if (!parts.some((p) => p.id === participantId)) {
    throw new Error("Participant not found in event");
  }
}

export async function actionMergeRunnerTracks(
  eventId: string,
  targetId: string,
  sourceId: string
): Promise<{ ok: true; pointCount: number } | { ok: false; error: string }> {
  try {
    if (targetId === sourceId) {
      return { ok: false, error: "Cannot merge a runner with itself" };
    }
    assertParticipantInEvent(eventId, targetId);
    assertParticipantInEvent(eventId, sourceId);

    const targetTrack = getTrackForParticipant(targetId);
    const sourceTrack = getTrackForParticipant(sourceId);
    if (!targetTrack) {
      return { ok: false, error: "Target runner has no track" };
    }
    if (!sourceTrack) {
      return { ok: false, error: "Source runner has no track" };
    }

    const a = loadTrackPoints(targetTrack);
    const b = loadTrackPoints(sourceTrack);
    if (a.length === 0 || b.length === 0) {
      return { ok: false, error: "Both runners need track points" };
    }

    const { points, stats } = mergeTrackPoints(a, b);
    const filename = `${targetTrack.source_filename}+${sourceTrack.source_filename}`;
    saveTrack(targetId, filename.slice(0, 200), points);
    deleteParticipant(sourceId);
    revalidatePath(`/events/${eventId}`);
    return { ok: true, pointCount: stats.pointCountMerged };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Merge failed",
    };
  }
}

export async function actionAppendGpxToRunner(
  eventId: string,
  participantId: string,
  gpxText: string,
  filename: string
): Promise<{ ok: true; pointCount: number } | { ok: false; error: string }> {
  try {
    assertParticipantInEvent(eventId, participantId);
    const track = getTrackForParticipant(participantId);
    if (!track) {
      return { ok: false, error: "Runner has no track to append onto" };
    }

    const incoming = parseGpx(gpxText);
    if (incoming.length === 0) {
      return { ok: false, error: "No track points found in GPX" };
    }

    const existing = loadTrackPoints(track);
    const { points, stats } = mergeTrackPoints(existing, incoming);
    const mergedName = `${track.source_filename}+${filename || "append.gpx"}`;
    saveTrack(participantId, mergedName.slice(0, 200), points);
    revalidatePath(`/events/${eventId}`);
    return { ok: true, pointCount: stats.pointCountMerged };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Append failed",
    };
  }
}

export async function actionFillTrackPrefix(
  eventId: string,
  participantId: string,
  controlIds: string[],
  speedsMps: number[]
): Promise<{ ok: true; pointCount: number } | { ok: false; error: string }> {
  try {
    assertParticipantInEvent(eventId, participantId);
    if (controlIds.length === 0) {
      return { ok: false, error: "Select at least one control waypoint" };
    }
    if (speedsMps.length !== controlIds.length) {
      return { ok: false, error: "Each waypoint needs a speed" };
    }

    const track = getTrackForParticipant(participantId);
    if (!track) {
      return { ok: false, error: "Runner has no track" };
    }
    const existing = loadTrackPoints(track);
    if (existing.length === 0) {
      return { ok: false, error: "Track has no GPS points to attach to" };
    }

    const controls = listControls(eventId);
    const byId = new Map(controls.map((c) => [c.id, c]));
    const waypoints: { lat: number; lon: number }[] = [];
    for (const id of controlIds) {
      const c = byId.get(id);
      if (!c || c.lat == null || c.lon == null) {
        return {
          ok: false,
          error: `Control ${c?.code ?? id} is missing map coordinates`,
        };
      }
      waypoints.push({ lat: c.lat, lon: c.lon });
    }

    const prefix = fillPrefixFromLegs(waypoints, speedsMps, existing[0]);
    const points = prependPrefix(prefix, existing);
    saveTrack(participantId, track.source_filename, points);
    revalidatePath(`/events/${eventId}`);
    return { ok: true, pointCount: points.length };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Fill failed",
    };
  }
}
