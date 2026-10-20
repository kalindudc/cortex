import { describe, expect, test } from "bun:test";
import {
  GUARD_BUTTONS,
  guardDialog,
  MAX_EXPORT_BYTES,
  parseDraftExport,
  parseDraftReport,
  parseGuardAnswer,
  parseSaveAllAnswer,
  runGuard,
} from "../../../src/desktop/draftGuard.ts";
import type { DraftReport } from "../../../src/desktop/ipc.ts";

describe("parseDraftReport", () => {
  test("accepts non-negative integer counts and drops anything else", () => {
    expect(parseDraftReport({ dirty: 2, orphaned: 0, extra: "x" })).toEqual({ dirty: 2, orphaned: 0 });
  });

  test("rejects an array", () => {
    expect(() => parseDraftReport([1, 0])).toThrow("invalid draft report");
  });

  test.each([
    null,
    "1",
    { dirty: 1 },
    { dirty: -1, orphaned: 0 },
    { dirty: 1.5, orphaned: 0 },
    { dirty: "1", orphaned: 0 },
    { dirty: Number.MAX_SAFE_INTEGER + 1, orphaned: 0 },
    { dirty: 0, orphaned: Number.NaN },
  ])("rejects %p", value => {
    expect(() => parseDraftReport(value)).toThrow("invalid draft report");
  });
});

describe("parseSaveAllAnswer", () => {
  test("accepts an id with a report", () => {
    expect(parseSaveAllAnswer({ id: 3, report: { dirty: 0, orphaned: 1 } })).toEqual({
      id: 3,
      report: { dirty: 0, orphaned: 1 },
    });
  });

  test("rejects a missing id or a bad report", () => {
    expect(() => parseSaveAllAnswer({ report: { dirty: 0, orphaned: 0 } })).toThrow("invalid save-all answer");
    expect(() => parseSaveAllAnswer({ id: 1, report: { dirty: -1, orphaned: 0 } })).toThrow("invalid draft report");
  });
});

describe("parseGuardAnswer", () => {
  test("accepts an id and rejects anything else", () => {
    expect(parseGuardAnswer({ id: 4, extra: true })).toEqual({ id: 4 });
    for (const bad of [null, {}, { id: -1 }, { id: "4" }, [4]]) {
      expect(() => parseGuardAnswer(bad)).toThrow("invalid guard answer");
    }
  });
});

describe("parseDraftExport", () => {
  test("builds the file name from the id and field", () => {
    expect(parseDraftExport({ taskId: 12, field: "body", text: "# hi" })).toEqual({
      taskId: 12,
      field: "body",
      text: "# hi",
      fileName: "cortex-task-12-body-draft.md",
    });
  });

  test("a path-looking field or id never reaches the file name", () => {
    for (const field of ["../../etc/passwd", "body/../../x", "title\0"]) {
      expect(() => parseDraftExport({ taskId: 1, field, text: "x" })).toThrow("field must be title or body");
    }
    expect(() => parseDraftExport({ taskId: "1/../x", field: "body", text: "x" })).toThrow("taskId");
    const parsed = parseDraftExport({ taskId: 1, field: "title", text: "x", fileName: "/tmp/evil.md" });
    expect(parsed.fileName).toBe("cortex-task-1-title-draft.md");
  });

  test.each([
    null,
    { field: "body", text: "x" },
    { taskId: 0, field: "body", text: "x" },
    { taskId: -3, field: "body", text: "x" },
    { taskId: 1.5, field: "body", text: "x" },
    { taskId: 1, field: "body" },
    { taskId: 1, field: "body", text: 7 },
  ])("rejects %p", value => {
    expect(() => parseDraftExport(value)).toThrow("invalid draft export");
  });

  test("rejects text over 16 MiB, counted in UTF-8 bytes", () => {
    const multiByte = "é".repeat(MAX_EXPORT_BYTES / 2 + 1);
    expect(() => parseDraftExport({ taskId: 1, field: "body", text: multiByte })).toThrow("16 MiB");
    expect(parseDraftExport({ taskId: 1, field: "body", text: "a".repeat(MAX_EXPORT_BYTES) }).text.length).toBe(
      MAX_EXPORT_BYTES,
    );
  });
});

describe("guardDialog", () => {
  test("offers Save all, Discard and Cancel", () => {
    const d = guardDialog({ dirty: 1, orphaned: 0 });
    expect(d.buttons).toEqual(GUARD_BUTTONS);
    expect([...d.buttons]).toEqual(["Save all", "Discard", "Cancel"]);
    expect(d.detail).toBe("1 task has unsaved changes.");
  });

  test("says that text of deleted tasks cannot be saved", () => {
    const d = guardDialog({ dirty: 2, orphaned: 1 });
    expect(d.detail).toContain("2 tasks have unsaved changes.");
    expect(d.detail).toContain("deleted task and cannot be saved");
    expect(guardDialog({ dirty: 0, orphaned: 2 }).detail).not.toContain("unsaved changes");
  });
});

describe("runGuard", () => {
  const dirty: DraftReport = { dirty: 1, orphaned: 0 };
  const clean: DraftReport = { dirty: 0, orphaned: 0 };
  const answer = (index: number) => async () => index;
  const never = (): Promise<DraftReport> => new Promise(() => {});

  test("leaves at once with nothing unsaved, without asking", async () => {
    let asked = 0;
    const ask = async () => {
      asked++;
      return 2;
    };
    expect(await runGuard({ report: clean, ask, saveAll: never, timeoutMs: 10 })).toBe("leave");
    expect(asked).toBe(0);
  });

  test("asks when only text of deleted tasks is left", async () => {
    let asked = 0;
    const ask = async () => {
      asked++;
      return 2;
    };
    expect(await runGuard({ report: { dirty: 0, orphaned: 1 }, ask, saveAll: never, timeoutMs: 10 })).toBe("stay");
    expect(asked).toBe(1);
  });

  test("Cancel stays and Discard leaves, without saving", async () => {
    let saves = 0;
    const saveAll = async () => {
      saves++;
      return clean;
    };
    expect(await runGuard({ report: dirty, ask: answer(2), saveAll, timeoutMs: 10 })).toBe("stay");
    expect(await runGuard({ report: dirty, ask: answer(-1), saveAll, timeoutMs: 10 })).toBe("stay");
    expect(await runGuard({ report: dirty, ask: answer(1), saveAll, timeoutMs: 10 })).toBe("leave");
    expect(saves).toBe(0);
  });

  test("Save all leaves only once nothing unsaved is left", async () => {
    expect(await runGuard({ report: dirty, ask: answer(0), saveAll: async () => clean, timeoutMs: 1000 })).toBe(
      "leave",
    );
    expect(
      await runGuard({
        report: dirty,
        ask: answer(0),
        saveAll: async () => ({ dirty: 0, orphaned: 1 }),
        timeoutMs: 1000,
      }),
    ).toBe("leave");
  });

  test("Save all stays when one draft is left, when it fails, or when it times out", async () => {
    const left = async (): Promise<DraftReport> => ({ dirty: 1, orphaned: 0 });
    const fails = async (): Promise<DraftReport> => {
      throw new Error("offline");
    };
    expect(await runGuard({ report: { dirty: 2, orphaned: 0 }, ask: answer(0), saveAll: left, timeoutMs: 1000 })).toBe(
      "stay",
    );
    expect(await runGuard({ report: dirty, ask: answer(0), saveAll: fails, timeoutMs: 1000 })).toBe("stay");
    const started = Date.now();
    expect(await runGuard({ report: dirty, ask: answer(0), saveAll: never, timeoutMs: 20 })).toBe("stay");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
