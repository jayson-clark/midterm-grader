import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  forgetToken, gradingCourses, listSubmissions, quizAssignments, readTextFile, saveSettings, signInWithCanvas, signOut, whoAmI,
  type AssignmentInfo, type Course, type PublicSettings,
} from "../lib/canvas";
import { loadClassicQuiz } from "../lib/sources/classic";
import { parseStudentAnalysisCsv } from "../lib/sources/newQuizzesCsv";
import { loadNewQuizFromApi, type LoadProgress } from "../lib/sources/newQuizzesApi";
import type { QuizData } from "../lib/types";
import { ErrorNote, Spinner, fmt } from "../components/ui";

export function ConnectScreen({ settings, notice, onSaved, onOffline }: {
  settings: PublicSettings | null;
  /** e.g. "your session expired" */
  notice?: string | null;
  onSaved: (s: PublicSettings) => void;
  onOffline: () => void;
}) {
  const [url, setUrl] = useState(settings?.base_url || "https://osu.instructure.com");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [showToken, setShowToken] = useState(settings?.auth_mode === "token");
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => () => { cancelled.current = true; }, []);

  async function signIn() {
    setError(null);
    cancelled.current = false;
    setWaiting(true);
    try {
      const st = await signInWithCanvas(url, () => cancelled.current);
      if (st?.state === "ok" && st.settings) onSaved(st.settings);
      else if (st?.state === "closed") setError("The sign-in window was closed before you finished signing in.");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setWaiting(false);
    }
  }

  async function connectWithToken() {
    setBusy(true);
    setError(null);
    try {
      const s = await saveSettings(url, token || null);
      if (!s.has_token) throw new Error("Paste an access token.");
      await whoAmI();
      setToken("");
      onSaved(s);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const signedIn = settings?.auth_mode === "session";

  return (
    <div className="center-page">
      <div className="inner narrow">
        <div>
          <h1>Connect to Canvas</h1>
          <p className="muted">Midterm Grader reads quiz answers from Canvas, grades them with a rubric, and lets you review every submission before anything is sent back.</p>
        </div>
        {notice && <div className="notice warn">{notice}</div>}
        <div className="card pad col" style={{ gap: 14 }}>
          <label className="field">Canvas URL
            <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://school.instructure.com" disabled={waiting} />
          </label>

          {waiting ? (
            <div className="notice info col" style={{ gap: 8 }}>
              <div className="row"><Spinner /> <b>Finish signing in in the Canvas window.</b></div>
              <div className="small">Use your normal school login. This window will continue automatically once you're signed in.</div>
              <div><button className="btn sm" onClick={() => { cancelled.current = true; setWaiting(false); }}>Cancel</button></div>
            </div>
          ) : (
            <div className="col" style={{ gap: 6 }}>
              <div className="row">
                <button className="btn primary" onClick={signIn} disabled={!url}>
                  {signedIn ? "Sign in again" : "Sign in with Canvas"}
                </button>
                {signedIn && (
                  <button className="btn ghost danger" onClick={async () => onSaved(await signOut())}>Sign out</button>
                )}
              </div>
              <span className="muted small">
                Opens your school's Canvas login in a window inside this app. The app uses that sign-in only to talk to the Canvas URL above,
                and only while you're signed in. Nothing is read from your web browser.
              </span>
            </div>
          )}
          <ErrorNote error={error} />
        </div>

        <div className="card pad col" style={{ gap: 12 }}>
          <button className="btn ghost" style={{ alignSelf: "flex-start", padding: 0 }} onClick={() => setShowToken(!showToken)}>
            {showToken ? "▾" : "▸"} Use an access token instead
          </button>
          {showToken && (
            <>
              <label className="field">Access token
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)}
                  placeholder={settings?.has_token ? "Saved. Paste a new one to replace it" : "Paste token"} />
                <span className="hint">In Canvas: Account → Settings → <b>+ New Access Token</b>. It's stored only on this computer and only sent to the Canvas URL above.</span>
              </label>
              <div className="row">
                <button className="btn" onClick={connectWithToken} disabled={busy || !url || (!token && !settings?.has_token)}>
                  {busy ? <Spinner /> : null} {settings?.has_token && !token ? "Continue with saved token" : "Connect with token"}
                </button>
                {settings?.has_token && (
                  <button className="btn ghost danger" onClick={async () => { await forgetToken(); onSaved({ ...settings, has_token: false, auth_mode: settings.auth_mode === "token" ? "" : settings.auth_mode }); }}>
                    Forget saved token
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <button className="btn ghost" style={{ alignSelf: "flex-start" }} onClick={onOffline}>
          Or grade a New Quizzes report CSV without connecting →
        </button>
      </div>
    </div>
  );
}

export function CoursesScreen({ onPick }: { onPick: (c: Course) => void }) {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showOther, setShowOther] = useState(false);
  useEffect(() => {
    gradingCourses().then(setCourses).catch((e) => setError(e.message));
  }, []);
  const archived = (c: Course) => c.workflow_state === "completed" || /archived/i.test(c.name);
  const matches = (c: Course) => `${c.name} ${c.course_code} ${c.term?.name ?? ""}`.toLowerCase().includes(q.toLowerCase());
  const all = courses ?? [];
  const shown = useMemo(() => all.filter((c) =>
    (showArchived || !archived(c)) && (showOther || c.canGrade) && matches(c)), [courses, q, showArchived, showOther]);
  const hidden = all.filter((c) => (showOther || c.canGrade) && archived(c)).length;
  const other = all.filter((c) => !c.canGrade && (showArchived || !archived(c))).length;

  return (
    <div className="center-page">
      <div className="inner">
        <div className="row">
          <h1 className="grow">Which course?</h1>
          <input type="search" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </div>
        <ErrorNote error={error} />
        <div className="card list">
          {!courses && !error && <div className="empty-state"><Spinner /></div>}
          {courses && shown.length === 0 && <div className="empty-state">No courses where you're a teacher or TA{q ? " match that filter" : ""}.</div>}
          {shown.map((c) => (
            <button key={c.id} className="list-item" onClick={() => onPick(c)} style={c.canGrade ? undefined : { opacity: 0.6 }}>
              <div className="grow">
                <div style={{ fontWeight: 500 }}>{c.name}</div>
                <div className="muted small">
                  {c.course_code}{c.term?.name ? ` · ${c.term.name}` : ""}
                  {c.invited && " · You haven't accepted the course invitation in Canvas yet, so grading won't work until you do."}
                  {!c.canGrade && " · You're not a teacher or TA here, so you probably can't grade it."}
                </div>
              </div>
              {c.invited && <span className="badge">Invited</span>}
              {c.roles.map((r) => <span key={r} className="badge">{ROLE_NAMES[r] ?? r}</span>)}
            </button>
          ))}
        </div>
        {other > 0 && (
          <label className="row muted small"><input type="checkbox" checked={showOther} onChange={(e) => setShowOther(e.target.checked)} /> Show {other} course{other === 1 ? "" : "s"} where you're not a teacher or TA</label>
        )}
        {hidden > 0 && (
          <label className="row muted small"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show {hidden} archived / concluded course{hidden === 1 ? "" : "s"}</label>
        )}
      </div>
    </div>
  );
}

const ROLE_NAMES: Record<string, string> = { teacher: "Teacher", ta: "TA", designer: "Designer", student: "Student", observer: "Observer" };

export function AssignmentsScreen({ course, onPick }: { course: Course; onPick: (a: AssignmentInfo) => void }) {
  const [list, setList] = useState<AssignmentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    quizAssignments(String(course.id)).then(setList).catch((e) => setError(e.message));
  }, [course.id]);
  const shown = (list ?? []).filter((a) => a.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="center-page">
      <div className="inner">
        <div className="row">
          <div className="grow">
            <h1>Which quiz?</h1>
            <div className="muted">{course.name}</div>
          </div>
          <input type="search" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </div>
        <ErrorNote error={error} />
        <div className="card list">
          {!list && !error && <div className="empty-state"><Spinner /></div>}
          {list && shown.length === 0 && <div className="empty-state">No quizzes found.</div>}
          {shown.map((a) => (
            <button key={a.id} className="list-item" onClick={() => onPick(a)}>
              <div className="grow">
                <div style={{ fontWeight: 500 }}>{a.name}</div>
                <div className="muted small">
                  {fmt(a.points_possible)} pts{a.due_at ? ` · due ${new Date(a.due_at).toLocaleDateString()}` : ""}
                  {a.needs_grading_count ? ` · ${a.needs_grading_count} need grading` : ""}
                </div>
              </div>
              {!a.published && <span className="badge">unpublished</span>}
              {a.post_manually ? <span className="badge">manual posting</span> : <span className="badge warn">auto-posts grades</span>}
              <span className={`badge ${a.flavor === "classic" ? "accent" : ""}`}>{a.flavor === "classic" ? "Classic quiz" : "New Quiz"}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ClassicLoadScreen({ course, assignment, onLoaded }: { course: Course; assignment: AssignmentInfo; onLoaded: (q: QuizData) => void }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadClassicQuiz(String(course.id), String(assignment.id)).then(onLoaded).catch((e) => setError(e.message));
  }, [course.id, assignment.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="center-page">
      <div className="inner narrow">
        <h1>{assignment.name}</h1>
        {error ? <ErrorNote error={error} /> : <div className="row muted"><Spinner /> Loading questions and submissions…</div>}
      </div>
    </div>
  );
}

/** New Quizzes: load straight from New Quizzes, with the CSV report as a fallback. */
export function NewQuizLoadScreen({ course, assignment, onLoaded, onUseCsv }: {
  course: Course;
  assignment: AssignmentInfo;
  onLoaded: (q: QuizData) => void;
  onUseCsv: () => void;
}) {
  const [progress, setProgress] = useState<LoadProgress>({ phase: "Opening New Quizzes", done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    loadNewQuizFromApi(String(course.id), String(assignment.id), assignment.name, (p) => live && setProgress(p))
      .then((q) => {
        if (!live) return;
        q.postManually = assignment.post_manually ?? null;
        onLoaded(q);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [course.id, assignment.id, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <div className="center-page">
      <div className="inner narrow">
        <div>
          <h1>{assignment.name}</h1>
          <div className="muted">New Quiz · {course.name}</div>
        </div>
        {error ? (
          <div className="card pad col" style={{ gap: 12 }}>
            <div className="notice bad">Couldn't load this quiz from New Quizzes: {error}</div>
            <div className="row">
              <button className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
              <button className="btn primary" onClick={onUseCsv}>Use a Student Analysis CSV instead</button>
            </div>
          </div>
        ) : (
          <div className="card pad col" style={{ gap: 10 }}>
            <div className="row"><Spinner /> {progress.phase}{progress.total ? `: ${progress.done} of ${progress.total} students` : "…"}</div>
            {pct != null && <div className="progress"><div style={{ width: `${pct}%` }} /></div>}
            <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={onUseCsv}>Use a Student Analysis CSV instead</button>
          </div>
        )}
      </div>
    </div>
  );
}

interface CsvCheck {
  matched: number;
  notInCanvas: number;
  scoreDiffers: number;
  canvasSubmitted: number;
  missingFromCsv: number;
}

/** New Quizzes: the grader exports a Student Analysis CSV and loads it here. */
export function CsvLoadScreen({ course, assignment, onLoaded }: {
  course: Course | null;
  assignment: AssignmentInfo | null;
  onLoaded: (q: QuizData) => void;
}) {
  const [quiz, setQuiz] = useState<QuizData | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [check, setCheck] = useState<CsvCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick() {
    setError(null);
    const p = await open({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!p || Array.isArray(p)) return;
    setBusy(true);
    try {
      const text = await readTextFile(p);
      const title = assignment?.name ?? p.split(/[\\/]/).pop()!.replace(/\.csv$/i, "");
      const parsed = parseStudentAnalysisCsv(text, title);
      if (course && assignment) {
        parsed.courseId = String(course.id);
        parsed.assignmentId = String(assignment.id);
        parsed.postManually = assignment.post_manually ?? null;
        parsed.pointsPossible = assignment.points_possible ?? parsed.pointsPossible;
        const subs = await listSubmissions(String(course.id), String(assignment.id), []);
        const byUser = new Map(subs.map((s) => [String(s.user_id), s]));
        let matched = 0, notIn = 0, differs = 0;
        for (const s of parsed.students) {
          const c = byUser.get(s.userId);
          if (!c) { notIn++; continue; }
          matched++;
          if (c.score == null || s.canvasScore == null || Math.abs(c.score - s.canvasScore) > 1e-3) differs++;
        }
        const ids = new Set(parsed.students.map((s) => s.userId));
        const submitted = subs.filter((s) => s.workflow_state !== "unsubmitted");
        setCheck({ matched, notInCanvas: notIn, scoreDiffers: differs, canvasSubmitted: submitted.length, missingFromCsv: submitted.filter((s) => !ids.has(String(s.user_id))).length });
      }
      setQuiz(parsed);
      setPath(p);
    } catch (e) {
      setError((e as Error).message);
      setQuiz(null);
    } finally {
      setBusy(false);
    }
  }

  const wrongFile = check && check.matched === 0;
  return (
    <div className="center-page">
      <div className="inner">
        <div>
          <h1>{assignment?.name ?? "Grade a New Quizzes report"}</h1>
          <div className="muted">New Quiz{course ? ` · ${course.name}` : " · offline (nothing can be sent to Canvas)"}</div>
        </div>
        <div className="card pad col">
          <h3>Load the Student Analysis report</h3>
          <p className="muted" style={{ margin: 0 }}>
            Canvas doesn't share New Quizzes answers through its API, so this works from the report Canvas exports.
          </p>
          <ol className="steps">
            <li>In Canvas, open the quiz and choose <b>Build</b> (or <b>Moderate</b>) → <b>Reports</b>.</li>
            <li>Generate the <b>Student Analysis</b> report as <b>CSV</b> and download it.</li>
            <li>Load it here.</li>
          </ol>
          <div className="row">
            <button className="btn primary" onClick={pick} disabled={busy}>{busy ? <Spinner /> : null} Choose CSV…</button>
            {path && <span className="muted small mono">{path.split(/[\\/]/).pop()}</span>}
          </div>
          <ErrorNote error={error} />
        </div>

        {quiz && (
          <div className="card pad col">
            <h3>{quiz.students.length} submissions · {quiz.questions.length} questions</h3>
            {check && (
              <div className="col small">
                {wrongFile ? (
                  <div className="notice bad">None of the students in this report have a submission for <b>{assignment?.name}</b>. Is this the report for a different quiz?</div>
                ) : (
                  <div className={`notice ${check.notInCanvas || check.scoreDiffers ? "warn" : "good"}`}>
                    {check.matched} of {quiz.students.length} students match Canvas.
                    {check.scoreDiffers > 0 && <> <b>{check.scoreDiffers}</b> have a different score on Canvas than in the report (graded since it was exported?); they'll be skipped when sending unless you re-export.</>}
                    {check.notInCanvas > 0 && <> {check.notInCanvas} aren't on Canvas.</>}
                    {check.missingFromCsv > 0 && <> {check.missingFromCsv} Canvas submission(s) aren't in the report.</>}
                  </div>
                )}
              </div>
            )}
            {quiz.notes.map((n) => <div key={n} className="notice info small">{n}</div>)}
            <div className="row"><button className="btn primary" disabled={!!wrongFile} onClick={() => onLoaded(quiz)}>Start grading →</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
