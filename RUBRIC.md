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
| `use: canvas` | Listed, but keep Canvas's score (handy to mark "looked at, leave it"). |
| `case_sensitive`, `whitespace`, `blank_answers` | Override the settings for this question. |

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
