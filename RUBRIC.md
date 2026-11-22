# Rubric format

A rubric is a YAML file that tells Midterm Grader how to score quiz answers with regular
expressions. **Only the questions a rubric covers are regraded.** Every other question keeps
its Canvas score and is never sent back to Canvas.

The fastest way to start: load a quiz, open the **Rubric** tab, click **New from quiz**. You
get every question listed (commented out) with a starter rule and the answers students
actually gave. Uncomment the ones you want with <kbd>⌘/</kbd>. The **Answers** tab shows every
distinct answer and how the current rubric scores it, updating as you type.

```yaml
version: 1
title: Midterm 2
notes: |                    # shown to graders on the Overview screen
  Flagged Q34 answers: accept any equivalent loop condition.

settings:
  case_sensitive: false     # default
  whitespace: lines         # default: trim lines, collapse runs of spaces
  blank_answers: zero       # default: a blank answer on a graded question gets 0

types:                      # rules for every question of a kind
  essay:
    rules:
      - min_words: 10
    otherwise: { score: keep, flag: too short }

questions:                  # rules for one question: by Canvas id, or Q<position>
  Q15:
    points: 1
    answer: '^\\0$'
  "93885":
    points: 8
    blanks:
      - '^if\s*\(\s*sf\[counter\]\s*<\s*1(\.0*)?\s*\)$'
      - ...
```

## Which rules apply to a question

1. `questions:` entry for it (key = the question id shown in the app, or `Q3` / `#3` by position), else
2. `types:` entry for its kind, else
3. nothing: the Canvas score stands and isn't sent.

Question kinds: `essay`, `choice`, `true_false`, `multi_answer`, `fill_blank`, `dropdown`,
`ordering`, `matching`, `numeric`, `formula`, `file_upload`, `categorization`, `hot_spot`.
Canvas's own type names work too (`essay_question`, `rich-fill-blank`, …).

## A question entry

| key | meaning |
| --- | --- |
| `points` | Max points. Needed when Canvas doesn't tell us (New Quizzes reports and TA accounts only give earned points, so the app guesses from the best score anyone got). |
| `answer` | Shorthand: full credit if the answer matches this regex (or any regex in a list). |
| `rules` | List of rules, checked in order (see below). |
| `mode` | `first` (default): the first matching rule decides. `sum`: add up every matching rule. `max`: best matching rule. |
| `start` | With `mode: sum`, the starting score, e.g. `start: full` and rules with negative `score` for deductions. |
| `otherwise` | Score when no rule matches. Default `0`. Can be `{ score, comment, flag }`. |
| `blanks` | For fill-in-the-blank / dropdown questions: rules per blank (see below). |
| `order`, `scoring` | For ordering (Parsons) questions: one pattern per piece in the correct order, and `position` or `sequence` partial credit (see below). |
| `use: canvas` | Listed, but keep Canvas's score (handy to mark "looked at, leave it"). |
| `note` | A note for graders, shown next to this question in Grade mode and on every review card. |
| `prompt` | A regex for a phrase from the question's text (case-insensitive, whitespace collapsed). Checks the entry landed on the right question, and finds it when ids or order differ. See [One rubric for every section](#one-rubric-for-every-section). |
| `case_sensitive`, `whitespace`, `blank_answers` | Override the settings for this question. |

## One rubric for every section

Each section's copy of a quiz (and a Friday version made by copying Thursday's) gets its own
question ids, so a rubric keyed by id only fits the quiz it was made from. To share one rubric:

```yaml
questions:
  Q35:                               # key by position, not id
    prompt: '45, 52, and 0'          # and check the question's text
    blanks: ['^1$', '^2$', '^0$']
```

- The question at that position (or id) is used if its text matches `prompt`.
- If it doesn't, the one question in the quiz whose text matches is used instead, with a note on
  Overview ("Q35 doesn't match its prompt; using Q36").
- If no question matches, or several do, that's an error and nothing can be sent until the
  rubric is fixed, so a rubric never silently grades the wrong question.

Pick a phrase that's distinctive and unlikely to be reworded: a variable name, a filename, the
inputs. A small wording change elsewhere in the question doesn't matter.

## Rules

A rule is either a bare regex (full credit when it matches) or a mapping. Every match key you
put in one rule must pass:

| match key | passes when |
| --- | --- |
| `match: 're'` or `match: [re1, re2]` | the answer matches any of the regexes |
| `all: [re1, re2]` | it matches every regex |
| `not: 're'` | it matches none of them |
| `equals: 'text'` | it equals the text (after trimming; case per `case_sensitive`) |
| `contains: 'text'` | it contains the text |
| `number: 5` / `number: [4.9, 5.1]` / `number: { value: 5, tolerance: 0.01 }` | the first number in the answer is in range (`tolerance` can be `"1%"`) |
| `min_words`, `max_words`, `min_length`, `max_length` | word / character counts |
| `blank: true` | the answer is empty (needs `blank_answers: rules`) |
| `canvas: full` / `zero` / `partial` | what Canvas already gave |

What the rule gives:

| key | meaning |
| --- | --- |
| `score` | `full` (default), a number of points, a percentage like `50%`, `0`, or `keep` (Canvas's score) |
| `comment` | Text sent to the student as the question comment (classic quizzes). |
| `flag` | `true` or a reason: puts the answer in **Needs review**. |
| `label` | Name shown in the app instead of the auto description. |

### Regex notes

- Patterns are JavaScript regexes. Use **single quotes** in YAML so backslashes stay literal:
  `'^\d+$'`. A literal `'` inside is written `''`.
- Matching is case-insensitive unless `case_sensitive: true`. Write `'/pattern/flags'` to set
  flags yourself, e.g. `'/^stdin$/'` (case sensitive) or `'/foo.bar/is'`.
- Anchor with `^…$` when the whole answer must match; without anchors the regex can match
  anywhere in the answer.
- Answers are compared after HTML is stripped and whitespace is tidied (`whitespace: lines`),
  so `'^if\s*\('` handles `if(` and `if (` alike.
- The **Copy regex** button on the Answers tab makes a whitespace-tolerant pattern from any answer.

## Fill-in-the-blank questions

Give rules per blank, in order, or by blank name:

```yaml
Q9:
  points: 12               # split evenly across blanks unless a blank sets its own points
  blanks:
    - '^3$'                                  # bare regex
    - ['^0$', '^-0$']                        # any of these
    - rules:                                 # full rules
        - number: 5
        - number: 25
          score: 0
          comment: c uses n after --n
    - { answer: '^2\.00$', points: 3 }
```

A blank with no rule gets its share of Canvas's score. In New Quizzes reports the blanks arrive
joined by commas; the app splits on commas outside of brackets and quotes, and flags any
answer it can't split into the right number of blanks (keeping Canvas's score for it).

## Multiple answers, ordering, matching

The answer text is the selected / ordered items, one per line. Use `(?m)`-style line anchors
via flags: `'/^int$/m'` checks that `int` was one of the picks.

## Ordering (Parsons) questions

List one pattern per piece **in the correct order**. Each pattern only has to identify its
piece, so match a line no other piece contains. Then pick how partial credit works:

```yaml
Q32:
  points: 10
  scoring: position        # or: sequence
  order:
    - '#include\s*<stdio\.h>'
    - 'char\s+team_name'
    - 'fopen\s*\(\s*"wnba_teams\.txt"'
    # ...one per piece
```

- `scoring: position`: each piece in its correct spot earns its share (points ÷ pieces, or a
  piece's own `points:`).
- `scoring: sequence`: credit for the longest run of pieces in the right relative order (gaps
  allowed). Moving one piece to the wrong place costs that piece only, not everything after it.

**Quizzes loaded from New Quizzes** already say which piece is in each slot and where it belongs,
so grading uses that and the patterns only need to be listed in the right number. There you can
skip patterns entirely with `order: key` (the quiz's own answer key):

```yaml
"134445":
  points: 10
  scoring: sequence
  order: key
```

With a CSV report there's no such data, so patterns are needed: a piece that matches no pattern,
or more than one, is flagged for review. **New from quiz**
fills in `order:` automatically from the students who got full credit.

## Essays

Regex can find key ideas, but usually you want a person to decide. The pattern that works:
keep Canvas's score and flag what's missing.

```yaml
types:
  essay:
    rules:
      - match: 'pointer|address|reference'
        score: keep
    otherwise: { score: keep, flag: no mention of pointers }
```
