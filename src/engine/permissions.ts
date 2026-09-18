import type { Role } from "../config/loader.js";
import type { PermissionRequest } from "../ports/runner.js";

export function matchRule(rule: string, toolName: string, input: unknown): boolean {
  const m = /^([^()]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const tool = m[1] ?? "";
  const spec = m[2];
  const toolOk =
    tool === toolName || (tool.endsWith("*") && toolName.startsWith(tool.slice(0, -1)));
  if (!toolOk) return false;
  if (spec === undefined || spec === "*") return true;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  if (spec.endsWith(" *")) {
    return command === spec.slice(0, -2) || command.startsWith(spec.slice(0, -1));
  }
  if (spec.endsWith("*")) return command.startsWith(spec.slice(0, -1));
  return command === spec;
}

export type Decision = "allow" | "deny" | "parked";

export function decide(
  role: { permissions: Pick<Role["permissions"], "allow" | "deny"> },
  req: PermissionRequest,
): Decision {
  if (role.permissions.deny.some((r) => matchRule(r, req.toolName, req.input))) return "deny";
  if (role.permissions.allow.some((r) => matchRule(r, req.toolName, req.input))) return "allow";
  return "parked";
}
