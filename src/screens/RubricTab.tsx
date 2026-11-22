import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "../lib/canvas";
import type { Problem } from "../lib/rubric";
import { highlightYaml } from "../lib/highlight";
import { buildTemplate } from "../lib/template";
import { truncate } from "../lib/text";
import { ErrorNote, Modal } from "../components/ui";
import type { WorkspaceCtx } from "./Workspace";

const LINE_H = 19;

export function RubricTab({ ctx, text, setText, path, setPath, dirty, markSaved, problems }: {
  ctx: WorkspaceCtx;
  text: string;
  setText: (t: string) => void;
  path: string | null;
  setPath: (p: string | null) => void;
  dirty: boolean;
  markSaved: (t: string) => void;
  problems: Problem[];
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const colored = useRef<HTMLElement>(null);
  const tokens = useMemo(() => highlightYaml(text), [text]);
  const [error, setError] = useState<string | null>(null);
  const [confirmTemplate, setConfirmTemplate] = useState(false);
  const { quiz, specs, results } = ctx;

  const lines = text.split("\n").length;
  const lineLevel = new Map<number, "err" | "warn">();
  for (const p of problems) if (p.line) lineLevel.set(p.line, p.level === "error" || lineLevel.get(p.line) === "err" ? "err" : "warn");

  async function doOpen() {
    setError(null);
    const p = await open({ multiple: false, filters: [{ name: "Rubric", extensions: ["yaml", "yml"] }] });
    if (!p || Array.isArray(p)) return;
    try {
      const t = await readTextFile(p);
      setText(t); setPath(p); markSaved(t);
    } catch (e) { setError(String(e)); }
  }
  async function doSave(as = false) {
    setError(null);
    let p = path;
    if (!p || as) {
      p = await save({ defaultPath: `${quiz.title.replace(/[^\w.-]+/g, "_")}.rubric.yaml`, filters: [{ name: "Rubric", extensions: ["yaml", "yml"] }] });
      if (!p) return;
    }
    try {
      await writeTextFile(p, text);
      setPath(p); markSaved(text);
    } catch (e) { setError(String(e)); }
  }
  function newFromQuiz() {
    setText(buildTemplate(quiz)); setPath(null); markSaved("");
    setConfirmTemplate(false);
  }

  function jump(line: number) {
    const el = ta.current;
    if (!el) return;
    const ls = text.split("\n");
    const start = ls.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(start, start + (ls[line - 1]?.length ?? 0));
    el.scrollTop = Math.max(0, (line - 6) * LINE_H);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: end, value } = el;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const blockEnd = (() => { const i = value.indexOf("\n", end - (end > s && value[end - 1] === "\n" ? 1 : 0)); return i < 0 ? value.length : i; })();
    const replaceBlock = (fn: (l: string) => string) => {
      const block = value.slice(lineStart, blockEnd);
      const next = block.split("\n").map(fn).join("\n");
      const v = value.slice(0, lineStart) + next + value.slice(blockEnd);
      setText(v);
      requestAnimationFrame(() => { el.selectionStart = lineStart; el.selectionEnd = lineStart + next.length; });
    };
    if ((e.metaKey || e.ctrlKey) && e.key === "/") {
      e.preventDefault();
      const ls = value.slice(lineStart, blockEnd).split("\n");
      const allCommented = ls.filter((l) => l.trim()).every((l) => /^\s*# ?/.test(l));
      replaceBlock((l) => {
        if (!l.trim()) return l;
        if (allCommented) return l.replace(/^(\s*)# ?/, "$1");
        const ind = /^\s*/.exec(l)![0];
        return `${ind}# ${l.slice(ind.length)}`;
      });
    } else if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      void doSave();
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (s !== end && value.slice(s, end).includes("\n")) {
        replaceBlock((l) => (e.shiftKey ? l.replace(/^ {1,2}/, "") : `  ${l}`));
      } else if (!e.shiftKey) {
        const v = value.slice(0, s) + "  " + value.slice(end);
        setText(v);
        requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
      }
    } else if (e.key === "Enter" && !e.shiftKey && !e.metaKey) {
      // keep indentation; indent one more level after "key:"
      const cur = value.slice(lineStart, s);
      let ind = /^\s*/.exec(cur)![0];
      if (/:\s*$/.test(cur)) ind += "  ";
      e.preventDefault();
      const v = value.slice(0, s) + "\n" + ind + value.slice(end);
      setText(v);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 1 + ind.length; });
    }
  }

  const errors = problems.filter((p) => p.level === "error").length;
  const warnings = problems.length - errors;

  return (
    <>
      <div className="pane grow">
        <div className="pane-head">
          <button className="btn sm" onClick={doOpen}>Open…</button>
          <button className="btn sm" onClick={() => doSave()}>{path ? "Save" : "Save…"}</button>
          <button className="btn sm ghost" onClick={() => doSave(true)}>Save as…</button>
          <button className="btn sm ghost" onClick={() => setConfirmTemplate(true)}>New from quiz</button>
          <span className="muted small mono grow ellipsis" title={path ?? ""}>
            {path ? path.split(/[\\/]/).pop() : "unsaved rubric"}
          </span>
          {dirty && <span className="badge warn">Unsaved changes</span>}
          <span className="muted small"><kbd>⌘/</kbd> comment · <kbd>⌘S</kbd> save</span>
        </div>
        <ErrorNote error={error} />
        <div className="editor">
          <div className="gutter" ref={gutter}>
            {Array.from({ length: lines }, (_, i) => (
              <div key={i} className={lineLevel.get(i + 1) ?? ""}>{i + 1}</div>
            ))}
          </div>
          <div className="code">
          <pre className="hl" aria-hidden><code ref={colored}>
            {tokens.map((line, i) => (
              <span key={i}>{line.map((t, j) => (t.kind === "plain" ? t.text : <span key={j} className={`t-${t.kind}`}>{t.text}</span>))}{"\n"}</span>
            ))}
          </code></pre>
          <textarea
            ref={ta}
            value={text}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onScroll={(e) => {
              const { scrollTop, scrollLeft } = e.currentTarget;
              if (gutter.current) gutter.current.scrollTop = scrollTop;
              if (colored.current) colored.current.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
            }}
          />
          </div>
        </div>
        <div className="problems">
          {problems.length === 0 ? (
            <div className="problem summary"><span className="good-text" style={{ fontWeight: 700 }}>✓</span><span>Rubric is valid.</span></div>
          ) : (
            <>
              <div className="problem summary">{errors} error{errors === 1 ? "" : "s"}, {warnings} warning{warnings === 1 ? "" : "s"}{errors ? ". Grading uses the last valid parts; sending is disabled until errors are fixed." : ""}</div>
              {problems.map((p, i) => (
                <div key={i} className={`problem ${p.level}`} onClick={() => p.line && jump(p.line)}>
                  <span className="lvl">{p.level === "error" ? "Error" : "Warn"}</span>
                  {p.line && <span className="muted mono" title="Click to jump to this line">line {p.line}</span>}
                  <span>{p.message}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="pane split-right">
        <div className="pane-head"><h3 className="grow">Questions</h3><span className="muted small">Click one to see its answers</span></div>
        <div className="pane-body">
          {quiz.questions.map((q) => {
            const spec = specs.get(q.id);
            let changed = 0, flagged = 0;
            for (const r of results.values()) {
              const c = r.cells[q.id];
              if (c.changed && (c.status === "graded" || c.status === "override")) changed++;
              if (c.flags.length) flagged++;
            }
            const dot = !spec ? "" : spec.keep ? "kept" : flagged ? "flag" : "graded";
            return (
              <div key={q.id} className="qrow" onClick={() => ctx.goTo("answers", { questionId: q.id })}>
                <span className="qnum">Q{q.position}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="qtext">{truncate(q.text.replace(/\s+/g, " "), 90)}</div>
                  <div className="row small muted" style={{ gap: 6, marginTop: 2 }}>
                    <span className={`dot ${dot}`} />
                    <span>{q.kind}</span>
                    <span>·</span>
                    <span>{q.pointsPossible ?? "?"} pts{q.pointsSource === "inferred" ? "*" : ""}</span>
                    {spec ? <span className="mono faint">{spec.keep ? "use: canvas" : spec.origin}</span> : <span className="faint">not in rubric</span>}
                    <span className="spacer" />
                    {changed > 0 && <span className="badge good">{changed} changed</span>}
                    {flagged > 0 && <span className="badge warn">{flagged} flagged</span>}
                  </div>
                </div>
              </div>
            );
          })}
          <div className="muted small" style={{ padding: 12 }}>* max points inferred from the best score anyone earned</div>
        </div>
      </div>

      {confirmTemplate && (
        <Modal title="Replace the rubric with a template?" onClose={() => setConfirmTemplate(false)}
          footer={<><button className="btn" onClick={() => setConfirmTemplate(false)}>Cancel</button><button className="btn primary" onClick={newFromQuiz}>Replace</button></>}>
          <p>This lists every question in <b>{quiz.title}</b> with a starter rule and the most common answers students gave. Every question starts commented out, so nothing is regraded until you enable it.</p>
          {dirty && <div className="notice warn">The current rubric has unsaved changes that will be lost.</div>}
        </Modal>
      )}
    </>
  );
}
