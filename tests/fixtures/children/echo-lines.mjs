const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const n of [1, 2, 3]) {
  process.stdout.write(`${JSON.stringify({ n })}\n`);
  await sleep(50);
}
