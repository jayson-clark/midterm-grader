// New Quizzes "Student Analysis" report (CSV) -> QuizData.
//
// Layout: Name, ID, SectionIDs, SectionNames, Submitted, ElapsedTime, Attempt, then five
// columns per question (ItemID, ItemType, <question text: the student's answer>,
// EarnedPoints, Status), then NumberOfCorrect, NumberOfIncorrect, NoResponse,
// PointsPossible, OverallScore.

import type { Kind, Question, QuizData, Response, Student } from "../types";
import { htmlToText, parseCsv, splitInto, splitTopLevel } from "../text";

const KIND: Record<string, Kind> = {
  essay: "essay",
  choice: "choice",
  "true-false": "true_false",
  "multi-answer": "multi_answer",
  "rich-fill-blank": "fill_blank",
  "fill-blank": "fill_blank",
  ordering: "ordering",
  matching: "matching",
  numeric: "numeric",
  formula: "formula",
  categorization: "categorization",
  "hot-spot": "hot_spot",
  "file-upload": "file_upload",
  stimulus: "text_only",
};

export class CsvFormatError extends Error {}

function num(s: string | undefined): number | null {
  if (s == null || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Blank markers in the prompt: `blank1` or `the expected answer`. */
function blankMarkers(prompt: string): string[] {
  return [...prompt.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 1, bestN = -1;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

/**
 * Ordering answers look like "<div …>chunk 1</div>","<div …>chunk 2</div>": each item in
 * double quotes, joined by commas, with the quotes inside the HTML left unescaped. Split only
 * where one item's markup ends and the next begins (>","<), so code containing "," survives.
 */
export function splitQuotedItems(raw: string): string[] {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    const html = /^\s*</.test(inner);
    return inner.split(html ? /(?<=>)\s*","\s*(?=<)/ : /","/);
  }
  return splitTopLevel(s);
}

function parseResponse(q: Question, raw: string, earned: number | null): Response {
  const base: Response = { questionId: q.id, text: "", raw, canvasPoints: earned, answered: raw.trim() !== "" };
  if (!base.answered) return base;
  switch (q.kind) {
    case "fill_blank":
    case "dropdown": {
      const n = q.blankIds.length || 1;
      const parts = splitInto(raw, n);
      if (parts) {
        const clean = parts.map((p) => htmlToText(p).trim());
        return { ...base, parts: clean, text: clean.join("\n") };
      }
      const fallback = splitTopLevel(raw).map((p) => htmlToText(p).trim());
      return { ...base, parts: fallback, partsMismatch: true, text: fallback.join("\n") };
    }
    case "multi_answer": {
      const parts = splitTopLevel(raw).map((p) => htmlToText(p).trim()).filter(Boolean);
      return { ...base, parts, text: parts.join("\n") };
    }
    case "ordering":
    case "matching":
    case "categorization": {
      const items = splitQuotedItems(raw);
      const parts = items.map((p) => htmlToText(p).trim());
      return { ...base, parts, text: parts.join("\n\n") };
    }
    default:
      return { ...base, text: htmlToText(raw) };
  }
}

export function parseStudentAnalysisCsv(csvText: string, title = "New Quiz"): QuizData {
  const rows = parseCsv(csvText).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length < 1) throw new CsvFormatError("The file is empty.");
  const header = rows[0];
  const col = (name: string) => header.indexOf(name);
  const itemCols = header.map((h, i) => (h === "ItemID" ? i : -1)).filter((i) => i >= 0);
  if (col("ID") < 0 || itemCols.length === 0 || header[itemCols[0] + 3] !== "EarnedPoints") {
    throw new CsvFormatError(
      "This doesn't look like a New Quizzes Student Analysis report (expected Name, ID and ItemID / ItemType / EarnedPoints columns).",
    );
  }
  const data = rows.slice(1);
  const notes: string[] = [];

  const questions: Question[] = itemCols.map((c, idx) => {
    const ids = new Set(data.map((r) => r[c]).filter(Boolean));
    if (ids.size > 1) {
      notes.push(`Question ${idx + 1} has different item IDs for different students (question bank?). Using the first.`);
    }
    const rawType = data.find((r) => r[c + 1])?.[c + 1] ?? "unknown";
    const prompt = header[c + 2] ?? "";
    const kind = KIND[rawType] ?? "other";
    let blankIds = kind === "fill_blank" || kind === "dropdown" ? blankMarkers(prompt) : [];
    if ((kind === "fill_blank" || kind === "dropdown") && blankIds.length === 0) {
      // No markers in the prompt: use the most common number of top-level parts.
      const n = mode(data.map((r) => r[c + 2]).filter(Boolean).map((v) => splitTopLevel(v).length));
      blankIds = Array.from({ length: n }, (_, i) => `blank${i + 1}`);
    }
    const earned = data.map((r) => num(r[c + 3])).filter((v): v is number => v != null);
    return {
      id: [...ids][0] ?? `col${c}`,
      position: idx + 1,
      kind,
      rawType,
      text: htmlToText(prompt),
      pointsPossible: earned.length ? Math.max(...earned) : null,
      pointsSource: earned.length ? "inferred" : "unknown",
      blankIds,
      choices: [],
    } satisfies Question;
  });

  // Keep the latest attempt per student.
  const latest = new Map<string, string[]>();
  for (const r of data) {
    const id = r[col("ID")];
    if (!id) continue;
    const prev = latest.get(id);
    if (!prev || (num(r[col("Attempt")]) ?? 0) >= (num(prev[col("Attempt")]) ?? 0)) latest.set(id, r);
  }

  const students: Student[] = [...latest.values()].map((r) => {
    const name = r[col("Name")] || r[col("ID")];
    const parts = name.trim().split(/\s+/);
    const sortable = parts.length > 1 ? `${parts.slice(-1)[0]}, ${parts.slice(0, -1).join(" ")}` : name;
    const sections = col("SectionNames") >= 0
      ? [...new Set(r[col("SectionNames")].split(",").map((s) => s.trim()).filter(Boolean))].join("; ")
      : undefined;
    const responses: Record<string, Response> = {};
    itemCols.forEach((c, idx) => {
      const q = questions[idx];
      responses[q.id] = parseResponse(q, r[c + 2] ?? "", num(r[c + 3]));
    });
    return {
      userId: r[col("ID")],
      name,
      sortableName: sortable,
      section: sections,
      attempt: num(r[col("Attempt")]),
      canvasScore: col("OverallScore") >= 0 ? num(r[col("OverallScore")]) : null,
      submittedAt: col("Submitted") >= 0 ? r[col("Submitted")] || null : null,
      responses,
    };
  });
  students.sort((a, b) => a.sortableName.localeCompare(b.sortableName));

  const ptsCol = col("PointsPossible");
  const total = ptsCol >= 0 ? num(data[0]?.[ptsCol]) : null;
  const inferredSum = questions.reduce((s, q) => s + (q.pointsPossible ?? 0), 0);
  if (total != null && Math.abs(inferredSum - total) > 0.01) {
    notes.push(
      `Max points per question aren't in the report, so they're inferred from the best score anyone earned. ` +
      `Those add up to ${+inferredSum.toFixed(2)} of ${total}. Set \`points:\` in the rubric for questions nobody got full credit on.`,
    );
  }
  return {
    source: "new_quizzes_csv",
    title,
    pointsPossible: total,
    postManually: null,
    questions,
    students,
    notes,
  };
}
