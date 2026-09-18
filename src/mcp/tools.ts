import { z } from "zod";

/** The six tools of spec section 8, shared by the stdio server and the daemon socket. */
export const TOOL_SHAPES = {
  post: {
    description:
      "Post a message to one colleague in a container. kind: say (information), ask (needs an answer), report (a deliverable). to: a member name or owner.",
    input: {
      container: z.string().min(1),
      to: z.string().min(1),
      body: z.string().min(1),
      kind: z.enum(["say", "ask", "report"]),
    },
  },
  answer: {
    description: "Answer an ask by its message id. Clears your open question.",
    input: { message_id: z.number().int().positive(), body: z.string().min(1) },
  },
  read_channel: {
    description:
      "Back-scroll only: messages of a container after an id. New messages already arrive in your turn prompt.",
    input: { container: z.string().min(1), since: z.number().int().nonnegative() },
  },
  request: {
    description:
      "Ask the daemon to act: open_task, close_task, hire, retire, pause, set_budget, merge_production, run_schedule. Your role lists which you may use.",
    input: { kind: z.string().min(1), payload: z.record(z.string(), z.unknown()).default({}) },
  },
  remember: {
    description: "Append one line to your MEMORY.md; it is echoed into your next turn prompt.",
    input: { text: z.string().min(1) },
  },
  status: {
    description:
      "Your budget left, open asks, pending requests and the cache hit ratio of your last turn.",
    input: {},
  },
} as const;

export type ToolName = keyof typeof TOOL_SHAPES;
export const TOOL_NAMES = Object.keys(TOOL_SHAPES) as ToolName[];

export type ToolContext = { agent: string; turnId: number };
export type ToolHandlers = {
  [K in ToolName]: (ctx: ToolContext, input: unknown) => Promise<unknown>;
};

export function validateInput(name: ToolName, input: unknown): unknown {
  return z.object(TOOL_SHAPES[name].input).parse(input ?? {});
}
