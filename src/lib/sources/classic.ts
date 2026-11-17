// Classic Canvas quiz -> QuizData, straight from the API.

import { api, getAll, getAssignment, listSubmissions } from "../canvas";
import { htmlToText } from "../text";
import type { Choice, Kind, Question, QuizData, Response, Student } from "../types";

const KIND: Record<string, Kind> = {
  essay_question: "essay",
  multiple_choice_question: "choice",
  true_false_question: "true_false",
  multiple_answers_question: "multi_answer",
  short_answer_question: "fill_blank",
  fill_in_multiple_blanks_question: "fill_blank",
  multiple_dropdowns_question: "dropdown",
  matching_question: "matching",
  numerical_question: "numeric",
  calculated_question: "formula",
  file_upload_question: "file_upload",
  text_only_question: "text_only",
};

interface ApiQuestion {
  id: number;
  position: number;
  question_name?: string;
  question_type: string;
  question_text: string;
  points_possible: number;
  answers?: { id: number; text?: string; html?: string; weight?: number; blank_id?: string; left?: string; right?: string; match_id?: number }[];
  matches?: { match_id: number; text: string }[];
}

interface StatQuestion {
  id: string;
  position: number;
  question_type: string;
  question_text: string;
  answers?: { id: string; text: string; correct?: boolean }[];
  answer_sets?: { id: string; text: string; answers: { id: string; text: string; correct?: boolean }[] }[];
}

type Data = Record<string, unknown> & { question_id: number; points?: number; correct?: unknown; text?: string };

async function loadQuestions(courseId: string, quizId: string): Promise<{ questions: Question[]; source: "questions" | "statistics"; matches: Map<string, Map<string, string>> }> {
  const matches = new Map<string, Map<string, string>>();
  try {
    const list = await getAll<ApiQuestion>(`/courses/${courseId}/quizzes/${quizId}/questions`);
    const questions = list.sort((a, b) => a.position - b.position).map((q, i): Question => {
      const kind = KIND[q.question_type] ?? "other";
      const blankIds = kind === "fill_blank" || kind === "dropdown"
        ? q.question_type === "short_answer_question" ? ["answer"] : [...new Set((q.answers ?? []).map((a) => a.blank_id).filter((b): b is string => !!b))]
        : [];
      if (q.matches) matches.set(String(q.id), new Map(q.matches.map((m) => [String(m.match_id), m.text])));
      const choices: Choice[] = (q.answers ?? []).map((a) => ({
        id: String(a.id),
        text: kind === "matching" ? `${a.left ?? ""}` : htmlToText(a.html || a.text || ""),
        correct: a.weight == null ? null : a.weight > 0,
      }));
      return {
        id: String(q.id), position: i + 1, kind, rawType: q.question_type,
        text: htmlToText(q.question_text), pointsPossible: q.points_possible, pointsSource: "canvas", blankIds, choices,
      };
    });
    return { questions, source: "questions", matches };
  } catch (e) {
    if (!String(e).includes("401") && !String(e).includes("permission")) throw e;
  }
  // TAs often can't read /questions, but can read statistics.
  const stats = await api<{ quiz_statistics: { question_statistics: StatQuestion[] }[] }>(`/courses/${courseId}/quizzes/${quizId}/statistics`);
  const qs = stats.quiz_statistics[0]?.question_statistics ?? [];
  const questions = qs.sort((a, b) => Number(a.position) - Number(b.position)).map((q, i): Question => {
    const kind = KIND[q.question_type] ?? "other";
    const choices: Choice[] = [
      ...(q.answers ?? []),
      ...(q.answer_sets ?? []).flatMap((s) => s.answers),
    ].filter((a) => a.id !== "other" && a.id !== "none").map((a) => ({ id: String(a.id), text: htmlToText(a.text), correct: a.correct ?? null }));
    return {
      id: String(q.id), position: i + 1, kind, rawType: q.question_type, text: htmlToText(q.question_text),
      pointsPossible: null, pointsSource: "unknown",
      blankIds: q.question_type === "short_answer_question" ? ["answer"] : (q.answer_sets ?? []).map((s) => s.text),
      choices,
    };
  });
  return { questions, source: "statistics", matches };
}

function toResponse(q: Question, d: Data | undefined, matches: Map<string, string> | undefined): Response {
  if (!d) return { questionId: q.id, text: "", canvasPoints: null, answered: false };
  const pts = typeof d.points === "number" ? d.points : null;
  const choiceText = (id: unknown) => q.choices.find((c) => c.id === String(id))?.text ?? String(id ?? "");
  const base = { questionId: q.id, canvasPoints: pts };
  switch (q.rawType) {
    case "multiple_choice_question":
    case "true_false_question": {
      const t = d.answer_id != null ? choiceText(d.answer_id) : "";
      return { ...base, text: t, parts: d.answer_id != null ? [String(d.answer_id)] : [], answered: d.answer_id != null };
    }
    case "multiple_answers_question": {
      const ids = Object.entries(d).filter(([k, v]) => k.startsWith("answer_") && String(v) === "1").map(([k]) => k.slice(7));
      const parts = ids.map(choiceText);
      return { ...base, text: parts.join("\n"), parts, answered: ids.length > 0 };
    }
    case "fill_in_multiple_blanks_question":
    case "multiple_dropdowns_question": {
      const dropdown = q.rawType === "multiple_dropdowns_question";
      const parts = q.blankIds.map((b) => {
        const v = d[`answer_for_${b}`];
        return v == null ? "" : dropdown ? choiceText(v) : String(v);
      });
      return { ...base, text: parts.join("\n"), parts, answered: parts.some((p) => p.trim() !== "") };
    }
    case "matching_question": {
      const parts = Object.entries(d).filter(([k]) => k.startsWith("answer_")).map(([k, v]) => {
        const left = choiceText(k.slice(7));
        return `${left} => ${matches?.get(String(v)) ?? String(v ?? "")}`;
      });
      return { ...base, text: parts.join("\n"), parts, answered: parts.length > 0 };
    }
    case "file_upload_question": {
      const n = Array.isArray(d.attachment_ids) ? d.attachment_ids.length : 0;
      return { ...base, text: n ? `[${n} file(s) uploaded]` : "", answered: n > 0 };
    }
    default: {
      const raw = typeof d.text === "string" ? d.text : "";
      const parts = q.rawType === "short_answer_question" ? [htmlToText(raw)] : undefined;
      return { ...base, text: htmlToText(raw), raw, parts, answered: htmlToText(raw).trim() !== "" };
    }
  }
}

export async function loadClassicQuiz(courseId: string, assignmentId: string): Promise<QuizData> {
  const a = await getAssignment(courseId, assignmentId);
  if (!a.quiz_id) throw new Error("This assignment isn't a classic quiz.");
  const quizId = String(a.quiz_id);
  const [{ questions, source, matches }, subs, qsubs] = await Promise.all([
    loadQuestions(courseId, quizId),
    listSubmissions(courseId, assignmentId, ["user", "submission_history"]),
    api<{ quiz_submissions: { id: number; user_id: number; attempt: number }[] }[]>(
      `/courses/${courseId}/quizzes/${quizId}/submissions`, { query: [["per_page", "100"]], paginate: true },
    ),
  ]);
  const qsubByUser = new Map<number, { id: number; attempt: number }>();
  for (const page of qsubs) for (const qs of page.quiz_submissions ?? []) qsubByUser.set(qs.user_id, qs);

  const notes: string[] = [];
  if (source === "statistics") {
    notes.push("Your role can't read the quiz's questions directly, so they come from quiz statistics. Max points per question are inferred; check them in the rubric.");
  }
  const students: Student[] = [];
  for (const s of subs) {
    if (s.workflow_state === "unsubmitted") continue;
    const hist = (s.submission_history ?? []).filter((h) => h.submission_data?.length);
    const last = hist[hist.length - 1];
    if (!last) continue;
    const data = new Map((last.submission_data as Data[]).map((d) => [String(d.question_id), d]));
    const responses: Record<string, Response> = {};
    for (const q of questions) responses[q.id] = toResponse(q, data.get(q.id), matches.get(q.id));
    students.push({
      userId: String(s.user_id),
      name: s.user?.name ?? String(s.user_id),
      sortableName: s.user?.sortable_name ?? s.user?.name ?? String(s.user_id),
      attempt: last.attempt,
      canvasScore: s.score,
      submittedAt: s.submitted_at,
      quizSubmissionId: qsubByUser.get(s.user_id) ? String(qsubByUser.get(s.user_id)!.id) : undefined,
      responses,
    });
  }
  // Infer max points where Canvas didn't say.
  for (const q of questions) {
    if (q.pointsPossible != null) continue;
    const pts = students.map((s) => s.responses[q.id]?.canvasPoints).filter((p): p is number => p != null);
    if (pts.length) { q.pointsPossible = Math.max(...pts); q.pointsSource = "inferred"; }
  }
  students.sort((x, y) => x.sortableName.localeCompare(y.sortableName));
  return {
    source: "classic",
    title: a.name,
    courseId,
    assignmentId,
    quizId,
    pointsPossible: a.points_possible,
    postManually: a.post_manually ?? null,
    questions,
    students,
    notes,
  };
}
