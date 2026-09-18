import { spawn } from "node:child_process";

process.on("SIGINT", () => {});
const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
process.stdout.write(`${JSON.stringify({ grandchild: grandchild.pid })}\n`);
setInterval(() => {}, 1000);
