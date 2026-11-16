/**
 * Text cut to a length without leaving half a character, and the net under every cut.
 *
 * A JS string is UTF-16, and `slice` counts its units: a character outside the BMP (an emoji,
 * a rarer CJK ideograph) is two of them, and a cut that lands between the two leaves a lone
 * surrogate. `JSON.stringify` writes that as `\ud83d`, which a strict JSON parser refuses (Rust's
 * serde_json, and Python's once the string is encoded), so one control named with an emoji at the
 * wrong column loses its client the WHOLE tool result.
 */

/**
 * `s` cut to at most `max` UTF-16 units, one short when the cut would split a surrogate pair.
 * The pair is the unit kept whole; a sequence of several characters (a family emoji joined by
 * ZWJ, a letter and its combining mark) may still be cut between them, which is valid text.
 *
 * Page scripts cannot import this and spell the same cut as
 * `s.slice(0, max).replace(/[\uD800-\uDBFF]$/, '')`.
 */
export function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `s` with every lone surrogate replaced by U+FFFD (`String.prototype.toWellFormed`, spelled out
 * for the ES2023 lib). The net under {@link cutText}: a page's own text can hold half a character
 * too, cut by the page, and no cut of ours would know.
 */
export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE, "�");
}
