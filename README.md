# Midterm Grader

A desktop app for regrading Canvas quizzes with regex rubrics. Pick a course and quiz, load a
rubric, see how every answer scores, review each submission, and send the results to Canvas.

- **Only questions in your rubric are regraded.** Everything else keeps its Canvas score and is
  never sent.
- **No setup.** Sign in with your normal Canvas login; no access token needed.
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

## Building installers

GitHub Actions builds both installers (see `.github/workflows/build.yml`):

| Platform | File | Notes |
| --- | --- | --- |
| macOS (Apple Silicon + Intel) | `Midterm Grader_<version>_universal.dmg` | |
| Windows 10/11 (x64) | `Midterm Grader_<version>_x64-setup.exe` (or `.msi`) | Installs per-user, no admin needed |

- **Any push to `main`** (or **Run workflow** on the Actions tab) builds both. Download them from
  the run's **Artifacts** section.
- **Pushing a version tag** (`git tag v0.1.0 && git push --tags`) also creates a *draft* GitHub
  Release with the installers attached. Publish it to share a download link. Bump `version` in
  `src-tauri/tauri.conf.json` and `package.json` first.

The builds aren't code-signed, so the first launch shows a warning:

- **macOS**: "Apple could not verify…". Right-click the app → **Open** → **Open** (once). If macOS
  says the app is damaged, run `xattr -cr "/Applications/Midterm Grader.app"` in Terminal.
- **Windows**: SmartScreen "Windows protected your PC". Click **More info** → **Run anyway**.

Signing with an Apple Developer ID / Windows code-signing certificate removes these warnings.

To build locally on a Mac: `npm run bundle -- --target universal-apple-darwin`
(needs `rustup target add x86_64-apple-darwin` once).

## Using it

The switch in the top bar picks one of two modes.

### Grade (for most instructors)

1. **Connect.** Click **Sign in with Canvas** and log in with your normal school login in the
   window that opens. The app uses that sign-in only to talk to your Canvas site; nothing is read
   from your web browser. If the session expires, a banner offers **Sign in again** without losing
   your work. (Alternatively, open *Use an access token instead* and paste a token from Canvas →
   Account → Settings → *+ New Access Token*; it's stored only on this computer.)
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
