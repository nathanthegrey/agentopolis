import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendMessage } from "../../src/store/messages.js";
import { nextOutbox } from "../../src/store/outbox.js";
import * as schema from "../../src/store/schema.js";
import {
  deliverEnvelope,
  ENVELOPE_JSON_SCHEMA,
  Envelope,
  parseEnvelope,
} from "../../src/turn/envelope.js";
import { container, eventKinds, jobAgent, world } from "./helpers.js";

describe("Envelope schema", () => {
  it("accepts the empty envelope and fills the three lists", () => {
    const e = Envelope.parse({});
    expect(e).toEqual({ messages: [], remember: [], parked: [] });
  });

  it("refuses an unknown key, an unknown kind and an empty body", () => {
    expect(Envelope.safeParse({ notes: "x" }).success).toBe(false);
    expect(
      Envelope.safeParse({ messages: [{ container: "c", to: "a", kind: "shout", body: "b" }] })
        .success,
    ).toBe(false);
    expect(
      Envelope.safeParse({ messages: [{ container: "c", to: "a", kind: "say", body: "" }] })
        .success,
    ).toBe(false);
  });

  it("never lets an agent write a system message (only the daemon does)", () => {
    expect(
      Envelope.safeParse({ messages: [{ container: "c", to: "a", kind: "system", body: "b" }] })
        .success,
    ).toBe(false);
  });

  it("parseEnvelope reports why a result failed instead of throwing", () => {
    const bad = parseEnvelope({ messages: [{ container: "c" }] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toMatch(/messages\.0\./);
    const good = parseEnvelope({ remember: ["una riga"] });
    expect(good.ok).toBe(true);
  });
});

describe("ENVELOPE_JSON_SCHEMA", () => {
  it("is the same shape as the zod schema, closed and with the four fields", () => {
    const s = ENVELOPE_JSON_SCHEMA as {
      type: string;
      additionalProperties: boolean;
      properties: Record<
        string,
        { type: string; items?: { properties?: Record<string, unknown> } }
      >;
    };
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties).sort()).toEqual(["messages", "parked", "remember"]);
    expect(Object.keys(s.properties.messages?.items?.properties ?? {}).sort()).toEqual([
      "body",
      "container",
      "kind",
      "tests_green",
      "to",
    ]);
  });

  it("is JSON, so the CLI can take it on the command line", () => {
    expect(() => JSON.parse(JSON.stringify(ENVELOPE_JSON_SCHEMA))).not.toThrow();
  });

  it("accepts every fixture the zod schema accepts", () => {
    const fixtures = [
      {},
      { messages: [{ container: "dm:ceo", to: "owner", kind: "say", body: "ciao" }] },
      {
        messages: [
          { container: "task:1", to: "ada", kind: "report", body: "fatto", tests_green: true },
        ],
        remember: ["il proprietario preferisce il tu"],
      },
      { parked: [{ title: "il lint è rotto", why: "fuori dal compito" }] },
    ];
    for (const f of fixtures) expect(Envelope.safeParse(f).success).toBe(true);
  });
});

describe("deliverEnvelope", () => {
  it("appends each message with its event and its outbox row, and reports who to wake", () => {
    const w = world();
    container(w.db, { kind: "dm", name: "dm:ceo", members: ["ceo", "owner"], defaultTo: "ceo" });
    const r = deliverEnvelope(w.db, w.clock, w.snapshot, "ceo", {
      messages: [{ container: "dm:ceo", to: "owner", kind: "say", body: "ciao" }],
      remember: [],
      parked: [],
    });
    expect(r.rejected).toEqual([]);
    expect(r.messageIds).toHaveLength(1);
    expect(r.wakes).toEqual(["owner"]);
    const rows = w.db.orm.select().from(schema.messages).all();
    expect(rows[0]?.author).toBe("ceo");
    expect(rows[0]?.to).toBe("owner");
    expect(nextOutbox(w.db, w.clock.now(), 10).map((o) => o.kind)).toEqual(["mirror.message"]);
    w.db.close();
  });

  it("drops a message to an unknown container, with an event that names the reason", () => {
    const w = world();
    const r = deliverEnvelope(w.db, w.clock, w.snapshot, "ceo", {
      messages: [{ container: "dm:nobody", to: "owner", kind: "say", body: "ciao" }],
      remember: [],
      parked: [],
    });
    expect(r.messageIds).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toMatch(/dm:nobody/);
    expect(eventKinds(w.db)).toEqual(["envelope.rejected"]);
    w.db.close();
  });

  it("drops a message to a container the author does not belong to", () => {
    const w = world();
    container(w.db, { kind: "dm", name: "dm:ada", members: ["ada", "owner"], defaultTo: "ada" });
    const r = deliverEnvelope(w.db, w.clock, w.snapshot, "ceo", {
      messages: [{ container: "dm:ada", to: "owner", kind: "say", body: "ciao" }],
      remember: [],
      parked: [],
    });
    expect(r.messageIds).toEqual([]);
    expect(r.rejected[0]?.reason).toMatch(/ceo.*non è membro|not a member/i);
    w.db.close();
  });

  it("refuses an addressee outside the container's members", () => {
    const w = world();
    container(w.db, { kind: "dm", name: "dm:ceo", members: ["ceo", "owner"], defaultTo: "ceo" });
    const r = deliverEnvelope(w.db, w.clock, w.snapshot, "ceo", {
      messages: [{ container: "dm:ceo", to: "ada", kind: "say", body: "ciao" }],
      remember: [],
      parked: [],
    });
    expect(r.messageIds).toEqual([]);
    expect(r.rejected[0]?.reason).toMatch(/ada/);
    w.db.close();
  });

  it("refuses a report from a developer without tests_green, and accepts one from a lead", () => {
    const w = world();
    container(w.db, {
      kind: "task",
      name: "task:1",
      members: ["ada", "nina", "owner"],
      defaultTo: "ada",
      taskId: 1,
    });
    const fromDev = deliverEnvelope(w.db, w.clock, w.snapshot, "nina", {
      messages: [{ container: "task:1", to: "ada", kind: "report", body: "fatto" }],
      remember: [],
      parked: [],
    });
    expect(fromDev.messageIds).toEqual([]);
    expect(fromDev.rejected[0]?.reason).toMatch(/tests_green/);

    const withFlag = deliverEnvelope(w.db, w.clock, w.snapshot, "nina", {
      messages: [
        { container: "task:1", to: "ada", kind: "report", body: "fatto", tests_green: false },
      ],
      remember: [],
      parked: [],
    });
    expect(withFlag.messageIds).toHaveLength(1);

    const fromLead = deliverEnvelope(w.db, w.clock, w.snapshot, "ada", {
      messages: [{ container: "task:1", to: "owner", kind: "report", body: "consegnato" }],
      remember: [],
      parked: [],
    });
    expect(fromLead.rejected).toEqual([]);
    expect(fromLead.messageIds).toHaveLength(1);
    w.db.close();
  });

  it("records tests_green on the report row, so the rung counter can read it", () => {
    const w = world();
    container(w.db, {
      kind: "task",
      name: "task:1",
      members: ["ada", "nina"],
      defaultTo: "ada",
      taskId: 1,
    });
    deliverEnvelope(w.db, w.clock, w.snapshot, "nina", {
      messages: [
        { container: "task:1", to: "ada", kind: "report", body: "rotto", tests_green: false },
      ],
      remember: [],
      parked: [],
    });
    const row = w.db.orm.select().from(schema.messages).all()[0];
    expect(row?.testsGreen).toBe(false);
    w.db.close();
  });

  it("marks the ask a message answers, so open asks stay derived", () => {
    const w = world();
    const c = container(w.db, {
      kind: "dm",
      name: "dm:ceo",
      members: ["ceo", "owner"],
      defaultTo: "ceo",
    });
    const ask = appendMessage(w.db, w.clock, {
      containerId: c,
      author: "owner",
      to: "ceo",
      body: "quanto costa?",
      kind: "ask",
    });
    const r = deliverEnvelope(w.db, w.clock, w.snapshot, "ceo", {
      messages: [{ container: "dm:ceo", to: "owner", kind: "say", body: "poco" }],
      remember: [],
      parked: [],
    });
    const rows = w.db.orm.select().from(schema.messages).all();
    const asked = rows.find((m) => m.id === ask.messageId);
    expect(asked?.answeredBy).toBe(r.messageIds[0]);
    w.db.close();
  });

  it("appends remember to a standing agent's MEMORY.md and keeps the previous content", () => {
    const w = world();
    const memory = join(w.home, "agents", "ceo", "MEMORY.md");
    writeFileSync(memory, "# Memoria\n\n- prima riga\n");
    const r = deliverEnvelope(w.db, w.clock, w.snapshot, "ceo", {
      messages: [],
      remember: ["il proprietario scrive in italiano", "chiama il lead Ada"],
      parked: [],
    });
    expect(r.remembered).toEqual(["il proprietario scrive in italiano", "chiama il lead Ada"]);
    const after = readFileSync(memory, "utf8");
    expect(after).toContain("- prima riga");
    expect(after).toContain("- il proprietario scrive in italiano");
    expect(after).toContain("- chiama il lead Ada");
    const memoryEvent = w.db.orm
      .select()
      .from(schema.events)
      .all()
      .find((e) => e.kind === "memory.appended");
    expect((memoryEvent?.payload as { previous: string } | undefined)?.previous).toBe(
      "# Memoria\n\n- prima riga\n",
    );
    w.db.close();
  });

  it("creates MEMORY.md when it does not exist yet", () => {
    const w = world();
    deliverEnvelope(w.db, w.clock, w.snapshot, "ada", {
      messages: [],
      remember: ["una cosa"],
      parked: [],
    });
    expect(readFileSync(join(w.home, "agents", "ada", "MEMORY.md"), "utf8")).toContain(
      "- una cosa",
    );
    w.db.close();
  });

  it("refuses remember from a job agent: only a standing agent has a folder", () => {
    const w = world();
    jobAgent(w.db, { name: "dev-1", role: "developer", project: "agentopolis", taskId: 1 });
    const r = deliverEnvelope(w.db, w.clock, w.snapshot, "dev-1", {
      messages: [],
      remember: ["non ho una cartella"],
      parked: [],
    });
    expect(r.remembered).toEqual([]);
    expect(r.rejected[0]?.scope).toBe("remember");
    expect(eventKinds(w.db)).toEqual(["envelope.rejected"]);
    w.db.close();
  });

  it("turns parked discoveries into tasks rows with status parked, under the agent's project", () => {
    const w = world();
    const r = deliverEnvelope(w.db, w.clock, w.snapshot, "ada", {
      messages: [],
      remember: [],
      parked: [{ title: "il lint è rotto", why: "fuori dal compito" }],
    });
    expect(r.parkedTaskIds).toHaveLength(1);
    const task = w.db.orm.select().from(schema.tasks).all()[0];
    expect(task?.status).toBe("parked");
    expect(task?.project).toBe("agentopolis");
    expect(task?.title).toBe("il lint è rotto");
    expect(task?.lead).toBe("ada");
    expect(eventKinds(w.db)).toContain("task.parked");
    w.db.close();
  });

  it("refuses a parked discovery from an agent with no project", () => {
    const w = world();
    const r = deliverEnvelope(w.db, w.clock, w.snapshot, "ceo", {
      messages: [],
      remember: [],
      parked: [{ title: "x", why: "y" }],
    });
    expect(r.parkedTaskIds).toEqual([]);
    expect(r.rejected[0]?.scope).toBe("parked");
    w.db.close();
  });

  it("delivers the good parts of an envelope and rejects only the bad ones", () => {
    const w = world();
    container(w.db, { kind: "dm", name: "dm:ada", members: ["ada", "owner"], defaultTo: "ada" });
    const r = deliverEnvelope(w.db, w.clock, w.snapshot, "ada", {
      messages: [
        { container: "dm:ada", to: "owner", kind: "say", body: "buona" },
        { container: "dm:ghost", to: "owner", kind: "say", body: "cattiva" },
      ],
      remember: ["ricordo"],
      parked: [{ title: "t", why: "w" }],
    });
    expect(r.messageIds).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.remembered).toHaveLength(1);
    expect(r.parkedTaskIds).toHaveLength(1);
    w.db.close();
  });

  it("an unknown author delivers nothing", () => {
    const w = world();
    container(w.db, { kind: "dm", name: "dm:ceo", members: ["ceo", "owner"], defaultTo: "ceo" });
    const r = deliverEnvelope(w.db, w.clock, w.snapshot, "ghost", {
      messages: [{ container: "dm:ceo", to: "owner", kind: "say", body: "ciao" }],
      remember: [],
      parked: [],
    });
    expect(r.messageIds).toEqual([]);
    expect(r.rejected[0]?.reason).toMatch(/ghost/);
    w.db.close();
  });
});
