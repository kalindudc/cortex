import { defineCommand } from "citty";
import { Store } from "../store.ts";
import { dbPath, ensureConfigDir } from "../paths.ts";
import { writeAllSkills, skillDir, listSkills } from "../skills.ts";

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
    console.log(`✓ initialized ${dbPath()}`);
  },
});
