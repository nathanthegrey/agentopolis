import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { AgentFile, ConfigFile, ProjectFile, RoleFile } from "./schemas.js";
import { findSecrets } from "./secret-detection.js";

export type LoadError = { file: string; message: string };
export type Role = RoleFile & { soul: string; job: string; protocol: string };
export type Snapshot = Readonly<{
  dir: string;
  config: ConfigFile;
  style: string;
  roles: ReadonlyMap<string, Role>;
  agents: ReadonlyMap<string, AgentFile>;
  projects: ReadonlyMap<string, ProjectFile>;
  version: string;
}>;
export type LoadResult = { ok: true; snapshot: Snapshot } | { ok: false; errors: LoadError[] };

const ROLE_PROSE = ["SOUL.md", "JOB.md", "PROTOCOL.md"] as const;

export function loadHome(dir: string): LoadResult {
  const errors: LoadError[] = [];
  const hash = createHash("sha256");

  const readText = (file: string): string | undefined => {
    if (!existsSync(file)) {
      errors.push({ file, message: "missing" });
      return undefined;
    }
    const bytes = readFileSync(file);
    hash.update(relative(dir, file)).update(bytes);
    return bytes.toString("utf8");
  };

  const readYaml = <S extends z.ZodType>(file: string, schema: S): z.output<S> | undefined => {
    const text = readText(file);
    if (text === undefined) return undefined;
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch (e) {
      errors.push({ file, message: `yaml: ${(e as Error).message}` });
      return undefined;
    }
    const secrets = findSecrets(doc);
    if (secrets.length > 0) {
      errors.push({
        file,
        message: `secret-looking value at ${secrets.join(", ")}; secrets live in the environment`,
      });
      return undefined;
    }
    const parsed = schema.safeParse(doc);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({ file, message: `${issue.path.join(".") || "(root)"}: ${issue.message}` });
      }
      return undefined;
    }
    return parsed.data;
  };

  const subdirs = (parent: string): string[] =>
    existsSync(parent)
      ? readdirSync(parent)
          .filter((n) => !n.startsWith(".") && statSync(join(parent, n)).isDirectory())
          .sort()
      : [];

  const config = readYaml(join(dir, "config.yaml"), ConfigFile);
  const style = readText(join(dir, "STYLE.md")) ?? "";

  const roles = new Map<string, Role>();
  for (const name of subdirs(join(dir, "roles"))) {
    const base = join(dir, "roles", name);
    const role = readYaml(join(base, "role.yaml"), RoleFile);
    const [soul, job, protocol] = ROLE_PROSE.map((f) => readText(join(base, f)));
    if (role && soul !== undefined && job !== undefined && protocol !== undefined) {
      if (role.name !== name) {
        errors.push({
          file: join(base, "role.yaml"),
          message: `name "${role.name}" must equal folder "${name}"`,
        });
      }
      roles.set(name, { ...role, soul, job, protocol });
    }
  }

  const agents = new Map<string, AgentFile>();
  for (const name of subdirs(join(dir, "agents"))) {
    const file = join(dir, "agents", name, "agent.yaml");
    const agent = readYaml(file, AgentFile);
    if (!agent) continue;
    if (agent.name !== name) {
      errors.push({ file, message: `name "${agent.name}" must equal folder "${name}"` });
    }
    agents.set(name, agent);
  }

  const projects = new Map<string, ProjectFile>();
  for (const name of subdirs(join(dir, "projects"))) {
    const file = join(dir, "projects", name, "project.yaml");
    const project = readYaml(file, ProjectFile);
    if (!project) continue;
    if (project.slug !== name) {
      errors.push({ file, message: `slug "${project.slug}" must equal folder "${name}"` });
    }
    projects.set(name, project);
  }

  // cross references
  for (const [name, agent] of agents) {
    const file = join(dir, "agents", name, "agent.yaml");
    if (!roles.has(agent.role)) {
      errors.push({ file, message: `role "${agent.role}" does not exist` });
    }
    if (agent.reports_to !== "owner" && !agents.has(agent.reports_to)) {
      errors.push({ file, message: `reports_to "${agent.reports_to}" does not exist` });
    }
    if (agent.project !== undefined && !projects.has(agent.project)) {
      errors.push({ file, message: `project "${agent.project}" does not exist` });
    }
  }

  if (errors.length > 0 || !config) return { ok: false, errors };
  const snapshot: Snapshot = Object.freeze({
    dir,
    config,
    style,
    roles,
    agents,
    projects,
    version: hash.digest("hex"),
  });
  return { ok: true, snapshot };
}
