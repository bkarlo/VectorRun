"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addParticipant,
  createEvent,
  deleteEvent,
  deleteParticipant,
  renameParticipant,
  replaceControls,
  saveGeoref,
  saveMapOpacity,
  setManualDelta,
  setParticipantSyncStrategy,
  setReferenceParticipant,
  updateEvent,
} from "@/lib/events";
import type {
  ControlRow,
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
