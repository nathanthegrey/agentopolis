// An interactive card is a renders row plus an outbox row: the button carries the row id and an
// epoch, never the payload (spec section 5). Rewriting a card needs the ts Slack returned, which
// the outbox row kept, so the render remembers which outbox row posted it.
import { eq } from "drizzle-orm";
import { COMPANY_APP } from "../ports/chat.js";
import type { Clock } from "../ports/clock.js";
import { approvalCard, type Card, decidedCard } from "../slack/blocks.js";
import type { Db } from "../store/db.js";
import { appendEvent } from "../store/events.js";
import { enqueueOutbox } from "../store/outbox.js";
import * as schema from "../store/schema.js";

export type RenderPayload = {
  epoch: number;
  channel: string;
  /** the outbox row that posted it; its slackTs is the message to update */
  outboxId: number | null;
  /** what the button decides: a requests row or a permission_requests row */
  subject: { kind: "request" | "permission"; id: number };
  agent: string;
  card: Card;
  /** the full payload behind the Dettagli modal */
  details: unknown;
};

export type ApprovalCardSpec = {
  kind: string;
  agent: string;
  channel: string;
  line: string;
  context: string;
  destructive: boolean;
  /** show "Approva per questo compito" (permission prompts only, spec section 10) */
  scoped: boolean;
  epoch: number;
  subject: RenderPayload["subject"];
  details: unknown;
};

/** Writes the render row, then the card that carries its id. One transaction. */
export function renderApprovalCard(db: Db, clock: Clock, spec: ApprovalCardSpec): number {
  return db.orm.transaction((tx) => {
    const now = clock.now();
    const renderId = tx
      .insert(schema.renders)
      .values({ kind: spec.kind, payload: {}, createdAt: now })
      .returning({ id: schema.renders.id })
      .get().id;
    const card = approvalCard({
      renderId,
      epoch: spec.epoch,
      kind: spec.kind,
      line: spec.line,
      context: spec.context,
      destructive: spec.destructive,
      scoped: spec.scoped,
    });
    const outboxId = enqueueOutbox(tx, clock, {
      kind: "card.post",
      channel: spec.channel,
      payload: { text: card.text, blocks: card.blocks, app: COMPANY_APP },
    });
    const payload: RenderPayload = {
      epoch: spec.epoch,
      channel: spec.channel,
      outboxId,
      subject: spec.subject,
      agent: spec.agent,
      card,
      details: spec.details,
    };
    tx.update(schema.renders).set({ payload }).where(eq(schema.renders.id, renderId)).run();
    appendEvent(tx, {
      at: now,
      kind: "card.rendered",
      agent: spec.agent,
      payload: { renderId, kind: spec.kind, subject: spec.subject },
    });
    return renderId;
  });
}

export function renderPayload(db: Db, renderId: number): RenderPayload | undefined {
  const row = db.orm.select().from(schema.renders).where(eq(schema.renders.id, renderId)).get();
  return row ? (row.payload as RenderPayload) : undefined;
}

/** On a decision the card keeps its question and its actions row becomes a muted line. */
export function rewriteCard(
  db: Db,
  clock: Clock,
  renderId: number,
  outcome: "approvato" | "negato" | "scaduta",
  by: string | undefined,
): void {
  const payload = renderPayload(db, renderId);
  if (!payload) return;
  const ts = payload.outboxId
    ? (db.orm.select().from(schema.outbox).where(eq(schema.outbox.id, payload.outboxId)).get()
        ?.slackTs ?? null)
    : null;
  const now = clock.now();
  const rewritten = decidedCard(payload.card, {
    outcome,
    by,
    at: now,
    reopen: outcome === "scaduta",
  });
  db.orm.transaction((tx) => {
    tx.update(schema.renders)
      .set({ payload: { ...payload, card: rewritten } })
      .where(eq(schema.renders.id, renderId))
      .run();
    // the card may not have reached Slack yet; then the pump will post the rewritten one
    if (ts !== null) {
      enqueueOutbox(tx, clock, {
        kind: "card.update",
        channel: payload.channel,
        payload: { ts, text: rewritten.text, blocks: rewritten.blocks, app: COMPANY_APP },
      });
    } else if (payload.outboxId !== null) {
      tx.update(schema.outbox)
        .set({ payload: { text: rewritten.text, blocks: rewritten.blocks, app: COMPANY_APP } })
        .where(eq(schema.outbox.id, payload.outboxId))
        .run();
    }
    appendEvent(tx, {
      at: now,
      kind: "card.decided",
      agent: payload.agent,
      payload: { renderId, outcome, by: by ?? null },
    });
  });
}
