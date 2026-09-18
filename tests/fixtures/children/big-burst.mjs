// 10,000 lines of ~100 bytes (~1 MB) written in one burst, then a natural exit.
// The parent must see every byte before `close`, whatever `exit` does.
const line = `${JSON.stringify({ pad: "x".repeat(100) })}\n`;
const count = Number(process.env.BURST_LINES ?? "10000");
process.stdout.write(line.repeat(count));
