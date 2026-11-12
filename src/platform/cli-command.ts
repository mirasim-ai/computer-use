/**
 * The command a user types to reach THIS install's CLI, for messages that tell them to run one.
 * Installed globally it is `mirasim-cu`; run through `npx` (the README's `claude mcp add … npx -y
 * @mirasim/computer-use mcp`) nothing named `mirasim-cu` is on their PATH, so the message has to
 * say `npx` too or it hands them a command that is not found.
 */

/** `mirasim-cu approvals add <app>`, spelled the way this process was started. */
export function approvalsAddCommand(app: string, argv1: string = process.argv[1] ?? ""): string {
  const viaNpx = /[\\/]_npx[\\/]/.test(argv1);
  // A name with a space in it (an app asked about by its Start-menu name) is one argument.
  return `${viaNpx ? "npx -y @mirasim/computer-use" : "mirasim-cu"} approvals add ${/\s/.test(app) ? `"${app}"` : app}`;
}
