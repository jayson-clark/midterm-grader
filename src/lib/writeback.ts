// Turning grading results into Canvas updates, and sending them.
//
// Classic quizzes: per-question scores (and comments, only where the rubric or reviewer
// wrote one) on the quiz submission. Only rubric-graded / overridden questions are sent.
// New Quizzes: Canvas has no API for per-question scores, so the assignment's total score is
// set to Canvas total - Canvas points on rubric questions + rubric points.

import { api, listSubmissions, saveBackup } from "./canvas";
import type { StudentResult } from "./grader";
import type { QuizData } from "./types";

export interface QuestionChange {
  questionId: string;
  position: number;
  from: number | null;
  to: number;
  comment?: string;
}

export interface PlannedWrite {
  userId: string;
  name: string;
  canvasScore: number | null;
  newScore: number | null;
  questions: QuestionChange[];
  /** New Quizzes: optional submission comment summarizing the changes */
  summaryComment?: string;
  /** why this student can't be written, if so */
  blocked?: string;
}

export interface WriteOptions {
  /** New Quizzes: add a submission comment listing the per-question changes */
  summaryComment: boolean;
  /** only write students marked reviewed */
  onlyReviewed: boolean;
  reviewed: Set<string>;
}

const fmt = (n: number | null) => (n == null ? "–" : String(Math.round(n * 100) / 100));

export function planWrites(quiz: QuizData, results: Map<string, StudentResult>, opts: WriteOptions): PlannedWrite[] {
  const qpos = new Map(quiz.questions.map((q) => [q.id, q.position]));
  const out: PlannedWrite[] = [];
  for (const s of quiz.students) {
    if (opts.onlyReviewed && !opts.reviewed.has(s.userId)) continue;
    const r = results.get(s.userId);
    if (!r) continue;
    const questions: QuestionChange[] = [];
    for (const c of Object.values(r.cells)) {
      if (c.status !== "graded" && c.status !== "override") continue;
      if (c.score == null) continue;
      const comment = c.comments.join("\n").trim() || undefined;
      const scoreChanged = c.canvasPoints == null || Math.abs(c.score - c.canvasPoints) > 1e-3;
      if (!scoreChanged && !(quiz.source === "classic" && comment)) continue;
      questions.push({ questionId: c.questionId, position: qpos.get(c.questionId) ?? 0, from: c.canvasPoints, to: c.score, comment });
    }
    questions.sort((a, b) => a.position - b.position);
    if (!questions.length) continue;
    const w: PlannedWrite = { userId: s.userId, name: s.name, canvasScore: s.canvasScore, newScore: r.newScore, questions };
    if (quiz.source === "classic") {
      if (!s.quizSubmissionId) w.blocked = "quiz submission not found";
    } else {
      if (r.newScore == null || s.canvasScore == null) w.blocked = "total score unknown";
      else if (Math.abs(r.newScore - s.canvasScore) < 1e-3) continue; // changes cancel out
      if (opts.summaryComment) {
        w.summaryComment = "Regraded: " + questions
          .filter((q) => q.from == null || Math.abs(q.to - q.from) > 1e-3)
          .map((q) => `Q${q.position} ${fmt(q.from)} → ${fmt(q.to)}${q.comment ? ` (${q.comment})` : ""}`)
          .join("; ") + `. Total ${fmt(s.canvasScore)} → ${fmt(r.newScore)}.`;
      }
    }
    out.push(w);
  }
  return out;
}

export interface WriteResult {
  userId: string;
  name: string;
  ok: boolean;
  message: string;
}

export async function backupBeforeWrite(quiz: QuizData, plan: PlannedWrite[]): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const body = {
    created: new Date().toISOString(),
    source: quiz.source,
    courseId: quiz.courseId,
    assignmentId: quiz.assignmentId,
    quizId: quiz.quizId,
    title: quiz.title,
    note: "Canvas scores before Midterm Grader wrote changes. 'from' values are what Canvas had.",
    students: plan.map((p) => ({ userId: p.userId, name: p.name, canvasScore: p.canvasScore, newScore: p.newScore, questions: p.questions })),
  };
  return saveBackup(`${quiz.assignmentId ?? "quiz"}_${stamp}`, JSON.stringify(body, null, 2));
}

export async function executeWrites(
  quiz: QuizData,
  plan: PlannedWrite[],
  onProgress: (done: number, total: number, last: WriteResult) => void,
): Promise<WriteResult[]> {
  if (!quiz.courseId || !quiz.assignmentId) throw new Error("No Canvas course/assignment selected.");
  const results: WriteResult[] = [];
  const todo = plan.filter((p) => !p.blocked);
  let current = new Map<string, number | null>();
  if (quiz.source === "new_quizzes_csv") {
    // The report may be older than Canvas: refuse to overwrite totals that changed since.
    const subs = await listSubmissions(quiz.courseId, quiz.assignmentId, []);
    current = new Map(subs.map((s) => [String(s.user_id), s.score]));
  }
  const students = new Map(quiz.students.map((s) => [s.userId, s]));
  for (const p of plan.filter((x) => x.blocked)) {
    results.push({ userId: p.userId, name: p.name, ok: false, message: `Skipped: ${p.blocked}` });
  }
  let done = 0;
  for (const p of todo) {
    let res: WriteResult;
    try {
      if (quiz.source === "classic") {
        const s = students.get(p.userId)!;
        const questions: Record<string, { score: number; comment?: string }> = {};
        for (const q of p.questions) questions[q.questionId] = q.comment ? { score: q.to, comment: q.comment } : { score: q.to };
        const out = await api<{ quiz_submissions: { score: number }[] }>(
          `/courses/${quiz.courseId}/quizzes/${quiz.quizId}/submissions/${s.quizSubmissionId}`,
          { method: "PUT", body: { quiz_submissions: [{ attempt: s.attempt, questions }] } },
        );
        res = { userId: p.userId, name: p.name, ok: true, message: `Updated ${p.questions.length} question(s); quiz score now ${fmt(out.quiz_submissions?.[0]?.score ?? null)}` };
      } else {
        const now = current.get(p.userId);
        if (now === undefined) throw new Error("no submission on Canvas for this student");
        if (now == null || p.canvasScore == null || Math.abs(now - p.canvasScore) > 1e-3) {
          throw new Error(`Canvas score changed since the report was exported (report ${fmt(p.canvasScore)}, Canvas now ${fmt(now)}). Re-export the report.`);
        }
        const body: Record<string, unknown> = { submission: { posted_grade: String(p.newScore) } };
        if (p.summaryComment) body.comment = { text_comment: p.summaryComment };
        await api(`/courses/${quiz.courseId}/assignments/${quiz.assignmentId}/submissions/${p.userId}`, { method: "PUT", body });
        res = { userId: p.userId, name: p.name, ok: true, message: `Total ${fmt(p.canvasScore)} → ${fmt(p.newScore)}` };
      }
    } catch (e) {
      res = { userId: p.userId, name: p.name, ok: false, message: (e as Error).message };
    }
    results.push(res);
    onProgress(++done, todo.length, res);
  }
  return results;
}
