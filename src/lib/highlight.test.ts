import { describe, expect, it } from "vitest";
import { highlightYaml } from "./highlight";

const kinds = (line: string) => highlightYaml(line)[0].filter((t) => t.text.trim()).map((t) => `${t.kind}:${t.text.trim()}`);

describe("highlightYaml", () => {
  it("returns every character, in order", () => {
    const text = "# top\nversion: 1\nnotes: |\n  a: b # c\n\nquestions:\n  \"93599\":\n    blanks: ['^1$', [x, y]]\n    rules:\n      - match: 'it''s'\n        points: -2.5 # half\n  - \n\t odd 'unclosed\n";
    expect(highlightYaml(text).map((l) => l.map((t) => t.text).join("")).join("\n")).toBe(text);
  });
  it("tells keys, strings, numbers and comments apart", () => {
    expect(kinds(`  Q35:   # the speed one`)).toEqual(["key:Q35", "punct::", "comment:# the speed one"]);
    expect(kinds(`    blanks: ['^1$', "a#b"]`)).toEqual(["key:blanks", "punct::", "punct:[", "str:'^1$'", "punct:,", `str:"a#b"`, "punct:]"]);
    expect(kinds(`  - points: 2.5`)).toEqual(["punct:-", "key:points", "punct::", "num:2.5"]);
    expect(kinds(`  "93599":`)).toEqual([`key:"93599"`, "punct::"]);
    expect(kinds(`case_sensitive: false`)).toEqual(["key:case_sensitive", "punct::", "kw:false"]);
    expect(kinds(`- rules: [{ number: 3 }]`)).toEqual(["punct:-", "key:rules", "punct::", "punct:[", "punct:{", "key:number", "punct::", "num:3", "punct:}", "punct:]"]);
    expect(kinds(`answer: a#b`)).toEqual(["key:answer", "punct::", "plain:a#b"]);
  });
  it("treats the lines of a | block as text", () => {
    const lines = highlightYaml("notes: |\n  Q9: accepts # anything\n\n  more\ntitle: x");
    expect(lines[1]).toEqual([{ text: "  Q9: accepts # anything", kind: "str" }]);
    expect(lines[3][0].kind).toBe("str");
    expect(lines[4][0]).toEqual({ text: "title", kind: "key" });
  });
});
