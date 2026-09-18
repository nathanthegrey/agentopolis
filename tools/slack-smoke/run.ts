// Live smoke against the owner's Slack workspace, BY HAND on the owner's Mac:
//   set -a; source ~/.agentopolis.env; set +a
//   AGENTOPOLIS_LIVE=1 pnpm slack:smoke                          (smoke)
//   AGENTOPOLIS_LIVE=1 AGENTOPOLIS_CHECKS=1,2 pnpm slack:smoke   (adds spec section 18 checks 1–2)
// One Slack app per standing agent: Jarvis (the company app, the ceo) and Ada (lead
// Agentopolis). Tokens are read from the environment variables named in
// examples/home/config.yaml (SLACK_BOT_TOKEN/SLACK_APP_TOKEN, SLACK_BOT_TOKEN_ADA/
// SLACK_APP_TOKEN_ADA) plus AGENTOPOLIS_OWNER; none of them is printed.
// Steps: archive the old #ceo channel if it still exists; open the DMs and the project
// channels (adopting agentopolis-work); Jarvis greets in his DM; Ada greets in hers; a
// "Nina · developer" persona posts in #agentopolis-work through Ada's app; an ask card in the
// Jarvis DM; /hire; Home. Exit 0 only if Jarvis posted and the ask card was answered.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initHome } from "../../src/cli/init.js";
import { type AppName, ChatError, COMPANY_APP } from "../../src/ports/chat.js";
import { SystemClock } from "../../src/ports/clock.js";
import { type AppTokens, createSlackApps } from "../../src/slack/app.js";
import { answeredCard, askCard, homeView } from "../../src/slack/blocks.js";
import { ceoAgent, ensureContainers } from "../../src/slack/bootstrap.js";
import { type Daemon, dispatchCommand, dispatchView } from "../../src/slack/commands.js";
import type { Inbound } from "../../src/slack/inbox.js";
import { postAsPersona } from "../../src/slack/persona.js";
import { openDatabase } from "../../src/store/db.js";
import { events } from "../../src/store/schema.js";

if (process.env.AGENTOPOLIS_LIVE !== "1") {
  console.error("refusing to run: set AGENTOPOLIS_LIVE=1 (this talks to the real Slack workspace)");
  process.exit(2);
}
const owner = process.env.AGENTOPOLIS_OWNER ?? "";
if (!owner) {
  console.error("AGENTOPOLIS_OWNER must be set (source ~/.agentopolis.env)");
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

// apps: every app named in config.yaml whose tokens are in the environment; company and ada required
const apps: Record<AppName, AppTokens> = {};
for (const [name, def] of Object.entries(snapshot.config.slack.apps)) {
  const token = process.env[def.bot_token_env] ?? "";
  const appToken = process.env[def.app_token_env] ?? "";
  if (token && appToken) apps[name] = { token, appToken };
  else console.log(`  app "${name}": skipped (${def.bot_token_env}/${def.app_token_env} not set)`);
}
for (const required of [COMPANY_APP, "ada"]) {
  if (!apps[required]) {
    console.error(`app "${required}" is required for the smoke: set its tokens in the environment`);
    process.exit(2);
  }
}

const results: Record<string, string> = {};
const step = (name: string, outcome: string) => {
  results[name] = outcome;
  console.log(`STEP ${name}: ${outcome}`);
};

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

const slack = createSlackApps({
  apps,
  db,
  clock,
  ownerUserId: owner,
  log: (line, extra) => console.log(`  [app] ${line} ${extra ? JSON.stringify(extra) : ""}`),
  onInbound: async (inbound, ctx) => {
    console.log(`  inbound via ${ctx.via}: ${JSON.stringify(inbound).slice(0, 200)}`);
    const w = waiters.findIndex((x) => x.match(inbound));
    if (w >= 0) waiters.splice(w, 1)[0]?.resolve(inbound);
    if (inbound.kind === "command")
      await dispatchCommand(inbound, daemon, slack.chat, { snapshot, ownerUserId: owner });
    if (inbound.kind === "view_submitted")
      return dispatchView(inbound, daemon, slack.chat, { snapshot, ownerUserId: owner });
    return undefined;
  },
});
const rawClient = (app: AppName) => {
  const a = slack.apps.get(app);
  if (!a) throw new Error(`no app ${app}`);
  return a.client;
};

let exitCode = 1;
try {
  await slack.start();
  step("connect", `socket mode connected: ${Object.keys(apps).join(", ")}`);

  // the old #ceo channel: archived, never deleted (spec section 9)
  const oldCeo = (await slack.chat.listPrivateChannels(COMPANY_APP)).find((c) => c.name === "ceo");
  if (oldCeo) {
    await slack.chat.archive(oldCeo.id, COMPANY_APP);
    step("archive-old-ceo", `archived #ceo (${oldCeo.id})`);
  } else {
    step("archive-old-ceo", "no #ceo channel to archive");
  }

  const boot = await ensureContainers(slack.chat, db, clock, snapshot, owner);
  step(
    "containers",
    `dms ${JSON.stringify([...boot.dms])} created ${JSON.stringify(boot.created)} adopted ${JSON.stringify(boot.adopted)}`,
  );
  const jarvis = ceoAgent(snapshot);
  const jarvisDm = jarvis ? (boot.dms.get(jarvis.name) ?? "") : "";
  const adaDm = boot.dms.get("ada") ?? "";
  const workChannel =
    boot.channels.get(`agentopolis${snapshot.config.slack.work_channel_suffix}`) ?? "";
  if (!jarvisDm || !adaDm || !workChannel) throw new Error("missing a DM or the work channel");

  const hello = await slack.chat.post({
    channel: jarvisDm,
    text: "Ciao, sono Jarvis. Questo è lo smoke test.",
    as: COMPANY_APP,
  });
  step("jarvis", `posted ts=${hello.ts} in the Jarvis DM (company app, as himself)`);
  const helloAda = await slack.chat.post({
    channel: adaDm,
    text: "Ciao, sono Ada. Questo è lo smoke test.",
    as: "ada",
  });
  step("ada", `posted ts=${helloAda.ts} in the Ada DM (her app, as herself)`);
  const nina = { username: "Nina · developer", iconEmoji: ":female-technologist:" };
  const helloNina = await postAsPersona(slack.chat, {
    channel: workChannel,
    text: "Ciao, sono Nina, la developer. Posto attraverso l'app di Ada.",
    persona: nina,
    as: "ada",
  });
  step(
    "nina",
    `posted ts=${helloNina.ts} in #agentopolis-work through Ada's app as a persona (guarda: nome e icona)`,
  );

  // ask card in the Jarvis DM, company identity
  const card = askCard({
    renderId: 1,
    persona: "Jarvis",
    project: "agentopolis",
    question: "Smoke: quale bottone premi?",
    options: ["Sì", "No"],
  });
  const posted = await slack.chat.post({
    channel: jarvisDm,
    text: card.text,
    blocks: card.blocks,
    as: COMPANY_APP,
  });
  console.log(`  premi un bottone sulla card nel DM di Jarvis entro ${WAIT_MS / 1000} s …`);
  const click = await waitFor("button", (i) => i.kind === "button" && i.renderId === 1);
  if (click && click.kind === "button") {
    const chosen = click.value.endsWith(":0") ? "Sì" : "No";
    const done = answeredCard(card, { chosen, by: "te", at: clock.now() });
    await slack.chat.update({
      channel: jarvisDm,
      ts: posted.ts,
      text: done.text,
      blocks: done.blocks,
      as: COMPANY_APP,
    });
    step("ask", `answered with ${chosen}; card rewritten`);
  } else {
    step("ask", "NOT answered in time");
  }

  console.log(`  digita /hire nel workspace e invia il modulo entro ${WAIT_MS / 1000} s …`);
  const form = await waitFor(
    "view_submission",
    (i) => i.kind === "view_submitted" && i.callbackId === "hire",
  );
  step(
    "hire",
    form ? `form received: ${JSON.stringify(hired[0] ?? form)}` : "no submission in time",
  );

  await slack.chat.publishHome(owner, view(), COMPANY_APP);
  step("home", "published (apri la Home di Jarvis)");

  if (CHECKS.has("1")) {
    const p = await postAsPersona(slack.chat, {
      channel: workChannel,
      text: "check 1: messaggio persona (Nina), prima dell'update",
      persona: nina,
      as: "ada",
    });
    const r = (await rawClient("ada").chat.update({
      channel: workChannel,
      ts: p.ts,
      text: "check 1: DOPO chat.update",
    })) as {
      message?: { username?: string; bot_profile?: unknown; icons?: unknown };
    };
    console.log(
      `CHECK 1: chat.update response message.username=${JSON.stringify(r.message?.username)} icons=${JSON.stringify(r.message?.icons)} bot_profile=${JSON.stringify(r.message?.bot_profile)}`,
    );
    console.log(
      "  guarda in Slack: il messaggio 'check 1' mostra ancora nome e icona di Nina? (atteso: no)",
    );
  }
  if (CHECKS.has("2")) {
    const parent = await slack.chat.post({
      channel: workChannel,
      text: "check 2: thread di prova",
      as: COMPANY_APP,
    });
    const client = rawClient("ada");
    for (const [what, call] of [
      [
        "setStatus",
        () =>
          client.agents.sessions.setStatus({
            channel_id: workChannel,
            thread_ts: parent.ts,
            status: "processing",
            username: nina.username,
            icon_emoji: nina.iconEmoji,
          } as never),
      ],
      [
        "rename",
        () =>
          client.agents.sessions.rename({
            channel_id: workChannel,
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
  exitCode = results.jarvis?.startsWith("posted") && results.ask?.startsWith("answered") ? 0 : 1;
} catch (e) {
  console.error("smoke failed:", e instanceof ChatError ? `${e.code}: ${e.message}` : e);
} finally {
  await slack.stop();
  db.close();
}
console.log(`\nresult: ${JSON.stringify(results)}\nexit ${exitCode}`);
process.exit(exitCode);
