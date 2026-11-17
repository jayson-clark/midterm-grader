// Shapes shared by the data sources, the grading engine and the UI.

/** Question kinds, unified across classic quizzes and New Quizzes. Rubric `types:` keys use these. */
export type Kind =
  | "essay"
  | "choice"
  | "true_false"
  | "multi_answer"
  | "fill_blank"
  | "dropdown"
  | "ordering"
  | "matching"
  | "numeric"
  | "formula"
  | "file_upload"
  | "categorization"
  | "hot_spot"
  | "text_only"
  | "other";

export const KINDS: Kind[] = [
  "essay", "choice", "true_false", "multi_answer", "fill_blank", "dropdown", "ordering",
  "matching", "numeric", "formula", "file_upload", "categorization", "hot_spot", "text_only", "other",
];

export interface Choice {
  id: string;
  text: string;
  correct: boolean | null;
}

export interface Question {
  id: string;
  /** 1-based order in the quiz */
  position: number;
  kind: Kind;
  /** Canvas's own type name (e.g. "rich-fill-blank", "essay_question") */
  rawType: string;
  /** Plain-text question prompt */
  text: string;
  /** Max points. null = unknown. */
  pointsPossible: number | null;
  pointsSource: "canvas" | "inferred" | "unknown";
  /** Blank names in order, for fill-in-blank / dropdown questions */
  blankIds: string[];
  choices: Choice[];
}

/** One student's answer to one question. */
export interface Response {
  questionId: string;
  /** Plain text the rules run against (HTML stripped, multi-part answers joined by newlines). */
  text: string;
  /** Original markup from Canvas, if any (displayed as source text, never rendered). */
  raw?: string;
  /** Per-blank answers, or the selected / ordered items, in order. */
  parts?: string[];
  /** Set when a multi-blank answer couldn't be split into the expected number of blanks. */
  partsMismatch?: boolean;
  /** Canvas's current score for the question. */
  canvasPoints: number | null;
  answered: boolean;
}

export interface Student {
  userId: string;
  name: string;
  sortableName: string;
  section?: string;
  attempt: number | null;
  canvasScore: number | null;
  submittedAt: string | null;
  /** classic quizzes only: needed to write per-question scores */
  quizSubmissionId?: string;
  responses: Record<string, Response>;
}

export type SourceKind = "classic" | "new_quizzes_csv";

export interface QuizData {
  source: SourceKind;
  title: string;
  courseId?: string;
  assignmentId?: string;
  /** classic quiz id */
  quizId?: string;
  pointsPossible: number | null;
  /** null when not known (offline CSV) */
  postManually: boolean | null;
  questions: Question[];
  students: Student[];
  notes: string[];
}
