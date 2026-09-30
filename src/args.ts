/**
 * Argv pre-normalization for citty 0.1.x.
 *
 * citty 0.1.x vendors an mri-style parser whose value rule is: a token
 * starting with "-" is NEVER consumed as the value of the preceding flag
 * (`val = ... || ("" + args[i + 1]).charCodeAt(0) === 45 || args[++i]`).
 * A string flag followed by a dash-leading value therefore parses as a
 * boolean `true`, and the value token is re-parsed as flags. For
 * `cortex edit --body-search "- item" --body-replace "- ITEM"` this yields
 * bodySearch/bodyReplace === true ("anchor not found"), and for a value
 * like "-beta line" the leading `-b` hijacks the body alias, manufacturing
 * an `args.body` that trips the "cannot be combined with -b" mutex error
 * even though no -b was passed. Dash-leading values are routine here
 * (Markdown list items, "---" separators, negative-ish text), so agents
 * hit this on nearly every anchor-based edit.
 *
 * Fix strategy: before runMain() dispatch, rewrite `--flag -value` into
 * the `--flag=-value` form for the KNOWN string-valued flags of the
 * detected subcommand. The `=`-attached form reaches mri as a plain value
 * (mri splits on the first `=`, everything after is literal, including
 * further dashes). citty 0.2.2 is not a drop-in fix: it strips `--no-*`
 * tokens even as a string flag's value, keeps the `=` of `-b=value` and
 * colours usage on a pipe, so cortex stays on 0.1.x with this shim.
 *
 * Scope guard: only tokens that EXACTLY equal a known flag name (long
 * camelCase, long kebab-case, or a single-char alias) are rewritten.
 * Attached-value forms (`--flag=v`, `-fv`), boolean flags, unknown flags,
 * and everything after a standalone `--` are left untouched.
 */

type ArgDef = {
  type?: string;
  alias?: string | string[];
};

type CommandDef = {
  args?: Record<string, ArgDef>;
};

export type SubcommandRegistry = Record<string, () => Promise<unknown>>;

/**
 * Collect the exact argv spellings that resolve to string-valued flags.
 * citty's parsedArgsProxy falls back through both casings
 * (`target[prop] ?? target[camelCase(prop)] ?? target[kebabCase(prop)]`),
 * so users may spell multi-word flags either way; aliases resolve via
 * mri's alibi expansion.
 */
function stringValueFlags(args: Record<string, ArgDef>): Set<string> {
  const flags = new Set<string>();
  for (const [name, def] of Object.entries(args)) {
    if (!def || def.type !== "string") continue;
    flags.add(`--${name}`);
    const kebab = name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
    if (kebab !== name) flags.add(`--${kebab}`);
    for (const alias of Array.isArray(def.alias) ? def.alias : def.alias ? [def.alias] : []) {
      flags.add(`-${alias}`);
    }
  }
  return flags;
}

/**
 * Rewrite dash-leading values of known string flags into `=`-attached
 * form. `subCommands` is the same lazy-import registry cli.ts feeds to
 * citty; only the detected subcommand's module is imported (the same one
 * citty would load anyway), so startup cost is unchanged.
 */
export async function normalizeArgv(argv: string[], subCommands: SubcommandRegistry): Promise<string[]> {
  // Mirror citty's own subcommand detection (runCommand): the first token
  // that does not start with "-" is the subcommand name.
  const name = argv.find(arg => !arg.startsWith("-"));
  if (!name || !(name in subCommands)) return argv;
  const def = (await subCommands[name]()) as CommandDef;
  const flags = stringValueFlags(def.args ?? {});
  if (flags.size === 0) return argv;
  const out: string[] = [];
  let positionalOnly = false; // set once a standalone "--" is seen
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) break;
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      out.push(token);
      i++;
      continue;
    }
    const next = positionalOnly ? undefined : argv[i + 1];
    if (!flags.has(token) || next === undefined || !next.startsWith("-")) {
      out.push(token);
      i++;
      continue;
    }
    // Attach the dash-leading value: `--flag -value` -> `--flag=-value`.
    // Also fixes `--body-file -` (stdin), which mri otherwise eats as a
    // flag, leaving bodyFile as boolean true.
    out.push(`${token}=${next}`);
    i += 2;
  }
  return out;
}
