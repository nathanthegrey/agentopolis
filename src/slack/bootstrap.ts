// Standing channels: #ceo, #<project>, #<project><suffix>. Idempotent against the store AND
// against Slack: a channel that already exists in the workspace (a reinstall with an empty
// database, a second smoke run) is adopted by name through conversations.list, recorded, and
// never created again; name_taken never stops the run.
import { eq } from "drizzle-orm";
import type { Snapshot } from "../config/loader.js";
import { type Chat, ChatError } from "../ports/chat.js";
import type { Clock } from "../ports/clock.js";
import type { Db } from "../store/db.js";
import { appendEvent } from "../store/events.js";
import * as schema from "../store/schema.js";

export type StandingChannel = { name: string; agent: string; topic: string };
export type Bootstrapped = {
  /** name → Slack channel id for every standing channel, whatever its origin */
  channels: Map<string, string>;
  created: { name: string; channel: string }[];
  adopted: { name: string; channel: string }[];
};

const INVITE_ALREADY = new Set(["already_in_channel", "cant_invite_self", "cant_invite"]);

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

/** name → channel id for channels this store already recorded and still has a container for */
function knownChannels(db: Db): Map<string, string> {
  const known = new Map<string, string>();
  const kinds = new Set(["channel.created", "channel.adopted"]);
  for (const e of db.orm.select().from(schema.events).all()) {
    if (!kinds.has(e.kind)) continue;
    const p = e.payload as { name?: string; channel?: string };
    if (!p.name || !p.channel) continue;
    const row = db.orm
      .select()
      .from(schema.containers)
      .where(eq(schema.containers.slackChannel, p.channel))
      .get();
    if (row) known.set(p.name, p.channel);
  }
  return known;
}

export async function ensureChannels(
  chat: Chat,
  db: Db,
  clock: Clock,
  snapshot: Snapshot,
  ownerUserId: string,
): Promise<Bootstrapped> {
  const channels = knownChannels(db);
  const created: { name: string; channel: string }[] = [];
  const adopted: { name: string; channel: string }[] = [];
  let inSlack: Map<string, string> | undefined;
  const slackByName = async (refresh = false): Promise<Map<string, string>> => {
    if (!inSlack || refresh) {
      inSlack = new Map((await chat.listPrivateChannels()).map((c) => [c.name, c.id]));
    }
    return inSlack;
  };
  const record = (c: StandingChannel, id: string, kind: "channel.created" | "channel.adopted") => {
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
      appendEvent(tx, { at: now, kind, payload: { name: c.name, channel: id, agent: c.agent } });
    });
    channels.set(c.name, id);
  };
  const inviteOwner = async (id: string) => {
    try {
      await chat.invite(id, [ownerUserId]);
    } catch (e) {
      if (e instanceof ChatError && INVITE_ALREADY.has(e.code)) return;
      throw e;
    }
  };

  for (const c of standingChannels(snapshot)) {
    if (channels.has(c.name)) continue;
    const existing = (await slackByName()).get(c.name);
    if (existing) {
      await inviteOwner(existing);
      record(c, existing, "channel.adopted");
      adopted.push({ name: c.name, channel: existing });
      continue;
    }
    let id: string;
    try {
      id = (await chat.createPrivateChannel(c.name)).id;
    } catch (e) {
      if (!(e instanceof ChatError && e.code === "name_taken")) throw e;
      // created between our list and our create, or invisible to the first list: adopt it
      const again = (await slackByName(true)).get(c.name);
      if (!again) throw e;
      await inviteOwner(again);
      record(c, again, "channel.adopted");
      adopted.push({ name: c.name, channel: again });
      continue;
    }
    await inviteOwner(id);
    await chat.setTopic(id, c.topic);
    record(c, id, "channel.created");
    created.push({ name: c.name, channel: id });
  }
  return { channels, created, adopted };
}
