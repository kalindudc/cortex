import { defineCommand } from "citty";
import { Store, validateTagName, type Tag } from "../store.ts";
import { Client, daemonUrl } from "../client.ts";

/**
 * `cortex tag` mirrors `cortex lane`: a flat add | ls | edit | rm subcommand
 * surface, dual-path daemon-or-Store routing, and a single chokepoint
 * (validateTagName) for input validation. Tags are auto-created on first
 * reference via `cortex add -t a,b` / `cortex edit --add-tag x`; this
 * subcommand exists primarily so the user can pre-create a tag with a
 * custom color and rename/remove tags without touching tasks.
 */

const add = defineCommand({
  meta: { name: "add", description: "create a tag" },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "tag name (must match [a-z0-9_@-]{1,32})",
    },
    color: {
      type: "string",
      alias: "c",
      valueHint: "#hex",
      description: "display color hex (e.g. #fe8019); used by the dashboard",
    },
  },
  async run({ args }) {
    let name: string;
    try {
      name = validateTagName(args.name);
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }
    const payload = { name, color: args.color || null };
    const url = daemonUrl();
    if (url) {
      try {
        const tag = (await Client.addTag(url, payload)) as Tag;
        console.log(`✓ tag ${tag.name} created`);
        return;
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    const store = Store.open();
    try {
      const tag = store.addTag(payload);
      console.log(`✓ tag ${tag.name} created`);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      store.close();
    }
  },
});

const ls = defineCommand({
  meta: { name: "ls", description: "list tags with task counts" },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "emit raw JSON instead of a table",
    },
  },
  async run({ args }) {
    const url = daemonUrl();
    let tags: (Tag & { task_count: number })[];
    if (url) {
      try {
        tags = (await Client.listTags(url)) as (Tag & { task_count: number })[];
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      const store = Store.open();
      try {
        tags = store.listTags();
      } finally {
        store.close();
      }
    }
    if (args.json) {
      console.log(JSON.stringify(tags));
      return;
    }
    if (tags.length === 0) {
      console.log("(no tags)");
      return;
    }
    console.table(
      tags.map((t) => ({
        name: t.name,
        color: t.color ?? "",
        tasks: t.task_count,
      })),
    );
  },
});

const edit = defineCommand({
  meta: { name: "edit", description: "edit a tag (color, rename)" },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "current tag name",
    },
    color: {
      type: "string",
      alias: "c",
      valueHint: "#hex",
      description: "new display color",
    },
    rename: {
      type: "string",
      valueHint: "new-name",
      description: "rename the tag (cascades to all tasks via FK)",
    },
  },
  async run({ args }) {
    const fields: { color?: string | null; rename?: string } = {};
    if (args.color) fields.color = args.color;
    if (args.rename) {
      try {
        fields.rename = validateTagName(args.rename);
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
      }
    }
    if (Object.keys(fields).length === 0) {
      console.error("error: provide at least one of --color, --rename");
      process.exit(1);
    }
    const url = daemonUrl();
    if (url) {
      try {
        const tag = (await Client.editTag(url, args.name, fields)) as Tag;
        console.log(`✓ tag ${tag.name} updated`);
        return;
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    const store = Store.open();
    try {
      const tag = store.editTag(args.name, fields);
      console.log(`✓ tag ${tag.name} updated`);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      store.close();
    }
  },
});

const rm = defineCommand({
  meta: {
    name: "rm",
    description: "remove a tag (refuses if any task uses it; use -f to override)",
  },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "tag name",
    },
    force: {
      type: "boolean",
      alias: "f",
      default: false,
      description: "drop the tag even if tasks reference it (cascades join rows)",
    },
  },
  async run({ args }) {
    const url = daemonUrl();
    if (url) {
      try {
        await Client.removeTag(url, args.name, args.force);
        console.log(`✓ tag ${args.name} removed`);
        return;
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    const store = Store.open();
    try {
      store.removeTag(args.name, { force: args.force });
      console.log(`✓ tag ${args.name} removed`);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      store.close();
    }
  },
});

export default defineCommand({
  meta: { name: "tag", description: "manage tags" },
  subCommands: { add, ls, edit, rm },
});
