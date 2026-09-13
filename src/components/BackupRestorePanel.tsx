"use client";

import { useState } from "react";

export default function BackupRestorePanel() {
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const onRestore = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement | null;
    const file = fileInput?.files?.[0];
    if (!file) {
      setStatus("Choose a .vrbak file first");
      return;
    }
    if (confirm !== "REPLACE") {
      setStatus("Type REPLACE to confirm");
      return;
    }
    setBusy(true);
    setStatus("Restoring…");
    try {
      const body = new FormData();
      body.set("confirm", "REPLACE");
      body.set("file", file);
      const res = await fetch("/api/backup", { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        event_count?: number;
      };
      if (!res.ok) {
        setStatus(data.error || "Restore failed");
        setBusy(false);
        return;
      }
      setStatus(
        `Restored ${data.event_count ?? 0} event(s). Reloading…`
      );
      window.location.reload();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Restore failed");
      setBusy(false);
    }
  };

  return (
    <section className="panel rounded-2xl p-6">
      <h2 className="font-display text-xl text-forest-900 mb-1">
        Backup & restore
      </h2>
      <p className="text-sm text-forest-600 mb-4">
        Download a full copy of this instance (events, courses, maps, GPX).
        Restore replaces everything on this machine — use it to copy production
        onto your laptop.
      </p>
      <div className="flex flex-wrap gap-3 items-center mb-4">
        <a
          href="/api/backup"
          className="rounded-lg bg-forest-700 text-white px-4 py-2 text-sm font-medium hover:bg-forest-800"
        >
          Download backup
        </a>
        <span className="text-xs text-forest-500 font-mono">.vrbak</span>
      </div>
      <form onSubmit={(e) => void onRestore(e)} className="space-y-3">
        <label className="flex flex-col gap-1 text-sm text-forest-700">
          Restore file
          <input
            name="file"
            type="file"
            accept=".vrbak,application/zip"
            disabled={busy}
            className="text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-forest-700 max-w-xs">
          Type REPLACE to confirm overwrite
          <input
            name="confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
            autoComplete="off"
            placeholder="REPLACE"
            className="rounded-lg border border-forest-200 bg-white px-3 py-2 font-mono"
          />
        </label>
        <button
          type="submit"
          disabled={busy || confirm !== "REPLACE"}
          className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-4 py-2 text-sm font-medium hover:bg-red-100 disabled:opacity-40"
        >
          Restore and replace all
        </button>
        {status ? (
          <p className="text-xs font-mono text-forest-600">{status}</p>
        ) : (
          <p className="text-xs text-forest-500">
            This cannot be undone on this machine. Prod is unchanged unless you
            restore there too.
          </p>
        )}
      </form>
    </section>
  );
}
