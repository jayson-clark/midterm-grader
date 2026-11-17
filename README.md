# Midterm Grader

A desktop app for regrading Canvas quizzes with regex rubrics. Pick a course and quiz, load a
rubric, see how every answer scores, review each submission, and send the results to Canvas.

- **Only questions in your rubric are regraded.** Everything else keeps its Canvas score and is
  never sent.
- **Nothing reaches students without you.** If an assignment posts grades automatically, the
  app offers to switch it to manual posting (and hide visible grades) before writing anything.
- **Backups.** Current Canvas scores are saved to a JSON file before every send.

## Classic quizzes vs New Quizzes

| | Classic quizzes | New Quizzes |
| --- | --- | --- |
| Where answers come from | Canvas API, automatically | The quiz's **Student Analysis** report (CSV) you export from Canvas |
| What gets written back | Per-question scores, plus per-question comments where the rubric or a grader adds one | The assignment's **total** score, plus one **submission comment** collecting any rubric / grader comments ("Q34: …") |

New Quizzes has no public API for students' answers or for per-question scores. For those,
the new total is *Canvas total − Canvas points on rubric questions + rubric points*. The
per-question breakdown inside the quiz won't reflect it, and a later regrade inside New Quizzes
can overwrite it. Before writing, the app re-checks each student's live Canvas score and
skips anyone whose score changed since the report was exported.

To get the report: open the quiz in Canvas → **Build** (or **Moderate**) → **Reports** →
**Student Analysis** → CSV. You can also open a report without connecting to Canvas (offline
mode) to review and export grades as a CSV.

## Install / run

Prerequisites: [Node 20+](https://nodejs.org) and [Rust](https://rustup.rs). On macOS also run
`xcode-select --install`; on Windows install the
[WebView2 / MSVC prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run app        # development build, opens the app
npm run bundle     # installable app in src-tauri/target/release/bundle/
npm test           # grading engine tests
```

## Using it

The switch in the top bar picks one of two modes.

### Grade (for most instructors)

1. **Connect.** Paste your Canvas URL and an access token (Canvas → Account → Settings →
   *+ New Access Token*). The token is kept in the app's config folder on your computer and is
   only ever sent to that Canvas URL.
2. **Pick a course and a quiz.** For a New Quiz, also choose its Student Analysis CSV.
3. **Load the rubric** file (`.yaml`) the rubric author gave you.
4. **Overview** shows the author's notes, which questions the rubric regrades, and what to do next.
   If the file has mistakes or looks like it's for a different quiz, it says so in plain words.
5. **Review** one student at a time: the answer, the score change and why. Change any score or add
   a comment, then **Mark reviewed → next**. Keys: <kbd>j</kbd>/<kbd>k</kbd> next/previous, <kbd>r</kbd> toggle reviewed.
   **Gradebook** shows everyone at once.
6. **Send to Canvas…** Shows exactly what will change, can be limited to reviewed students,
   saves a backup, keeps grades hidden, and writes. Post grades from Canvas when ready.
   **Export CSV** saves the results without touching Canvas.

The rubric is re-read from its file every time you open the quiz, so if the author updates the
file (e.g. in a shared folder), you get the new version. **Reload** on the Overview does it on demand.

### Edit rubrics (for whoever writes the rubric)

- **Rubric** tab: a YAML editor that re-grades as you type, with errors and warnings by line.
  **New from quiz** writes a template listing every question and the answers students gave.
  See [RUBRIC.md](RUBRIC.md) for the format and [examples/](examples/) for a worked example.
- **Answers** tab: every distinct answer to a question (or each blank), how many students gave it,
  the rubric score vs Canvas, and which rule decided. Use it to tune regexes until every common
  answer scores the way you want. **Copy regex** turns an answer into a pattern.
- Save the `.yaml` and share it with the other graders. Put instructions for them in `notes:` (and
  per-question `note:`); they'll see them in Grade mode.

Overrides, reviewed marks and the rubric location are remembered per quiz on this computer.

## Notes

- TA accounts can't read classic quiz questions directly; the app uses quiz statistics instead,
  and max points per question are inferred. Set `points:` in the rubric where that's wrong.
- Student answers are always shown as plain text (never rendered as HTML).
- Concluded / archived courses are read-only in Canvas; sending will fail there.
