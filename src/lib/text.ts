// Text helpers: HTML to plain text, CSV parsing, splitting comma-joined blanks.

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", times: "×", divide: "÷",
  le: "≤", ge: "≥", ne: "≠", deg: "°", plusmn: "±", micro: "µ", pi: "π",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Strip tags, keeping line structure from block elements and <br>. */
export function htmlToText(html: string): string {
  if (!html) return "";
  if (!/[<&]/.test(html)) return html.replace(/ /g, " ");
  const s = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|pre|blockquote)>/gi, "\n")
    .replace(/<(p|div|li|tr|h[1-6]|pre|blockquote)(\s[^>]*)?>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(s)
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function looksLikeHtml(s: string): boolean {
  return /<\/?(p|div|span|br|strong|em|code|ul|ol|li|table|sup|sub)\b/i.test(s);
}

/** Collapse all whitespace runs to single spaces and trim. */
export function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** RFC 4180 CSV parser (quoted fields, embedded newlines, doubled quotes). */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((r) => r.map((v) => {
      const s = v == null ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","))
    .join("\n");
}

/**
 * Split a comma-joined multi-part answer ("a,b(c,d),e") on top-level commas only:
 * commas inside (), [], {}, quotes or HTML tags don't split.
 */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let inTag = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inTag) { cur += c; if (c === ">") inTag = false; continue; }
    if (quote) { cur += c; if (c === quote && s[i - 1] !== "\\") quote = null; continue; }
    if (c === "<" && /[a-z/!]/i.test(s[i + 1] ?? "")) { inTag = true; cur += c; continue; }
    if (c === '"') { quote = c; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Split into exactly `n` parts. Tries top-level splitting first, then a plain comma split.
 * Returns null when neither gives n parts.
 */
export function splitInto(s: string, n: number): string[] | null {
  if (n <= 1) return [s];
  const top = splitTopLevel(s);
  if (top.length === n) return top;
  const plain = s.split(",");
  if (plain.length === n) return plain;
  return null;
}

/** Number in a string, ignoring surrounding text: "x = 2.90 m" -> 2.9 */
export function firstNumber(s: string): number | null {
  const m = s.replace(/(\d),(\d{3})\b/g, "$1$2").match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i);
  return m ? Number(m[0]) : null;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
