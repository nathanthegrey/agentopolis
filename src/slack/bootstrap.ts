// Containers at boot (spec section 9, one app per standing agent):
//   - the ceo's direct message with the owner, through the company app;
//   - each lead's direct message with the owner, through the lead's own app;
//   - per project, #<slug>-hq and #<slug><suffix>, private, created by the company app (it posts
//     the cards there), with the owner and the lead's bot user invited.
// Idempotent against the store AND against Slack: an existing channel is adopted by name
// through conversations.list; name_taken never stops the run. The bare #<slug> is never used
// (Slack refuses a channel named like the workspace).
import { eq } from "drizzle-orm";
import type { Snapshot } from "../config/loader.js";
import type { AgentFile } from "../config/schemas.js";
import { type AppName, type Chat, ChatError, COMPANY_APP } from "../ports/chat.js";
import type { Clock } from "../ports/clock.js";
import type { Db } from "../store/db.js";
import { appendEvent } from "../store/events.js";
import * as schema from "../store/schema.js";

export type ProjectChannel = {
  name: string;
  slug: string;
  lead: string;
  leadApp: AppName;
  topic: string;
};
export type Bootstrapped = {
  /** channel name → Slack channel id */
  channels: Map<string, string>;
  /** agent → its DM id with the owner */
  dms: Map<string, string>;
  created: { name: string; channel: string }[];
  adopted: { name: string; channel: string }[];
};

const INVITE_ALREADY = new Set(["already_in_channel", "cant_invite_self", "cant_invite"]);
const HQ = "-hq";

export function ceoAgent(snapshot: Snapshot): AgentFile | undefined {
  return [...snapshot.agents.values()].find((a) => a.role === "ceo");
}

export function projectChannels(snapshot: Snapshot): ProjectChannel[] {
  const suffix = snapshot.config.slack.work_channel_suffix;
  const list: ProjectChannel[] = [];
  for (const [slug, project] of snapshot.projects) {
    const lead = snapshot.agents.get(project.lead);
    const leadApp = lead?.slack_app ?? COMPANY_APP;
    list.push({
      name: `${slug}${HQ}`,
      slug,
      lead: project.lead,
      leadApp,
      topic: `${project.name}: decisioni, approvazioni, ricevute`,
    });
    list.push({
      name: `${slug}${suffix}`,
      slug,
      lead: project.lead,
      leadApp,
      topic: `${project.name}: lavoro in corso, un thread per compito`,
    });
  }
  return list;
}

/** name → channel id for containers this store already has (by name column) */
function knownByName(db: Db, kind: "dm" | "standing"): Map<string, string> {
  const known = new Map<string, string>();
  for (const row of db.orm
    .select()
    .from(schema.containers)
    .where(eq(schema.containers.kind, kind))
    .all()) {
    if (row.name && row.slackChannel) known.set(row.name, row.slackChannel);
  }
  return known;
}

export async function ensureContainers(
  chat: Chat,
  db: Db,
  clock: Clock,
  snapshot: Snapshot,
  ownerUserId: string,
): Promise<Bootstrapped> {
  const channels = knownByName(db, "standing");
  const dms = new Map<string, string>();
  for (const [name, id] of knownByName(db, "dm")) dms.set(name.replace(/^dm:/, ""), id);
  const created: { name: string; channel: string }[] = [];
  const adopted: { name: string; channel: string }[] = [];

  const record = (
    row: { kind: "dm" | "standing"; name: string; agent: string; channel: string },
    eventKind: "dm.opened" | "channel.created" | "channel.adopted",
    extra: Record<string, unknown> = {},
  ) => {
    const now = clock.now();
    db.orm.transaction((tx) => {
      tx.insert(schema.containers)
        .values({
          kind: row.kind,
          name: row.name,
          members: [row.agent, "owner"],
          defaultTo: row.agent,
          slackChannel: row.channel,
        })
        .run();
      appendEvent(tx, {
        at: now,
        kind: eventKind,
        agent: row.agent,
        payload: { name: row.name, channel: row.channel, agent: row.agent, ...extra },
      });
    });
  };

  // direct messages: the ceo through the company app, each lead through its own app
  const standing: { agent: AgentFile; app: AppName }[] = [];
  const ceo = ceoAgent(snapshot);
  if (ceo) standing.push({ agent: ceo, app: ceo.slack_app ?? COMPANY_APP });
  for (const project of snapshot.projects.values()) {
    const lead = snapshot.agents.get(project.lead);
    if (lead?.slack_app && !standing.some((s) => s.agent.name === lead.name))
      standing.push({ agent: lead, app: lead.slack_app });
  }
  for (const { agent, app } of standing) {
    if (dms.has(agent.name)) continue;
    const { id } = await chat.openDm(ownerUserId, app);
    record({ kind: "dm", name: `dm:${agent.name}`, agent: agent.name, channel: id }, "dm.opened", {
      app,
    });
    dms.set(agent.name, id);
  }

  // project channels, created by the company app; the lead's app is invited so it can post
  let inSlack: Map<string, string> | undefined;
  const slackByName = async (refresh = false): Promise<Map<string, string>> => {
    if (!inSlack || refresh)
      inSlack = new Map((await chat.listPrivateChannels(COMPANY_APP)).map((c) => [c.name, c.id]));
    return inSlack;
  };
  const invite = async (channel: string, users: string[]) => {
    try {
      await chat.invite(channel, users, COMPANY_APP);
    } catch (e) {
      if (e instanceof ChatError && INVITE_ALREADY.has(e.code)) return;
      throw e;
    }
  };
  const members = async (c: ProjectChannel): Promise<string[]> =>
    c.leadApp === COMPANY_APP ? [ownerUserId] : [ownerUserId, await chat.botUserId(c.leadApp)];
  const adopt = async (c: ProjectChannel, id: string) => {
    await invite(id, await members(c));
    record({ kind: "standing", name: c.name, agent: c.lead, channel: id }, "channel.adopted", {
      project: c.slug,
    });
    channels.set(c.name, id);
    adopted.push({ name: c.name, channel: id });
  };

  for (const c of projectChannels(snapshot)) {
    if (channels.has(c.name)) continue;
    const existing = (await slackByName()).get(c.name);
    if (existing) {
      await adopt(c, existing);
      continue;
    }
    let id: string;
    try {
      id = (await chat.createPrivateChannel(c.name, COMPANY_APP)).id;
    } catch (e) {
      if (!(e instanceof ChatError && e.code === "name_taken")) throw e;
      const again = (await slackByName(true)).get(c.name);
      if (!again) throw e;
      await adopt(c, again);
      continue;
    }
    await invite(id, await members(c));
    await chat.setTopic(id, c.topic, COMPANY_APP);
    record({ kind: "standing", name: c.name, agent: c.lead, channel: id }, "channel.created", {
      project: c.slug,
    });
    channels.set(c.name, id);
    created.push({ name: c.name, channel: id });
  }
  return { channels, dms, created, adopted };
}
