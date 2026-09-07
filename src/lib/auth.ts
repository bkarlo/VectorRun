import { createHmac } from "crypto";
import { cookies } from "next/headers";

const COOKIE = "vr_coach";
const HMAC_KEY = "vectorrun-setup-v1";

export function setupPassword(): string {
  return (
    process.env.SETUP_PASSWORD?.trim() ||
    process.env.VECTORRUN_SETUP_PASSWORD?.trim() ||
    ""
  );
}

export function isAuthRequired(): boolean {
  return setupPassword().length > 0;
}

function tokenFor(password: string): string {
  return createHmac("sha256", HMAC_KEY).update(password).digest("hex");
}

export async function isSetupUnlocked(): Promise<boolean> {
  if (!isAuthRequired()) return true;
  const jar = await cookies();
  return jar.get(COOKIE)?.value === tokenFor(setupPassword());
}

export async function assertCanSetup(): Promise<void> {
  if (!(await isSetupUnlocked())) {
    throw new Error("Setup is locked. Sign in with the coach password.");
  }
}

export async function unlockSetup(password: string): Promise<boolean> {
  const expected = setupPassword();
  if (!expected || password !== expected) return false;
  const jar = await cookies();
  jar.set(COOKIE, tokenFor(expected), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return true;
}

export async function lockSetup(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}
