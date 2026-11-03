/**
 * Dates as the model writes them and as Windows date controls show them — one parser, so a picker
 * is written, recognised and read back by the same rules.
 */

/**
 * A date and/or time out of what the model wrote: `2026-03-09`, `2026/3/9`, a Chinese-format date, `14:30`,
 * a Chinese-format afternoon time, `2:30 PM`, or a date followed by a time. Components it does not name stay as they are.
 */
export function parseDateTime(text: string): Record<string, number> | null {
  const out: Record<string, number> = {};
  const d = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/.exec(text);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const probe = new Date(y, m - 1, day);
    if (probe.getMonth() !== m - 1 || probe.getDate() !== day) return null;
    Object.assign(out, { year: y, month: m, day });
  }
  const rest = d ? text.slice(d.index + d[0].length) : text;
  const t = /(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?/.exec(rest);
  if (t) {
    let hour = Number(t[1]);
    const pm = /下午|晚上|\bpm\b|p\.m\./i.test(rest), am = /上午|凌晨|早上|\bam\b|a\.m\./i.test(rest);
    if (pm && hour < 12) hour += 12;
    if (am && hour === 12) hour = 0;
    const [minute, second] = [Number(t[2]), t[3] === undefined ? undefined : Number(t[3])];
    if (hour > 23 || minute > 59 || (second ?? 0) > 59) return null;
    Object.assign(out, { hour, minute, ...(second === undefined ? {} : { second }) });
  }
  return Object.keys(out).length ? out : null;
}

/** Does `shown` hold the date/time `asked` names? Components `asked` leaves out are not compared:
 *  a WPF DatePicker answers "2026/8/20 0:00:00" for "2026/8/20". */
export function sameDate(shown: string, asked: string): boolean {
  const want = parseDateTime(asked), got = parseDateTime(shown);
  return !!want && !!got && Object.entries(want).every(([k, v]) => got[k] === v);
}
