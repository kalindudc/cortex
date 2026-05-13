# `cortex tag`

Tags decorate tasks across lanes — orthogonal to lane membership. CRUD mirrors `cortex lane`. Tags are auto-created on first reference (e.g. `cortex add -t plan,foo` creates both tags inline), so this subcommand is mainly for pre-creating a tag with a custom color, renaming, or removing tags wholesale.

## Subcommands

| Command | Description |
|---|---|
| `cortex tag add <name> [-c #hex]` | Create a tag with optional color. |
| `cortex tag ls [--json]` | List every tag with its current `task_count`. |
| `cortex tag edit <name> [-c #hex] [--rename <new>]` | Edit a tag's color or rename it (cascades to all tasks via FK). |
| `cortex tag rm <name> [-f]` | Remove a tag. Refuses if any task uses it; `-f` cascades the join rows (tasks themselves are never touched). |

## Tagging tasks

Tagging happens on the task, not the tag — three flag families:

```bash
# add new task with two tags (tags auto-created if missing)
cortex add "investigate flaky test" -t plan,debug

# replace a task's entire tag set
cortex edit 42 --set-tags plan,debug,p0

# add or remove a single tag without touching the rest
cortex edit 42 --add-tag urgent
cortex edit 42 --rm-tag debug

# AND filter: only tasks carrying EVERY listed tag (intersection)
cortex ls -t plan,debug --json
```

`cortex show <id> --json | jq .task.tags` returns the current set, alphabetically sorted.

## Pitfalls

- **Name regex `[a-z0-9_@-]{1,32}`** — lowercase letters, digits, `_`, `@`, `-`. Spaces, capitals, and slashes are rejected. `cortex add "x" -t "BAD NAME"` exits 1.
- **`--set-tags`, `--add-tag`, and `--rm-tag` are mutually exclusive per `cortex edit` invocation.** Combining any two exits 1; chain multiple invocations if you need to apply more than one mode.
- **`cortex tag rm <name>` refuses while any task uses the tag.** Pass `-f` / `--force` to cascade the join rows. The tasks themselves are never deleted.
- **Filter is AND, not OR.** `cortex ls -t a,b` returns tasks carrying *both* `a` AND `b`; OR is out of scope.
- **Renames cascade automatically.** `cortex tag edit foo --rename bar` propagates to `task_tags` via the `ON UPDATE CASCADE` FK; no manual update is needed.
