import Link from "next/link";
import { actionUnlockSetup } from "@/app/actions";
import { isAuthRequired, isSetupUnlocked } from "@/lib/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  if (!isAuthRequired() || (await isSetupUnlocked())) {
    redirect("/");
  }
  const { error, next } = await searchParams;
  const nextPath = next?.startsWith("/") ? next : "/";

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-sm px-6 py-24">
        <Link href="/" className="text-sm text-forest-600 hover:underline">
          ← VectorRun
        </Link>
        <h1 className="font-display text-3xl text-forest-900 mt-3">
          Coach login
        </h1>
        <p className="text-sm text-forest-600 mt-2 mb-6">
          Shared password for creating and editing events. Replay stays public.
        </p>
        <form action={actionUnlockSetup} className="space-y-3">
          <input type="hidden" name="next" value={nextPath} />
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-forest-600">
              Password
            </span>
            <input
              type="password"
              name="password"
              required
              autoFocus
              className="rounded-lg border border-forest-200 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-forest-400"
            />
          </label>
          {error ? (
            <p className="text-sm text-red-700">Wrong password.</p>
          ) : null}
          <button
            type="submit"
            className="w-full rounded-lg bg-forest-700 text-white px-4 py-2.5 font-medium hover:bg-forest-800"
          >
            Unlock setup
          </button>
        </form>
      </div>
    </main>
  );
}
