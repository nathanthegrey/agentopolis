/** Slack limits, in one place; every builder goes through this module. */
export const LIMITS = {
  sectionText: 3000,
  blocksPerMessage: 50,
  blocksPerView: 100,
  buttonText: 75,
  buttonValue: 2000,
  modalTitle: 24,
  privateMetadata: 3000,
  textPerMessage: 40_000,
  msgPerSecondPerChannel: 1,
} as const;

const FENCE = "```";
const CLOSE = "\n```"; // appended to a part that ends inside a code block
const OPEN = "```\n"; // prepended to the following part

const fenceCount = (s: string): number => s.split(FENCE).length - 1;

/** Never cut inside a run of backticks: that would turn a fence into stray backticks. */
function outsideBacktickRun(text: string, cut: number): number {
  let c = cut;
  while (c > 0 && text[c - 1] === "`" && text[c] === "`") c -= 1;
  return c;
}

/** Best cut in [1, limit]: after a paragraph break, else after a line break, else hard. */
function cutPoint(text: string, limit: number): number {
  const para = text.lastIndexOf("\n\n", limit - 2);
  if (para > 0) return para + 2;
  const line = text.lastIndexOf("\n", limit - 1);
  if (line > 0) return line + 1;
  const hard = outsideBacktickRun(text, limit);
  return hard > 0 ? hard : limit;
}

/**
 * Splits text into parts of at most `max` characters, preferring paragraph then line
 * boundaries. A fenced code block that would be cut is closed at the end of the part and
 * reopened at the start of the next, so every part renders on its own.
 */
export function splitText(text: string, max: number = LIMITS.sectionText): string[] {
  if (max < 8) throw new Error(`splitText: max ${max} is too small`);
  const parts: string[] = [];
  let work = text;
  while (work.length > max) {
    let cut = cutPoint(work, max);
    let inFence = fenceCount(work.slice(0, cut)) % 2 === 1;
    if (inFence) {
      // leave room for the closing marker; the reopened remainder grows by OPEN.length,
      // so the cut must make net progress or fence handling is skipped for this part
      const fenced = cutPoint(work, max - CLOSE.length);
      if (fenced > OPEN.length) {
        cut = fenced;
        inFence = fenceCount(work.slice(0, cut)) % 2 === 1;
      } else {
        inFence = false;
      }
    }
    if (inFence) {
      parts.push(work.slice(0, cut) + CLOSE);
      work = OPEN + work.slice(cut);
    } else {
      parts.push(work.slice(0, cut));
      work = work.slice(cut);
    }
  }
  parts.push(work);
  return parts;
}

export function assertBlocks(blocks: unknown[], max: number): void {
  if (blocks.length > max) {
    throw new Error(`${blocks.length} blocks exceed the Slack cap of ${max}`);
  }
}

export function truncateButton(text: string): string {
  const max = LIMITS.buttonText;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
