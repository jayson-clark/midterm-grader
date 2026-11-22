import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  loadSettings, signInWithCanvas, SIGNED_OUT_EVENT, whoAmI, type AssignmentInfo, type Course, type PublicSettings,
} from "./lib/canvas";
import type { QuizData } from "./lib/types";
import { AssignmentsScreen, ClassicLoadScreen, ConnectScreen, CoursesScreen, CsvLoadScreen, NewQuizLoadScreen } from "./screens/Setup";
import { Workspace, type Mode } from "./screens/Workspace";
import { Logo, Spinner } from "./components/ui";

type View = "connect" | "courses" | "assignments" | "load" | "workspace";

const ZOOMS = [0.85, 1, 1.15, 1.3, 1.5];

/** Scale the whole window, like a browser's zoom. */
async function applyZoom(z: number) {
  try { await getCurrentWebview().setZoom(z); }
  catch { document.documentElement.style.setProperty("zoom", String(z)); }
}

export default function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [booted, setBooted] = useState(false);
  const [view, setView] = useState<View>("connect");
  const [offline, setOffline] = useState(false);
  const [course, setCourse] = useState<Course | null>(null);
  const [assignment, setAssignment] = useState<AssignmentInfo | null>(null);
  const [quiz, setQuiz] = useState<QuizData | null>(null);
  /** New Quizzes: the user chose the CSV report instead of loading from New Quizzes */
  const [useCsv, setUseCsv] = useState(false);
  const [mode, setModeState] = useState<Mode>(() => {
    try { return localStorage.getItem("mg:mode") === "author" ? "author" : "grade"; } catch { return "grade"; }
  });
  const setMode = (m: Mode) => {
    setModeState(m);
    try { localStorage.setItem("mg:mode", m); } catch { /* not fatal */ }
  };

  const [zoom, setZoom] = useState(() => {
    try { const z = Number(localStorage.getItem("mg:zoom")); return ZOOMS.includes(z) ? z : 1; } catch { return 1; }
  });
  useEffect(() => {
    void applyZoom(zoom);
    try { localStorage.setItem("mg:zoom", String(zoom)); } catch { /* not fatal */ }
  }, [zoom]);
  const stepZoom = (d: number) => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(z) + d))]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === "=" || e.key === "+") { e.preventDefault(); stepZoom(1); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); stepZoom(-1); }
      else if (e.key === "0") { e.preventDefault(); setZoom(1); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [notice, setNotice] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [reauthing, setReauthing] = useState(false);
  const reauthCancelled = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await loadSettings();
        setSettings(s);
        if (s.auth_mode === "token" && s.has_token && s.base_url) setView("courses");
        if (s.auth_mode === "session") {
          // Canvas sessions don't always survive restarting the app; check before skipping ahead.
          try { await whoAmI(); setView("courses"); }
          catch { setNotice("Your Canvas sign-in has ended. Sign in again to continue."); }
        }
      } catch { /* first run */ }
      setBooted(true);
    })();
  }, []);

  // Canvas said the session is gone (expired or signed out elsewhere).
  useEffect(() => {
    const onExpired = () => setExpired(true);
    window.addEventListener(SIGNED_OUT_EVENT, onExpired);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onExpired);
  }, []);

  async function reauth() {
    if (!settings) return;
    reauthCancelled.current = false;
    setReauthing(true);
    try {
      const st = await signInWithCanvas(settings.base_url, () => reauthCancelled.current);
      if (st?.state === "ok" && st.settings) { setSettings(st.settings); setExpired(false); }
    } catch { /* stays expired; the banner remains */ }
    setReauthing(false);
  }

  const go = (v: View) => {
    if (v === "connect" || v === "courses") { setAssignment(null); setQuiz(null); }
    if (v === "assignments") { setQuiz(null); setUseCsv(false); }
    if (v === "load") setQuiz(null);
    setView(v);
  };

  // The process, left to right. Finished steps show what was picked and go back to that choice.
  const steps: { label: string; value?: string; view: View }[] = offline
    ? [
      { label: "Connect", value: "Offline", view: "connect" },
      { label: "Report", value: quiz?.title, view: "load" },
      { label: "Grade", view: "workspace" },
    ]
    : [
      { label: "Connect", value: settings?.auth_mode ? settings.base_url.replace(/^https?:\/\//, "") : undefined, view: "connect" },
      { label: "Course", value: course ? course.course_code || course.name : undefined, view: "courses" },
      { label: "Quiz", value: assignment?.name, view: "assignments" },
      ...(useCsv && assignment?.flavor === "new_quiz" ? [{ label: "Report", view: "load" as View }] : []),
      { label: "Grade", view: "workspace" },
    ];
  const at = steps.findIndex((s) => s.view === view);
  const current = at >= 0 ? at : steps.length - 1;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><Logo /> <span className="name">Midterm Grader</span></div>
        <nav className="steps-nav" aria-label="Progress">
          {steps.map((s, i) => {
            const state = i < current ? "done" : i === current ? "current" : "todo";
            return (
              <span key={s.label} className="row" style={{ gap: 2, minWidth: 0, flexShrink: state === "current" ? 0 : 1 }}>
                {i > 0 && <span className="sep" aria-hidden>›</span>}
                <button className={`stepc ${state}`} disabled={state !== "done"} aria-current={state === "current" ? "step" : undefined}
                  title={state === "done" ? `${s.label}${s.value ? `: ${s.value}` : ""} (click to change)` : s.label}
                  onClick={() => { if (s.view === "connect") setOffline(false); go(s.view); }}>
                  <span className="n">{state === "done" ? "✓" : i + 1}</span>
                  <span className="lbl">{state === "done" && s.value ? s.value : s.label}</span>
                </button>
              </span>
            );
          })}
        </nav>
        <span className="spacer" />
        <div className="seg zoom" role="group" aria-label="Text size">
          <button onClick={() => stepZoom(-1)} disabled={zoom === ZOOMS[0]} title="Make everything smaller (⌘−)" aria-label="Zoom out">A−</button>
          <button className="pct" onClick={() => setZoom(1)} title="Reset to 100% (⌘0)">{Math.round(zoom * 100)}%</button>
          <button onClick={() => stepZoom(1)} disabled={zoom === ZOOMS[ZOOMS.length - 1]} title="Make everything bigger (⌘+)" aria-label="Zoom in" style={{ fontSize: 15 }}>A+</button>
        </div>
        <div className="seg" title="Grade: load a rubric and use it. Edit rubrics: write and test rubrics.">
          <button className={mode === "grade" ? "on" : ""} onClick={() => setMode("grade")}>Grade</button>
          <button className={mode === "author" ? "on" : ""} onClick={() => setMode("author")}>Edit rubrics</button>
        </div>
      </header>

      {expired && view !== "connect" && (
        <div className="notice warn banner row">
          <span className="grow">Your Canvas session has expired. Sign in again to keep working; nothing you've done here is lost.</span>
          {reauthing ? (
            <>
              <span className="row small"><Spinner /> Finish signing in in the Canvas window…</span>
              <button className="btn sm" onClick={() => { reauthCancelled.current = true; }}>Cancel</button>
            </>
          ) : (
            <button className="btn sm primary" onClick={reauth}>Sign in again</button>
          )}
        </div>
      )}

      {!booted ? (
        <div className="empty-state"><Spinner /></div>
      ) : view === "connect" ? (
        <ConnectScreen settings={settings} notice={notice}
          onSaved={(s) => { setSettings(s); setNotice(null); setExpired(false); if (s.auth_mode) { setOffline(false); go("courses"); } }}
          onOffline={() => { setOffline(true); setCourse(null); setAssignment(null); go("load"); }} />
      ) : view === "courses" ? (
        <CoursesScreen onPick={(c) => { setCourse(c); go("assignments"); }} />
      ) : view === "assignments" && course ? (
        <AssignmentsScreen course={course} onPick={(a) => { setAssignment(a); go("load"); }} />
      ) : view === "load" ? (
        !offline && assignment?.flavor === "new_quiz" && course && !useCsv ? (
          <NewQuizLoadScreen course={course} assignment={assignment} onUseCsv={() => setUseCsv(true)} onLoaded={(q) => { setQuiz(q); setView("workspace"); }} />
        ) : offline || assignment?.flavor === "new_quiz" ? (
          <CsvLoadScreen course={offline ? null : course} assignment={offline ? null : assignment} onLoaded={(q) => { setQuiz(q); setView("workspace"); }} />
        ) : course && assignment ? (
          <ClassicLoadScreen course={course} assignment={assignment} onLoaded={(q) => { setQuiz(q); setView("workspace"); }} />
        ) : null
      ) : view === "workspace" && quiz ? (
        <Workspace key={`${quiz.source}:${quiz.assignmentId ?? quiz.title}`} quiz={quiz} mode={mode} />
      ) : null}
    </div>
  );
}
