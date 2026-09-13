import Link from "next/link";
import { redirect } from "next/navigation";
import BackupRestorePanel from "@/components/BackupRestorePanel";
import { isSetupUnlocked } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!(await isSetupUnlocked())) {
    redirect(`/login?next=${encodeURIComponent("/admin")}`);
  }

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Link href="/" className="text-sm text-forest-600 hover:underline">
          ← VectorRun
        </Link>
        <h1 className="font-display text-3xl text-forest-900 mt-3 mb-6">
          Admin
        </h1>
        <BackupRestorePanel />
      </div>
    </main>
  );
}
