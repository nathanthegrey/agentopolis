// Standing channels: #ceo, #<project>, #<project><suffix>. Idempotent: a channel already
// recorded (channel.created event + containers row) is not created again.
import { eq } from "drizzle-orm";
import type { Snapshot } from "../config/loader.js";
import type { Chat } from "../ports/chat.js";
import type { Clock } from "../ports/clock.js";
import type { Db } from "../store/db.js";
import { appendEvent } from "../store/events.js";
import * as schema from "../store/schema.js";

export type StandingChannel = { name: string; agent: string; topic: string };

export function standingChannels(snapshot: Snapshot): StandingChannel[] {
  const suffix = snapshot.config.slack.work_channel_suffix;
  const list: StandingChannel[] = [{ name: "ceo", agent: "ceo", topic: "Tu e la CEO" }];
  for (const [slug, project] of snapshot.projects) {
    list.push({
      name: slug,
      agent: project.lead,
      topic: `${project.name}: decisioni, domande, approvazioni`,
    });
    list.push({
      name: `${slug}${suffix}`,
      agent: project.lead,
      topic: `${project.name}: lavoro in corso, un thread per compito`,
    });
  }
  return list;
}

function knownChannels(db: Db): Map<string, string> {
  const known = new Map<string, string>();
  for (const e of db.orm
    .select()
    .from(schema.events)
    .where(eq(schema.events.kind, "channel.created"))
    .all()) {
    const p = e.payload as { name?: string; channel?: string };
    if (p.name && p.channel) known.set(p.name, p.channel);
  }
  return known;
}

export async function ensureChannels(
  chat: Chat,
  db: Db,
  clock: Clock,
  snapshot: Snapshot,
  ownerUserId: string,
): Promise<{ created: { name: string; channel: string }[] }> {
  const known = knownChannels(db);
  const created: { name: string; channel: string }[] = [];
  for (const c of standingChannels(snapshot)) {
    const existing = known.get(c.name);
    if (existing) {
      const row = db.orm
        .select()
        .from(schema.containers)
        .where(eq(schema.containers.slackChannel, existing))
        .get();
      if (row) continue;
    }
    const { id } = await chat.createPrivateChannel(c.name);
    await chat.invite(id, [ownerUserId]);
    await chat.setTopic(id, c.topic);
    const now = clock.now();
    db.orm.transaction((tx) => {
      tx.insert(schema.containers)
        .values({
          kind: "standing",
          members: [c.agent, "owner"],
          defaultTo: c.agent,
          slackChannel: id,
        })
        .run();
      appendEvent(tx, {
        at: now,
        kind: "channel.created",
        payload: { name: c.name, channel: id, agent: c.agent },
      });
    });
    created.push({ name: c.name, channel: id });
  }
  return { created };
}
