// Live smoke against the owner's Slack workspace, BY HAND on the owner's Mac:
//   set -a; source ~/.agentopolis.env; set +a
//   AGENTOPOLIS_LIVE=1 pnpm slack:smoke                     (smoke: persona, ask card, /hire, Home)
//   AGENTOPOLIS_LIVE=1 AGENTOPOLIS_CHECKS=1,2 pnpm slack:smoke   (adds spec section 18 checks 1–2)
// Reads SLACK_BOT_TOKEN, SLACK_APP_TOKEN, AGENTOPOLIS_OWNER from the environment; prints none
// of them. Exit 0 only if the persona post succeeded and the ask card was answered.
// If the standing channels already exist (name_taken), set AGENTOPOLIS_SMOKE_CHANNEL to the
// id of #ceo and the smoke posts there.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initHome } from "../../src/cli/init.js";
import { ChatError } from "../../src/ports/chat.js";
import { SystemClock } from "../../src/ports/clock.js";
import { createSlackApp } from "../../src/slack/app.js";
import { answeredCard, askCard, homeView } from "../../src/slack/blocks.js";
import { ensureChannels } from "../../src/slack/bootstrap.js";
import { type Daemon, dispatchCommand, dispatchView } from "../../src/slack/commands.js";
import type { Inbound } from "../../src/slack/inbox.js";
import { postAsPersona } from "../../src/slack/persona.js";
import { openDatabase } from "../../src/store/db.js";
import { events } from "../../src/store/schema.js";

if (process.env.AGENTOPOLIS_LIVE !== "1") {
  console.error("refusing to run: set AGENTOPOLIS_LIVE=1 (this talks to the real Slack workspace)");
  process.exit(2);
}
const token = process.env.SLACK_BOT_TOKEN ?? "";
const appToken = process.env.SLACK_APP_TOKEN ?? "";
const owner = process.env.AGENTOPOLIS_OWNER ?? "";
if (!token || !appToken || !owner) {
  console.error(
    "SLACK_BOT_TOKEN, SLACK_APP_TOKEN and AGENTOPOLIS_OWNER must be set (source ~/.agentopolis.env)",
  );
  process.exit(2);
}
const CHECKS = new Set(
  (process.env.AGENTOPOLIS_CHECKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const WAIT_MS = 120_000;

const work = mkdtempSync(join(tmpdir(), "slack-smoke-"));
const home = initHome(join(work, "home"));
const db = openDatabase(join(work, "home", "data", "agentopolis.db"));
const clock = new SystemClock();
const snapshot = home.snapshot;
const results: Record<string, string> = {};
const step = (name: string, outcome: string) => {
  results[name] = outcome;
  console.log(`STEP ${name}: ${outcome}`);
};

// waiters for the owner's interactions
const waiters: { match: (i: Inbound) => boolean; resolve: (i: Inbound) => void }[] = [];
const waitFor = (label: string, match: (i: Inbound) => boolean): Promise<Inbound | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.log(`  (timeout waiting for ${label})`);
      resolve(undefined);
    }, WAIT_MS);
    waiters.push({
      match,
      resolve: (i) => {
        clearTimeout(timer);
        resolve(i);
      },
    });
  });

const hired: unknown[] = [];
const ok = async () => ({ ok: true }) as const;
const daemon: Daemon = {
  hire: async (form) => {
    hired.push(form);
    return { ok: true };
  },
  edit: ok,
  undoEdit: ok,
  pause: ok,
  resume: ok,
  setModel: ok,
  restart: ok,
  retire: ok,
  diag: async () => "smoke: nessun turno",
  openParked: ok,
  answer: ok,
  approve: ok,
  deny: ok,
  reply: ok,
  currentText: async (agent, file) => `(${agent}/${file}: testo di prova dello smoke)`,
  homeView: async () => view(),
  details: async () => ({ smoke: true }),
};
const view = () =>
  homeView({
    month: "smoke",
    spentMicro: 0,
    waiting: [],
    projects: [...snapshot.projects.values()].map((p) => ({
      slug: p.slug,
      name: p.name,
      channel: "",
    })),
    agents: [...snapshot.agents.values()].map((a) => ({
      name: a.name,
      display: a.display,
      state: "🟢",
      spentMicro: 0,
    })),
    parked: [],
    updatedAt: clock.now(),
  });

const slack = createSlackApp({
  token,
  appToken,
  db,
  clock,
  ownerUserId: owner,
  log: (line, extra) => console.log(`  [app] ${line} ${extra ? JSON.stringify(extra) : ""}`),
  onInbound: async (inbound) => {
    console.log(`  inbound: ${JSON.stringify(inbound).slice(0, 200)}`);
    const w = waiters.findIndex((x) => x.match(inbound));
    if (w >= 0) waiters.splice(w, 1)[0]?.resolve(inbound);
    if (inbound.kind === "command")
      await dispatchCommand(inbound, daemon, slack.chat, { snapshot, ownerUserId: owner });
    if (inbound.kind === "view_submitted")
      return dispatchView(inbound, daemon, slack.chat, { snapshot, ownerUserId: owner });
    return undefined;
  },
});

let exitCode = 1;
try {
  await slack.start();
  step("connect", "socket mode connected");

  // channels
  let ceoChannel = process.env.AGENTOPOLIS_SMOKE_CHANNEL ?? "";
  try {
    const r = await ensureChannels(slack.chat, db, clock, snapshot, owner);
    step("channels", `created ${JSON.stringify(r.created)}`);
    ceoChannel = r.created.find((c) => c.name === "ceo")?.channel ?? ceoChannel;
  } catch (e) {
    const code = e instanceof ChatError ? e.code : String(e);
    step(
      "channels",
      `not created (${code})${ceoChannel ? ", using AGENTOPOLIS_SMOKE_CHANNEL" : ": set AGENTOPOLIS_SMOKE_CHANNEL to the id of #ceo"}`,
    );
  }
  if (!ceoChannel) throw new Error("no channel to post in");

  // persona
  const ada = snapshot.agents.get("ceo");
  const persona = {
    username: ada?.display ?? "Ada · CEO",
    ...(ada?.avatar ? { iconUrl: ada.avatar } : {}),
  };
  const hello = await postAsPersona(slack.chat, {
    channel: ceoChannel,
    text: "Ciao, sono Ada. Questo è lo smoke test.",
    persona,
  });
  step("persona", `posted ts=${hello.ts} (guarda: nome e avatar della persona)`);

  // ask card
  const card = askCard({
    renderId: 1,
    persona: persona.username,
    project: "agentopolis",
    question: "Smoke: quale bottone premi?",
    options: ["Sì", "No"],
  });
  const posted = await slack.chat.post({
    channel: ceoChannel,
    text: card.text,
    blocks: card.blocks,
  });
  console.log(`  premi un bottone sulla card entro ${WAIT_MS / 1000} s …`);
  const click = await waitFor("button", (i) => i.kind === "button" && i.renderId === 1);
  if (click && click.kind === "button") {
    const chosen = click.value.endsWith(":0") ? "Sì" : "No";
    const done = answeredCard(card, { chosen, by: "te", at: clock.now() });
    await slack.chat.update({
      channel: ceoChannel,
      ts: posted.ts,
      text: done.text,
      blocks: done.blocks,
    });
    step("ask", `answered with ${chosen}; card rewritten`);
  } else {
    step("ask", "NOT answered in time");
  }

  // modal from /hire
  console.log(`  digita /hire nel workspace e invia il modulo entro ${WAIT_MS / 1000} s …`);
  const form = await waitFor(
    "view_submission",
    (i) => i.kind === "view_submitted" && i.callbackId === "hire",
  );
  step(
    "hire",
    form ? `form received: ${JSON.stringify(hired[0] ?? form)}` : "no submission in time",
  );

  // home
  await slack.chat.publishHome(owner, view());
  step("home", "published (apri la Home dell'app)");

  // spec section 18, checks 1–2
  if (CHECKS.has("1")) {
    const p = await postAsPersona(slack.chat, {
      channel: ceoChannel,
      text: "check 1: messaggio persona, prima dell'update",
      persona,
    });
    const client = slack.app.client;
    const r = (await client.chat.update({
      channel: ceoChannel,
      ts: p.ts,
      text: "check 1: DOPO chat.update",
    })) as { message?: { username?: string; bot_profile?: unknown; icons?: unknown } };
    console.log(
      `CHECK 1: chat.update response message.username=${JSON.stringify(r.message?.username)} icons=${JSON.stringify(r.message?.icons)} bot_profile=${JSON.stringify(r.message?.bot_profile)}`,
    );
    console.log(
      "  guarda in Slack: il messaggio 'check 1' mostra ancora nome e avatar di Ada? (atteso: no)",
    );
  }
  if (CHECKS.has("2")) {
    const parent = await slack.chat.post({ channel: ceoChannel, text: "check 2: thread di prova" });
    const client = slack.app.client;
    for (const [what, call] of [
      [
        "setStatus",
        () =>
          client.agents.sessions.setStatus({
            channel_id: ceoChannel,
            thread_ts: parent.ts,
            status: "processing",
            username: persona.username,
            ...(persona.iconUrl ? { icon_url: persona.iconUrl } : {}),
          } as never),
      ],
      [
        "rename",
        () =>
          client.agents.sessions.rename({
            channel_id: ceoChannel,
            thread_ts: parent.ts,
            title: "Smoke check 2",
          } as never),
      ],
    ] as const) {
      try {
        const r = (await call()) as unknown as Record<string, unknown>;
        console.log(`CHECK 2 ${what}: ok=${String(r.ok)} ${JSON.stringify(r).slice(0, 200)}`);
      } catch (e) {
        const err = e as { data?: { error?: string }; code?: string; message?: string };
        console.log(`CHECK 2 ${what}: error=${err.data?.error ?? err.code ?? err.message}`);
      }
    }
  }

  const rows = db.orm.select().from(events).all();
  console.log(`events rows written: ${rows.length}`);
  for (const e of rows) console.log(`  ${e.kind} ${JSON.stringify(e.payload).slice(0, 120)}`);
  exitCode = results.persona?.startsWith("posted") && results.ask?.startsWith("answered") ? 0 : 1;
} catch (e) {
  console.error("smoke failed:", e instanceof ChatError ? `${e.code}: ${e.message}` : e);
} finally {
  await slack.stop();
  db.close();
}
console.log(`\nresult: ${JSON.stringify(results)}\nexit ${exitCode}`);
process.exit(exitCode);
