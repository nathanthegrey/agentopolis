import { initHome } from "./init.js";

const [command, ...args] = process.argv.slice(2);

if (command === "init" && args[0]) {
  const r = initHome(args[0]);
  console.log(
    `home created at ${args[0]} (config version ${r.snapshot.version.slice(0, 12)}), database at ${r.dbPath}`,
  );
} else {
  console.error("usage: agentopolis init <dir>");
  process.exit(2);
}
