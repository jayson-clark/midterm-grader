// A small YAML tokenizer for the rubric editor. It only colors text: every character of the
// input comes back out, in order, so the colored copy lines up with the textarea on top of it.

export type TokenKind = "key" | "str" | "num" | "kw" | "comment" | "punct" | "plain";
export interface Token { text: string; kind: TokenKind }

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s'"#[\]{},][^:#]*?)(\s*:)(?=\s|$)/;
const VALUE = /(\s+)|(#.*)|("(?:[^"\\]|\\.)*"?|'(?:[^']|'')*'?)|([[\]{},])|([^\s'"[\]{},]+)/y;

function plainKind(word: string): TokenKind {
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(word)) return "num";
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(word)) return "kw";
  return "plain";
}

/** Tokens for each line of `text`. */
export function highlightYaml(text: string): Token[][] {
  /** inside a `|` or `>` block: lines indented deeper than this are its text */
  let block: number | null = null;
  return text.split("\n").map((line) => {
    const out: Token[] = [];
    const push = (t: string, kind: TokenKind) => { if (t) out.push({ text: t, kind }); };
    const indent = /^\s*/.exec(line)![0];
    if (block != null) {
      if (line.trim() === "" || indent.length > block) { push(line, "str"); return out; }
      block = null;
    }
    push(indent, "plain");
    let rest = line.slice(indent.length);
    const dashes = /^(?:-\s+|-$)+/.exec(rest);
    if (dashes) { push(dashes[0], "punct"); rest = rest.slice(dashes[0].length); }
    const key = rest.startsWith("#") ? null : KEY.exec(rest);
    if (key) {
      push(key[1], "key");
      push(key[2], "punct");
      rest = rest.slice(key[0].length);
    }
    VALUE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let first = true;
    let prevSpace = true;
    while (VALUE.lastIndex < rest.length && (m = VALUE.exec(rest))) {
      if (m[1]) { push(m[1], "plain"); prevSpace = true; continue; }
      if (m[2] && prevSpace) { push(m[2], "comment"); break; }
      if (m[2]) {
        // a # glued to the text before it is not a comment: take it as part of a plain word
        const word = /^[^\s'"[\]{},]+/.exec(m[2])![0];
        VALUE.lastIndex -= m[2].length - word.length;
        push(word, "plain");
      } else if (m[3]) push(m[3], "str");
      else if (m[4]) push(m[4], "punct");
      else if (m[5]) {
        if (first && /^[|>][-+\d]*$/.test(m[5])) { push(m[5], "punct"); block = indent.length; }
        else if (m[5].length > 1 && m[5].endsWith(":") && /^(\s|$)/.test(rest.slice(VALUE.lastIndex))) {
          // a key inside { ... }
          push(m[5].slice(0, -1), "key"); push(":", "punct");
        } else push(m[5], plainKind(m[5]));
      }
      first = false;
      prevSpace = false;
    }
    return out;
  });
}
