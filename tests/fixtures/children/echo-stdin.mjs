import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
for await (const line of rl) {
  process.stdout.write(`${JSON.stringify({ echo: JSON.parse(line) })}\n`);
}
process.stderr.write("stdin ended\n");
