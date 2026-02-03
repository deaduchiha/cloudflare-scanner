/** ANSI colors for CLI (disabled if not a TTY so pipes stay clean). */
const isTty = process.stdout.isTTY === true;
export const cli = {
  green: (s: string) => (isTty ? `\x1b[32m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTty ? `\x1b[36m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTty ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s: string) => (isTty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (isTty ? `\x1b[1m${s}\x1b[0m` : s),
};

const BAR_WIDTH = 24;

function progressBar(current: number, total: number): string {
  if (total <= 0) return "▌" + "░".repeat(BAR_WIDTH) + "▐";
  const p = Math.min(1, current / total);
  const filled = Math.round(BAR_WIDTH * p);
  return "▌" + "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled) + "▐";
}

export type OverallProgress = {
  grow: (n: number) => void;
  done: () => void;
};

export function createOverallProgress(
  label: string,
  total: number
): OverallProgress {
  let current = 0;
  const totalCount = Math.max(0, total);
  const pad = (s: string, len: number) =>
    s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);

  const write = (done = false) => {
    const pct = totalCount > 0 ? Math.round((100 * current) / totalCount) : 0;
    const bar = progressBar(current, totalCount);
    const cnt = `${current}/${totalCount}`;
    const suffix = done ? ` ${cli.green("done")}` : "";
    const phase = cli.cyan(label);
    const line = pad(`${phase} ${bar} ${pct}% ${cnt}${suffix}`, 80);
    process.stdout.write(`\r${line}`);
  };

  return {
    grow(n: number) {
      current += n;
      if (current > totalCount) current = totalCount;
      write();
    },
    done() {
      current = totalCount;
      write(true);
      process.stdout.write("\n");
    },
  };
}
