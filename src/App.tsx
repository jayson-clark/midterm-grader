import { useEffect, useState } from "react";
import { loadSettings, type AssignmentInfo, type Course, type PublicSettings } from "./lib/canvas";
import type { QuizData } from "./lib/types";
import { AssignmentsScreen, ClassicLoadScreen, ConnectScreen, CoursesScreen, CsvLoadScreen } from "./screens/Setup";
import { Workspace, type Mode } from "./screens/Workspace";
import { Logo, Spinner } from "./components/ui";

type View = "connect" | "courses" | "assignments" | "load" | "workspace";

export default function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [booted, setBooted] = useState(false);
  const [view, setView] = useState<View>("connect");
  const [offline, setOffline] = useState(false);
  const [course, setCourse] = useState<Course | null>(null);
  const [assignment, setAssignment] = useState<AssignmentInfo | null>(null);
  const [quiz, setQuiz] = useState<QuizData | null>(null);
  const [mode, setModeState] = useState<Mode>(() => {
    try { return localStorage.getItem("mg:mode") === "author" ? "author" : "grade"; } catch { return "grade"; }
  });
  const setMode = (m: Mode) => {
    setModeState(m);
    try { localStorage.setItem("mg:mode", m); } catch { /* not fatal */ }
  };

  useEffect(() => {
    loadSettings()
      .then((s) => { setSettings(s); if (s.has_token && s.base_url) setView("courses"); })
      .catch(() => {})
      .finally(() => setBooted(true));
  }, []);

  const go = (v: View) => {
    if (v === "connect" || v === "courses") { setAssignment(null); setQuiz(null); }
    if (v === "assignments") setQuiz(null);
    if (v === "load") setQuiz(null);
    setView(v);
  };

  const crumbs: { label: string; view: View }[] = [];
  if (offline) {
    crumbs.push({ label: "Offline", view: "connect" });
    if (quiz) crumbs.push({ label: quiz.title, view: "load" });
  } else {
    if (settings?.has_token) crumbs.push({ label: settings.base_url.replace(/^https?:\/\//, ""), view: "connect" });
    if (course) crumbs.push({ label: course.course_code || course.name, view: "courses" });
    if (assignment) crumbs.push({ label: assignment.name, view: "assignments" });
    if (quiz && assignment?.flavor === "new_quiz") crumbs.push({ label: "Report", view: "load" });
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><Logo /> Midterm Grader</div>
        <nav className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i} className="row" style={{ gap: 4 }}>
              <span className="sep">/</span>
              <button onClick={() => { if (c.view === "connect") setOffline(false); go(c.view); }}>{c.label}</button>
            </span>
          ))}
        </nav>
        <span className="spacer" />
        <div className="seg" title="Grade: load a rubric and use it. Edit rubrics: write and test rubrics.">
          <button className={mode === "grade" ? "on" : ""} onClick={() => setMode("grade")}>Grade</button>
          <button className={mode === "author" ? "on" : ""} onClick={() => setMode("author")}>Edit rubrics</button>
        </div>
      </header>

      {!booted ? (
        <div className="empty-state"><Spinner /></div>
      ) : view === "connect" ? (
        <ConnectScreen settings={settings}
          onSaved={(s) => { setSettings(s); if (s.has_token) { setOffline(false); go("courses"); } }}
          onOffline={() => { setOffline(true); setCourse(null); setAssignment(null); go("load"); }} />
      ) : view === "courses" ? (
        <CoursesScreen onPick={(c) => { setCourse(c); go("assignments"); }} />
      ) : view === "assignments" && course ? (
        <AssignmentsScreen course={course} onPick={(a) => { setAssignment(a); go("load"); }} />
      ) : view === "load" ? (
        offline || assignment?.flavor === "new_quiz" ? (
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
