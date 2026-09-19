import { startDaemon } from "../daemon.js";
import { initHome } from "./init.js";

const [command, ...args] = process.argv.slice(2);

const usage = () => {
  console.error("usage: agentopolis init <dir> | agentopolis start <home> [--fake] [--port N]");
  process.exit(2);
};

if (command === "init" && args[0]) {
  const r = initHome(args[0]);
  console.log(
    `home created at ${args[0]} (config version ${r.snapshot.version.slice(0, 12)}), database at ${r.dbPath}`,
  );
} else if (command === "start" && args[0]) {
  const home = args[0];
  const portAt = args.indexOf("--port");
  const daemon = await startDaemon({
    home,
    fake: args.includes("--fake"),
    fakeCli: process.env.AGENTOPOLIS_FAKE_CLI === "1",
    ...(portAt >= 0 && args[portAt + 1] ? { healthPort: Number(args[portAt + 1]) } : {}),
    log: (line, fields) =>
      console.log(JSON.stringify({ at: new Date().toISOString(), line, ...fields })),
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
} else {
  usage();
}
