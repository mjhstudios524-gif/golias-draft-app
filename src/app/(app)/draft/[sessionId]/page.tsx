import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth";
import { buildSessionPayload } from "@/server/sessions";
import { DraftRoom } from "@/components/draft/DraftRoom";

export default async function DraftSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const userId = await requireUser();
  const { sessionId } = await params;
  const session = await db.draftSession.findUnique({
    where: { id: sessionId },
    include: { picks: { orderBy: { overall: "asc" } } },
  });
  if (!session || session.userId !== userId) notFound();
  const payload = buildSessionPayload(session, session.picks);
  return <DraftRoom payload={payload} />;
}
