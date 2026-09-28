import { test, expect, describe } from "bun:test";
import {
  displayWidth,
  escapeTerminalLines,
  escapeTerminalText,
  fitWidth,
  hyperlink,
  osc52Copy,
  safeUrl,
  type SafeUrl,
} from "../../../src/tui/safety.ts";

// Plan @400 N20/G5: ONE terminal rendering boundary for untrusted text.
// Hostile ESC/C0/C1/OSC52/OSC8/DCS/APC input must render as visible text,
// Unicode and grapheme widths survive, URLs are validated before any OSC 8,
// and clipboard writes are explicit and honestly unconfirmed.

const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;

const HOSTILE: Record<string, string> = {
  "CSI clear screen": "\x1b[2J\x1b[H",
  "SGR color": "\x1b[31mred\x1b[0m",
  "OSC 52 clipboard write": "\x1b]52;c;ZXZpbA==\x07",
  "OSC 52 clipboard read": "\x1b]52;c;?\x1b\\",
  "OSC 8 hyperlink": "\x1b]8;;https://evil.example\x1b\\click\x1b]8;;\x1b\\",
  "OSC title": "\x1b]0;pwned\x07",
  DCS: "\x1bP+q544e\x1b\\",
  "APC (Kitty graphics)": "\x1b_Gf=100,a=T;AAAA\x1b\\",
  "C1 CSI": "\x9b31mx",
  "C1 OSC + ST": "\x9d52;c;eA==\x9c",
  "C1 DCS/APC": "\x90q\x9c\x9f_\x9c",
  "carriage-return overwrite": "safe\rEVIL",
  "backspace overwrite": "abc\b\b\bxyz",
  "BEL NUL VT FF DEL": "\x07\x00\x0b\x0c\x7f",
  "bidi override": "abc\u202edcba\u202c",
  "bidi isolate": "\u2066x\u2069",
  "mode 2031 / bracketed paste toggles": "\x1b[?2031h\x1b[?2004l\x1b[<u",
};

describe("escapeTerminalText: controls become visible text", () => {
  for (const [label, hostile] of Object.entries(HOSTILE)) {
    test(label, () => {
      const out = escapeTerminalText(hostile);
      expect(out).not.toMatch(CONTROLS);
      expect(out).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
      // Every hostile character still shows up as something visible.
      expect(out.length).toBeGreaterThanOrEqual(hostile.length);
    });
  }

  test("caret notation for C0 and DEL, code points for C1 and bidi controls", () => {
    expect(escapeTerminalText("\x1b[2J")).toBe("^[[2J");
    expect(escapeTerminalText("a\x07b\x00c\x7f")).toBe("a^Gb^@c^?");
    expect(escapeTerminalText("\t\n\r")).toBe("^I^J^M");
    expect(escapeTerminalText("\x9b31m")).toBe("<U+009B>31m");
    expect(escapeTerminalText("x\u202ey")).toBe("x<U+202E>y");
  });

  test("printable Unicode is preserved exactly, including graphemes", () => {
    for (const s of [
      "plain ascii",
      "日本語",
      "café",
      "e\u0301",
      "👍🏽",
      "👨‍👩‍👧",
      "🇨🇦",
      "a\u200db",
      "ÅÄÖ – “quotes” …",
    ]) {
      expect(escapeTerminalText(s)).toBe(s);
    }
  });

  test("lone surrogates become U+FFFD", () => {
    expect(escapeTerminalText("a\ud800b")).toBe("a\ufffdb");
    expect(escapeTerminalText("\udfff")).toBe("\ufffd");
  });
});

describe("escapeTerminalLines: line endings and tabs for multi-line bodies", () => {
  test("CRLF, LF and lone CR end lines (CommonMark); tabs expand to tab stops", () => {
    expect(escapeTerminalLines("a\tb\r\nc\rd\ne")).toEqual(["a   b", "c", "d", "e"]);
    expect(escapeTerminalLines("\tx")).toEqual(["    x"]);
    // 日本 is 4 cells wide, so its tab runs to the next stop at column 8.
    expect(escapeTerminalLines("日本\tx", 4)).toEqual(["日本    x"]);
    expect(escapeTerminalLines("ab\tc", 8)).toEqual(["ab      c"]);
    expect(escapeTerminalLines("")).toEqual([""]);
  });

  test("hostile sequences inside a body stay visible on every line", () => {
    const lines = escapeTerminalLines(`title\n${Object.values(HOSTILE).join("\n")}\nend`);
    for (const line of lines) expect(line).not.toMatch(CONTROLS);
    expect(lines[0]).toBe("title");
    expect(lines.at(-1)).toBe("end");
  });
});

describe("displayWidth", () => {
  test("grapheme and East Asian width", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("日本")).toBe(4);
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("👍🏽")).toBe(2);
    expect(displayWidth(escapeTerminalText("\x1b[31m"))).toBe(6);
  });
});

describe("safeUrl: only validated URLs reach OSC 8 or an opener", () => {
  // SafeUrl is a branded string; compare it as a plain string.
  const href = (raw: string): string | null => safeUrl(raw);

  test("http, https and mailto are accepted and normalized to printable ASCII", () => {
    expect(href("https://example.com/a?b=c#d")).toBe("https://example.com/a?b=c#d");
    expect(href("http://example.com")).toBe("http://example.com/");
    expect(href("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    expect(href("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(href("https://bücher.example/ü")).toBe("https://xn--bcher-kva.example/%C3%BC");
    for (const url of ["https://example.com/a b", "https://bücher.example/ü"]) {
      expect(safeUrl(url)).toMatch(/^[\x21-\x7e]+$/);
    }
  });

  test("other schemes, relative URLs and credentials are refused", () => {
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>",
      "file:///etc/passwd",
      "vbscript:x",
      "ftp://example.com",
      "/relative/path",
      "//evil.example/x",
      "example.com",
      "https://user:pw@example.com",
      "https://user@example.com",
      "https://",
      "mailto:",
      "",
    ]) {
      expect(safeUrl(url), url).toBeNull();
    }
  });

  test("control, C1, bidi and zero-width characters are refused before parsing", () => {
    for (const url of [
      "java\nscript:alert(1)",
      "https://example.com/\x1b]8;;evil",
      "https://exam\tple.com",
      "https://example.com/\x07",
      "https://example.com/\x9b",
      "https://example.com/\u202e",
      "https://exa\u200bmple.com",
      " https://example.com",
    ]) {
      expect(safeUrl(url), JSON.stringify(url)).toBeNull();
    }
    expect(safeUrl(`https://example.com/${"a".repeat(3000)}`)).toBeNull();
  });
});

describe("hyperlink: OSC 8 around already-escaped content", () => {
  test("wraps escaped (optionally styled) content in one OSC 8 link", () => {
    const url = safeUrl("https://example.com/x");
    if (url === null) throw new Error("expected a safe URL");
    expect(hyperlink(url, "label")).toBe("\x1b]8;;https://example.com/x\x1b\\label\x1b]8;;\x1b\\");
    expect(hyperlink(url, "\x1b[4mlabel\x1b[0m")).toContain("\x1b[4mlabel\x1b[0m");
  });

  test("refuses unvalidated URLs and content holding anything but SGR", () => {
    expect(() => hyperlink("javascript:alert(1)" as SafeUrl, "x")).toThrow(/URL/);
    const url = safeUrl("https://example.com");
    if (url === null) throw new Error("expected a safe URL");
    for (const content of ["\x1b]8;;https://evil\x1b\\x", "a\x07", "\x1bP", "\x9d", "\x1b[2J"]) {
      expect(() => hyperlink(url, content), JSON.stringify(content)).toThrow(/escape/);
    }
  });
});

describe("osc52Copy: explicit clipboard writes, reported as unconfirmed", () => {
  test("writes one OSC 52 sequence with base64 UTF-8 and never claims success", () => {
    const writes: string[] = [];
    const result = osc52Copy("héllo\n👍", data => writes.push(data));
    const b64 = Buffer.from("héllo\n👍", "utf8").toString("base64");
    expect(writes).toEqual([`\x1b]52;c;${b64}\x1b\\`]);
    expect(result).toEqual({ status: "unconfirmed", bytes: Buffer.byteLength("héllo\n👍") });
  });

  test("hostile clipboard text cannot break out of the sequence", () => {
    const writes: string[] = [];
    osc52Copy("\x1b\\\x07\x1b]52;c;?\x07", data => writes.push(data));
    expect(writes).toHaveLength(1);
    expect(writes[0].slice(7, -2)).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  test("oversized text and write errors fail without claiming a copy", () => {
    const writes: string[] = [];
    expect(osc52Copy("x".repeat(200), data => writes.push(data), { maxBytes: 100 })).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/too large/),
    });
    expect(writes).toEqual([]);
    const thrown = osc52Copy("x", () => {
      throw new Error("EPIPE");
    });
    expect(thrown).toMatchObject({ status: "failed", reason: expect.stringMatching(/EPIPE/) });
  });
});

describe("fitWidth (escaped text cut to a cell budget)", () => {
  test("keeps text that fits; cuts longer text at a grapheme boundary ending in one ellipsis", () => {
    expect(fitWidth("hello", 5)).toBe("hello");
    expect(fitWidth("hello world", 6)).toBe("hello…");
    expect(displayWidth(fitWidth("日本語のテキスト", 7))).toBeLessThanOrEqual(7);
    expect(fitWidth("日本語のテキスト", 7).endsWith("…")).toBe(true);
    expect(fitWidth("ae\u0301👨‍👩‍👧z", 3)).toBe("ae\u0301…");
    expect(fitWidth("anything", 0)).toBe("");
  });
});
