import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";
import { db } from "./db";

export const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const DEV_USER_ID = "dev_local_user";

export class UnauthorizedError extends Error {}

/**
 * Resolve the authenticated user's id, lazily upserting the local User row
 * (the Clerk webhook is an optimization, never a dependency — PLAN.md §9).
 *
 * Dev-only fallback: with no Clerk keys configured OUTSIDE production, a fixed
 * local user is used so the full stack runs before external services exist.
 * In production, missing keys fail loudly.
 */
export async function requireUser(): Promise<string> {
  if (!clerkEnabled) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Clerk is not configured — refusing to run authless in production");
    }
    await db.user.upsert({
      where: { id: DEV_USER_ID },
      update: {},
      create: { id: DEV_USER_ID, email: "dev@localhost", name: "Local Dev" },
    });
    return DEV_USER_ID;
  }

  const { userId } = await auth();
  if (!userId) throw new UnauthorizedError("not signed in");
  const user = await currentUser();
  await db.user.upsert({
    where: { id: userId },
    update: {},
    create: {
      id: userId,
      email: user?.primaryEmailAddress?.emailAddress ?? null,
      name: user?.fullName ?? null,
    },
  });
  return userId;
}
