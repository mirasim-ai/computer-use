/**
 * Every subcommand's usage contract: asked for help → stdout, exit 0; used it wrong → stderr,
 * exit 2 (stdout stays clean for scripts).
 *
 * Only the FIRST token counts as a help request: in `bridge --port --help` it is a flag's value.
 */

export function wantsHelp(rest: string[]): boolean {
  const first = rest[0];
  return first === "help" || first === "--help" || first === "-h";
}

export function emitUsage(text: string, asked: boolean): never {
  if (asked) {
    console.log(text);
    process.exit(0);
  }
  console.error(text);
  process.exit(2);
}
