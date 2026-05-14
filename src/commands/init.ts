import { defineCommand } from "citty";
import { Store } from "../store.ts";
import { dbPath, ensureConfigDir } from "../paths.ts";
import { writeAllSkills, skillDir, listSkills } from "../skills.ts";
import { writeAllExtensions, extensionDir, listExtensions } from "../extensions.ts";

export default defineCommand({
  meta: { name: "init", description: "initialize the cortex database" },
  async run() {
    ensureConfigDir();
    const s = Store.open();
    s.close();
    // Self-install every shipped skill (cortex, cortex-planner,
    // cortex-implementer) so coding agents have authoritative recipes on
    // disk. Always overwrites — skills are machine-generated; hand-edits
    // are LOST.
    await writeAllSkills();
    for (const name of listSkills()) {
      console.log(`✓ skill written to ${skillDir(name)}`);
    }
    await writeAllExtensions();
    for (const name of listExtensions()) {
      console.log(`✓ extension written to ${extensionDir(name)}`);
    }
    console.log(`✓ initialized ${dbPath()}`);
  },
});
