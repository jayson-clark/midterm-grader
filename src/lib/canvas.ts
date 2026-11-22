// Canvas API access. All HTTP goes through the Rust backend, which holds the token.

import { invoke } from "@tauri-apps/api/core";

export interface PublicSettings {
  base_url: string;
  has_token: boolean;
  /** "session" (signed in through the Canvas login window), "token", or "" (not connected) */
  auth_mode: "session" | "token" | "";
}

export interface LoginStatus {
  state: "pending" | "closed" | "ok";
  name: string | null;
  settings: PublicSettings | null;
}

export const openLogin = (baseUrl: string) => invoke<void>("open_login", { baseUrl });
export const checkLogin = () => invoke<LoginStatus>("check_login");
export const signOut = () => invoke<PublicSettings>("sign_out");

/** Fired when Canvas says the session is gone, so the app can show the sign-in screen. */
export const SIGNED_OUT_EVENT = "mg:signed-out";

export const loadSettings = () => invoke<PublicSettings>("load_settings");
export const saveSettings = (baseUrl: string, token: string | null) =>
  invoke<PublicSettings>("save_settings", { baseUrl, token });
export const forgetToken = () => invoke<void>("forget_token");
export const readTextFile = (path: string) => invoke<string>("read_text_file", { path });
export const writeTextFile = (path: string, contents: string) => invoke<void>("write_text_file", { path, contents });
export const saveBackup = (name: string, contents: string) => invoke<string>("save_backup", { name, contents });

type Query = [string, string][];

export async function api<T = unknown>(path: string, opts: { method?: string; query?: Query; body?: unknown; paginate?: boolean } = {}): Promise<T> {
  try {
    return await invoke<T>("canvas", {
      req: { method: opts.method ?? "GET", path, query: opts.query ?? null, body: opts.body ?? null, paginate: opts.paginate ?? false },
    });
  } catch (e) {
    const msg = String(e);
    if (msg.startsWith("SIGNED_OUT:")) {
      window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT));
      throw new Error(msg.slice("SIGNED_OUT:".length).trim());
    }
    throw new Error(friendly(msg));
  }
}

function friendly(msg: string): string {
  if (msg.startsWith("HTTP 401")) return "Canvas rejected the request (401). Check your access token, or your role may not allow this.";
  if (msg.startsWith("HTTP 403")) return `Canvas says you don't have permission for this (403). ${msg.slice(9, 200)}`;
  if (msg.startsWith("HTTP 404")) return "Not found on Canvas (404).";
  return msg;
}

export const getAll = <T>(path: string, query: Query = []) =>
  api<T[]>(path, { query: [["per_page", "100"], ...query], paginate: true });

export interface Me {
  id: number;
  name: string;
}
export const whoAmI = () => api<Me>("/users/self");

export interface Course {
  id: number;
  name: string;
  course_code: string;
  workflow_state: string;
  term?: { name: string };
  /** enrollment types in this course: "teacher", "ta", "designer", "student", "observer" */
  roles: string[];
  /** teacher or TA: the roles that can grade */
  canGrade: boolean;
  /** every grading enrollment is still an invitation that hasn't been accepted in Canvas */
  invited: boolean;
}

type Enrollment = { type: string; role?: string; enrollment_state?: string };

export const GRADING_ROLES = ["teacher", "ta"];

/** Every course you're enrolled in, in any role, so the picker can say why a course can't be graded
 * instead of leaving it out. Pending invitations are fetched separately: Canvas only counts an
 * enrollment as current once it's been accepted. */
export async function gradingCourses(): Promise<Course[]> {
  const base: Query = [["include[]", "term"], ["state[]", "available"], ["state[]", "completed"], ["state[]", "unpublished"]];
  const lists = await Promise.all([
    getAll<Omit<Course, "roles" | "canGrade" | "invited"> & { enrollments?: Enrollment[] }>("/courses", base),
    getAll<Omit<Course, "roles" | "canGrade" | "invited"> & { enrollments?: Enrollment[] }>("/courses", [...base, ["enrollment_state", "invited_or_pending"]])
      .catch(() => []),
  ]);
  const byId = new Map<number, { course: Omit<Course, "roles" | "canGrade" | "invited">; enrollments: Enrollment[] }>();
  for (const c of lists.flat()) {
    const { enrollments = [], ...course } = c;
    const prev = byId.get(c.id);
    byId.set(c.id, { course, enrollments: [...(prev?.enrollments ?? []), ...enrollments] });
  }
  return [...byId.values()].map(({ course, enrollments }) => {
    const grading = enrollments.filter((e) => GRADING_ROLES.includes(e.type));
    return {
      ...course,
      roles: [...new Set(enrollments.map((e) => e.type))],
      canGrade: grading.length > 0,
      invited: grading.length > 0 && grading.every((e) => e.enrollment_state === "invited" || e.enrollment_state === "creation_pending"),
    };
  }).sort((a, b) => b.id - a.id);
}

export type QuizFlavor = "classic" | "new_quiz";

export interface AssignmentInfo {
  id: number;
  name: string;
  points_possible: number | null;
  due_at: string | null;
  quiz_id?: number;
  is_quiz_lti_assignment?: boolean;
  post_manually?: boolean;
  needs_grading_count?: number;
  published?: boolean;
  html_url?: string;
  flavor: QuizFlavor;
}

export async function quizAssignments(courseId: string): Promise<AssignmentInfo[]> {
  const list = await getAll<Omit<AssignmentInfo, "flavor">>(`/courses/${courseId}/assignments`, [["order_by", "due_at"]]);
  return list
    .filter((a) => a.quiz_id || a.is_quiz_lti_assignment)
    .map((a) => ({ ...a, flavor: a.quiz_id ? ("classic" as const) : ("new_quiz" as const) }));
}

export const getAssignment = (courseId: string, assignmentId: string) =>
  api<Omit<AssignmentInfo, "flavor">>(`/courses/${courseId}/assignments/${assignmentId}`);

export interface CanvasSubmission {
  id: number;
  user_id: number;
  score: number | null;
  attempt: number | null;
  workflow_state: string;
  submitted_at: string | null;
  posted_at: string | null;
  /** LTI submissions (New Quizzes): the tool URL, which carries the participant session id */
  url?: string | null;
  user?: { name: string; sortable_name: string };
  submission_history?: { attempt: number; submission_data?: Record<string, unknown>[] }[];
}

export const listSubmissions = (courseId: string, assignmentId: string, include: string[] = ["user"]) =>
  getAll<CanvasSubmission>(`/courses/${courseId}/assignments/${assignmentId}/submissions`, include.map((i) => ["include[]", i] as [string, string]));

/** Make sure future grades on this assignment stay hidden until someone posts them. */
export async function setManualPosting(assignmentId: string) {
  const res = await api<{ data?: unknown; errors?: { message: string }[] }>("/api/graphql", {
    method: "POST",
    body: {
      query: `mutation($id: ID!) { setAssignmentPostPolicy(input: {assignmentId: $id, postManually: true}) { postPolicy { postManually } errors { message } } }`,
      variables: { id: assignmentId },
    },
  });
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
  return res;
}

/** Hide grades that students can already see. */
export async function hideGrades(assignmentId: string) {
  const res = await api<{ errors?: { message: string }[] }>("/api/graphql", {
    method: "POST",
    body: {
      query: `mutation($id: ID!) { hideAssignmentGrades(input: {assignmentId: $id}) { progress { id } errors { message } } }`,
      variables: { id: assignmentId },
    },
  });
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
  return res;
}

/**
 * Opens the Canvas login window and waits until the user has signed in (state "ok") or closed
 * the window (state "closed"). Returns null if `cancelled()` becomes true first.
 */
export async function signInWithCanvas(baseUrl: string, cancelled: () => boolean): Promise<LoginStatus | null> {
  await openLogin(baseUrl);
  while (!cancelled()) {
    await new Promise((r) => setTimeout(r, 1500));
    if (cancelled()) break;
    const st = await checkLogin();
    if (st.state !== "pending") return st;
  }
  return null;
}

// ---------- New Quizzes (tokens stay in the backend; see src-tauri/src/nq.rs) ----------

export interface NqInfo {
  key: string;
  lti_assignment_id: string;
  read_only: boolean;
  title: string | null;
}

async function nqCall<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const msg = String(e);
    if (msg.startsWith("SIGNED_OUT:")) {
      window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT));
      throw new Error(msg.slice("SIGNED_OUT:".length).trim());
    }
    throw new Error(msg);
  }
}

export const nqOpen = (courseId: string, assignmentId: string) => nqCall<NqInfo>("nq_open", { courseId, assignmentId });
export const nqLti = <T = unknown>(key: string, path: string, paginate = false) => nqCall<T>("nq_lti", { key, path, paginate });
export const nqAttempt = (key: string, participantSessionId: string) => nqCall<string>("nq_attempt", { key, participantSessionId });
export const nqQuiz = <T = unknown>(key: string, quizSessionId: string, method: "GET" | "POST", path: string, body?: unknown, paginate = false) =>
  nqCall<T>("nq_quiz", { key, quizSessionId, method, path, body: body ?? null, paginate });
