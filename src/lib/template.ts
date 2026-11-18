// Builds a starter rubric from a loaded quiz. Every question is listed but commented out,
// so a fresh template changes nothing until the grader enables a question.

import { escapeRegex, squash, truncate } from "./text";
import type { Question, QuizData } from "./types";

const q1 = (s: string) => `'${s.replace(/'/g, "''")}'`;

function topAnswers(quiz: QuizData, q: Question, blank: number | null, n = 6): string[] {
  const counts = new Map<string, number>();
  for (const s of quiz.students) {
    const r = s.responses[q.id];
    if (!r) continue;
    const t = squash(blank == null ? r.text : r.parts?.[blank] ?? "");
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([t, c]) => `${truncate(t, 60)} ×${c}`);
}

/** Loose regex for a typed answer: optional whitespace around punctuation, anchored. */
export function looseRegex(answer: string): string {
  const parts = squash(answer).split(/(\s+|[()[\]{}<>=!&|+\-*/%;,])/).filter((p) => p !== "" && !/^\s+$/.test(p));
  const body = parts.map((p) => {
    if (!/^\d+(\.\d+)?$/.test(p)) return escapeRegex(p);
    // numbers: 2 / 2.0 / 2.00 all match "2", and 2.9 / 2.90 match "2.90"
    const [int, frac = ""] = p.split(".");
    const sig = frac.replace(/0+$/, "");
    return sig ? `${int}\\.${sig}0*` : `${int}(?:\\.0*)?`;
  }).join("\\s*");
  return `^${body}$`;
}

function pointsLine(q: Question): string {
  if (q.pointsPossible == null) return "    points: 0        # max points unknown: set this";
  if (q.pointsPossible === 0) return "    points: 0        # this question is worth 0 points, so any partial credit is 0 too; set a value to see scores";
  const tag = q.pointsSource === "inferred" ? "   # inferred from the best score earned: check it" : "";
  return `    points: ${+q.pointsPossible.toFixed(4)}${tag}`;
}

/**
 * Correct order for an ordering question, from the students Canvas gave full credit:
 * one pattern per piece, built from a line no other piece contains.
 */
function orderPatterns(quiz: QuizData, q: Question): { patterns: string[]; from: string } | null {
  // Prefer the real answer key (New Quizzes provides it); otherwise the order full-credit students used.
  const keyed = q.answerKey?.map((a) => a[0] ?? "");
  const order = keyed?.length ? keyed : fullCreditOrder(quiz, q);
  if (!order) return null;
  const lines = order.map((p) => p.split("\n").map((l) => squash(l)).filter(Boolean));
  const patterns = lines.map((ls, i) => {
    const others = new Set(lines.filter((_, j) => j !== i).flat());
    const pick = ls.find((l) => !others.has(l) && l.length > 3) ?? ls.find((l) => !others.has(l)) ?? ls[0] ?? "";
    // whole-line match (m flag), so "else" doesn't also match "else if (...)"
    return `/${looseRegex(pick)}/m`;
  });
  return { patterns, from: keyed?.length ? "the quiz's answer key" : "the order students with full credit used" };
}

function fullCreditOrder(quiz: QuizData, q: Question): string[] | null {
  const max = q.pointsPossible;
  if (!max) return null;
  const counts = new Map<string, { parts: string[]; n: number }>();
  for (const s of quiz.students) {
    const r = s.responses[q.id];
    if (!r?.parts?.length || r.canvasPoints == null || Math.abs(r.canvasPoints - max) > 1e-3) continue;
    const k = JSON.stringify(r.parts);
    counts.set(k, { parts: r.parts, n: (counts.get(k)?.n ?? 0) + 1 });
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best ? best.parts : null;
}

function example(quiz: QuizData, q: Question): string[] {
  const L: string[] = [pointsLine(q)];
  switch (q.kind) {
    case "ordering": {
      const pats = orderPatterns(quiz, q);
      L.push("    scoring: position     # position: points per piece in its right spot | sequence: longest run in the right order");
      if (pats) {
        L.push(`    order:                # from ${pats.from}`);
        pats.patterns.forEach((p, i) => L.push(`      - ${q1(p)}   # piece ${i + 1}`));
      } else {
        L.push("    # Couldn't find the correct order (no answer key and nobody got full credit).");
        L.push("    # Replace these with one pattern per piece, in the correct order:");
        L.push("    order:");
        L.push("      - 'a line only the first piece contains'", "      - 'a line only the second piece contains'");
      }
      break;
    }
    case "fill_blank":
    case "dropdown": {
      L.push("    blanks:");
      q.blankIds.forEach((b, i) => {
        const seen = topAnswers(quiz, q, i, 5);
        const accepted = q.answerKey?.[i]?.filter(Boolean) ?? [];
        const seenNote = seen.length ? ` | seen: ${seen.join(", ")}` : "";
        if (accepted.length) {
          // New Quizzes gave us the answer key: one pattern per accepted answer.
          const pats = [...new Set(accepted.map(looseRegex))].map(q1);
          L.push(`      - ${pats.length === 1 ? pats[0] : `[${pats.join(", ")}]`}   # key: ${accepted.join(" | ")}${seenNote}`);
          return;
        }
        const guess = /^blank\d*$|^answer$/.test(b) ? (seen[0]?.replace(/ ×\d+$/, "") ?? "") : b;
        L.push(`      - ${q1(looseRegex(guess))}   # ${b}${seenNote}`);
      });
      break;
    }
    case "essay":
      L.push("    mode: sum", "    rules:");
      L.push(`      - match: 'keyword|other phrase'`, "        score: 50%");
      L.push("      - min_words: 15", "        score: 50%");
      L.push("    otherwise:", "      score: 0", "      flag: check by hand");
      break;
    case "numeric":
    case "formula":
      L.push("    rules:", "      - number: { value: 0, tolerance: 0.01 }", "    otherwise: 0");
      break;
    default: {
      const correct = q.choices.filter((c) => c.correct).map((c) => c.text);
      const ans = correct[0] ?? topAnswers(quiz, q, null, 1)[0]?.replace(/ ×\d+$/, "") ?? "";
      L.push(`    answer: ${q1(`^${escapeRegex(squash(ans))}$`)}`);
    }
  }
  return L;
}

export function buildTemplate(quiz: QuizData): string {
  const L: string[] = [
    `# Rubric for: ${quiz.title}`,
    `# Generated by Midterm Grader on ${new Date().toISOString().slice(0, 10)}. Format reference: RUBRIC.md`,
    "#",
    "# Only questions listed under `questions:` (or matched by `types:`) are regraded.",
    "# Everything else keeps its Canvas score and is never sent back to Canvas.",
    "# Each question below is commented out: uncomment (Cmd+/) the ones you want to grade.",
    "",
    "version: 1",
    `title: ${q1(quiz.title)}`,
    "",
    "# Instructions shown to graders who load this rubric:",
    "notes: |",
    "  Review everything flagged before sending.",
    "",
    "settings:",
    "  case_sensitive: false   # regexes ignore case unless written /like this/ with flags",
    "  whitespace: lines       # trim each line and collapse runs of spaces (lines | collapse | keep)",
    "  blank_answers: zero     # blank answer on a graded question: zero | keep | flag | rules",
    "",
    "# Rules for every question of a type (a question's own entry below wins):",
    "# types:",
    "#   essay:",
    "#     rules:",
    "#       - min_words: 10",
    "#     otherwise: { score: 0, flag: too short }",
    "",
    "questions:",
  ];
  for (const q of quiz.questions) {
    if (q.kind === "text_only") continue;
    L.push("");
    L.push(`  # ── Q${q.position} · ${q.kind}${q.rawType !== q.kind ? ` (${q.rawType})` : ""} · ${q.pointsPossible ?? "?"} pts`);
    L.push(`  # ${truncate(squash(q.text), 110)}`);
    if (q.kind !== "fill_blank" && q.kind !== "dropdown" && q.kind !== "essay") {
      const seen = topAnswers(quiz, q, null, 4);
      if (seen.length) L.push(`  # seen: ${seen.join(" | ")}`);
    }
    L.push(`  # "${q.id}":`);
    for (const line of example(quiz, q)) L.push(`  # ${line.slice(2)}`);
  }
  return L.join("\n") + "\n";
}
