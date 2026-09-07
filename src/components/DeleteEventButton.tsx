"use client";

import { useState } from "react";
import { actionDeleteEvent } from "@/app/actions";

export default function DeleteEventButton({
  eventId,
  eventName,
}: {
  eventId: string;
  eventName: string;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-sm px-3 py-1.5 rounded-lg text-forest-500 hover:text-red-700 hover:bg-red-50"
      >
        Delete…
      </button>
    );
  }

  return (
    <form action={actionDeleteEvent} className="flex items-center gap-2">
      <input type="hidden" name="id" value={eventId} />
      <span className="text-xs text-red-800 max-w-[10rem]">
        Delete “{eventName}”? This cannot be undone.
      </span>
      <button
        type="submit"
        className="text-sm px-3 py-1.5 rounded-lg bg-red-700 text-white hover:bg-red-800"
      >
        Delete
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-sm px-3 py-1.5 rounded-lg border border-forest-200 hover:bg-forest-50"
      >
        Cancel
      </button>
    </form>
  );
}
