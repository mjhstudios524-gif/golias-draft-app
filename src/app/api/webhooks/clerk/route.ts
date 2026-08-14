import { NextResponse, type NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { db } from "@/server/db";
import { Prisma } from "@/generated/prisma/client";
import { clerkEnv } from "@/lib/env";

// Clerk webhook (PLAN.md §9): mirrors users into Postgres. An optimization,
// never a dependency — requireUser() lazily upserts on first authenticated
// write, so a missed/late event can't 500 a brand-new user on draft night.
// Must stay in the proxy.ts public matcher.

export async function POST(req: NextRequest) {
  // Env read OUTSIDE the catch: a missing secret must 500 loudly, not be
  // mislabeled a signature failure.
  const signingSecret = clerkEnv().CLERK_WEBHOOK_SIGNING_SECRET;
  let evt: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    evt = await verifyWebhook(req, { signingSecret });
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  // Svix redelivers with the same message id — same dedupe table as Stripe.
  const svixId = req.headers.get("svix-id");
  if (svixId) {
    try {
      await db.webhookEvent.create({ data: { id: svixId, source: "clerk", type: evt.type } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return NextResponse.json({ received: true, duplicate: true });
      }
      throw e;
    }
  }

  switch (evt.type) {
    case "user.created":
    case "user.updated": {
      const d = evt.data;
      const email =
        d.email_addresses.find((e) => e.id === d.primary_email_address_id)?.email_address ??
        d.email_addresses[0]?.email_address ??
        null;
      const name = [d.first_name, d.last_name].filter(Boolean).join(" ") || null;
      await db.user.upsert({
        where: { id: d.id },
        update: { email, name },
        create: { id: d.id, email, name },
      });
      break;
    }
    case "user.deleted": {
      // GDPR path: soft-delete marker; associated rows keep their FKs.
      if (evt.data.id) {
        await db.user.updateMany({
          where: { id: evt.data.id },
          data: { deletedAt: new Date() },
        });
      }
      break;
    }
    default:
      break; // other event types → 200 no-op
  }

  return NextResponse.json({ received: true });
}
