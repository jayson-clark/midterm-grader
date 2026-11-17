import { describe, expect, it } from "vitest";
import { gradeAll, gradeQuestion, overrideKey } from "./grader";
import { planWrites } from "./writeback";
import { describeSpec, parseRubric, resolveSpecs } from "./rubric";
import { parseStudentAnalysisCsv } from "./sources/newQuizzesCsv";
import { splitTopLevel, toCsv } from "./text";
import type { Question, Response } from "./types";

// Synthetic report in the New Quizzes Student Analysis layout (no real student data).
function report() {
  const head = ["Name", "ID", "SectionIDs", "SectionNames", "Submitted", "ElapsedTime", "Attempt"];
  const qs = [
    { id: "101", type: "choice", text: "What does % do?" },
    { id: "102", type: "rich-fill-blank", text: "a is `blank1`, b is `blank2`, c is `blank3`" },
    { id: "103", type: "essay", text: "Why void?" },
    { id: "104", type: "rich-fill-blank", text: "Loop: `if (x<1)` then `i++`" },
  ];
  const header = [...head];
  for (const q of qs) header.push("ItemID", "ItemType", q.text, "EarnedPoints", "Status");
  header.push("NumberOfCorrect", "NumberOfIncorrect", "NoResponse", "PointsPossible", "OverallScore");
  const row = (name: string, id: string, answers: [string, number][], total: number) => {
    const r = [name, id, "1", "Sec A", "2025-11-24 19:26:25 UTC", "01:00:00", "1"];
    answers.forEach(([a, p], i) => r.push(qs[i].id, qs[i].type, a, String(p), "Graded"));
    r.push("0", "0", "0", "12", String(total));
    return r;
  };
  return toCsv([
    header,
    row("Ada Lovelace", "1", [["Remainder", 1], ["3,1,2.90", 3], ["<p>It returns nothing, so void.</p>", 2], ["if (x <1),i++", 6]], 12),
    row("Alan Turing", "2", [["Quotient", 0], ["3,0,2.9", 2], ["<p>idk</p>", 0], ["if(x<1.0),i+=1", 3]], 5),
    row("Grace Hopper", "3", [["Remainder", 1], ["3,1,25", 2], ["", 0], ["if (x<1), i++", 6]], 9),
  ]);
}

const quiz = parseStudentAnalysisCsv(report(), "Test");

function grade(yaml: string) {
  const { rubric, problems } = parseRubric(yaml);
  expect(problems.filter((p) => p.level === "error")).toEqual([]);
  const { specs } = resolveSpecs(rubric!, quiz.questions);
  return gradeAll(quiz, specs);
}

describe("CSV source", () => {
  it("reads questions, blanks and students", () => {
    expect(quiz.questions.map((q) => q.kind)).toEqual(["choice", "fill_blank", "essay", "fill_blank"]);
    expect(quiz.questions[1].blankIds).toEqual(["blank1", "blank2", "blank3"]);
    expect(quiz.questions[3].blankIds).toEqual(["if (x<1)", "i++"]);
    expect(quiz.questions[1].pointsPossible).toBe(3);
    expect(quiz.students.map((s) => s.name)).toEqual(["Grace Hopper", "Ada Lovelace", "Alan Turing"]);
    const ada = quiz.students[1];
    expect(ada.responses["102"].parts).toEqual(["3", "1", "2.90"]);
    expect(ada.responses["103"].text).toBe("It returns nothing, so void.");
    expect(ada.responses["104"].parts).toEqual(["if (x <1)", "i++"]);
    expect(quiz.students[0].responses["103"].answered).toBe(false);
  });

  it("splits on top-level commas only", () => {
    expect(splitTopLevel('fopen("a,b", "r"),x[1,2],y')).toEqual(['fopen("a,b", "r")', "x[1,2]", "y"]);
    expect(splitTopLevel('<p style="a, b">x</p>,<p>y</p>')).toEqual(['<p style="a, b">x</p>', "<p>y</p>"]);
  });
});

describe("grading", () => {
  it("leaves questions without a rubric entry untouched", () => {
    const res = grade(`questions:\n  Q1:\n    answer: '^remainder$'\n`);
    const ada = res.get("1")!;
    expect(ada.cells["101"].status).toBe("graded");
    expect(ada.cells["102"].status).toBe("untouched");
    expect(ada.cells["102"].score).toBe(3);
    expect(ada.newScore).toBe(12);
    expect(res.get("2")!.newScore).toBe(5);
  });

  it("grades blanks with regex and numbers", () => {
    const res = grade(`
questions:
  "102":
    points: 3
    blanks:
      - '^3$'
      - answer: '^1$'
      - rules:
          - number: { value: 2.9, tolerance: 0.005 }
          - match: '^25$'
            score: 50%
            comment: units?
`);
    const turing = res.get("2")!.cells["102"];
    expect(turing.parts!.map((p) => p.score)).toEqual([1, 0, 1]);
    expect(turing.score).toBe(2);
    const hopper = res.get("3")!.cells["102"];
    expect(hopper.parts!.map((p) => p.score)).toEqual([1, 1, 0.5]);
    expect(hopper.comments).toEqual(["units?"]);
    expect(res.get("3")!.newScore).toBe(9.5);
    expect(res.get("3")!.changed).toBe(true);
  });

  it("matches code blanks whitespace-insensitively", () => {
    const res = grade(`
questions:
  Q4:
    points: 6
    blanks:
      - '^if\\s*\\(\\s*x\\s*<\\s*1(\\.0*)?\\s*\\)$'
      - ['^i\\+\\+$', '^i\\s*\\+=\\s*1$', '^\\+\\+i$']
`);
    expect(res.get("2")!.cells["104"].score).toBe(6);
    expect(res.get("2")!.newScore).toBe(8);
  });

  it("supports type-wide essay rules, sum mode and blank answers", () => {
    const res = grade(`
settings:
  blank_answers: flag
types:
  essay:
    points: 2
    mode: sum
    rules:
      - match: '\\bvoid\\b'
        score: 1
      - min_words: 5
        score: 1
    otherwise:
      score: 0
      flag: no keywords
`);
    expect(res.get("1")!.cells["103"].score).toBe(2);
    expect(res.get("2")!.cells["103"].flags).toEqual(["no keywords"]);
    expect(res.get("3")!.cells["103"].flags).toEqual(["blank answer"]);
    expect(res.get("3")!.cells["103"].score).toBe(0);
  });

  it("keeps Canvas scores with use: canvas and score: keep", () => {
    const res = grade(`
questions:
  Q1: { use: canvas }
  Q3:
    rules:
      - match: 'void'
        score: keep
    otherwise: 0
`);
    expect(res.get("1")!.cells["101"].status).toBe("kept");
    expect(res.get("1")!.cells["103"].score).toBe(2);
  });
});

describe("rubric validation", () => {
  it("reads author notes and describes specs", () => {
    const { rubric, problems } = parseRubric(`notes: |\n  Be generous.\nquestions:\n  Q2:\n    note: check units\n    blanks: ['^3$', '^1$', '^2\\.9']\n  Q1: { use: canvas }\n`);
    expect(problems).toEqual([]);
    expect(rubric!.notes).toBe("Be generous.");
    const { specs } = resolveSpecs(rubric!, quiz.questions);
    expect(specs.get("102")!.note).toBe("check units");
    expect(describeSpec(specs.get("102")!)).toBe("checks 3 blanks against the answer key");
    expect(describeSpec(specs.get("101")!)).toBe("Keeps the Canvas score");
  });

  it("treats an all-commented questions: section as empty", () => {
    const { rubric, problems } = parseRubric(`version: 1\nquestions:\n  # Q1: { answer: x }\n`);
    expect(problems).toEqual([]);
    expect(rubric!.questionKeys).toEqual([]);
  });

  it("reports bad regexes, unknown keys and unknown questions with lines", () => {
    const { rubric, problems } = parseRubric(`questions:\n  Q1:\n    answr: x\n    rules:\n      - match: '(['\n  Q99: { answer: x }\n`);
    expect(problems.some((p) => p.message.includes("invalid regex") && p.line === 5)).toBe(true);
    expect(problems.some((p) => p.message.includes('unknown key "answr"'))).toBe(true);
    const r = resolveSpecs(rubric!, quiz.questions);
    expect(r.problems.some((p) => p.message.includes("Q99"))).toBe(true);
  });

  it("supports /pattern/flags and case sensitivity", () => {
    const q: Question = { id: "1", position: 1, kind: "choice", rawType: "choice", text: "", pointsPossible: 1, pointsSource: "canvas", blankIds: [], choices: [] };
    const resp: Response = { questionId: "1", text: "Remainder", canvasPoints: 0, answered: true };
    const spec = (y: string) => resolveSpecs(parseRubric(y).rubric!, [q]).specs.get("1");
    expect(gradeQuestion(q, spec(`questions:\n  "1": { answer: '^remainder$' }`), resp).score).toBe(1);
    expect(gradeQuestion(q, spec(`settings: { case_sensitive: true }\nquestions:\n  "1": { answer: '^remainder$' }`), resp).score).toBe(0);
    expect(gradeQuestion(q, spec(`settings: { case_sensitive: true }\nquestions:\n  "1": { answer: '/^remainder$/i' }`), resp).score).toBe(1);
  });
});

describe("New Quizzes writeback plan", () => {
  const { rubric } = parseRubric(`questions:\n  Q1:\n    answer: '^remainder$'\n    otherwise: { score: 0, comment: '% gives the remainder' }\n`);
  const { specs } = resolveSpecs(rubric!, quiz.questions);
  const opts = { summaryComment: false, onlyReviewed: false, reviewed: new Set<string>() };

  it("sends rubric comments even without the score summary", () => {
    // Turing already had 0 on Q1: score unchanged, but the rubric comment still goes out.
    const plan = planWrites(quiz, gradeAll(quiz, specs), opts);
    expect(plan.map((p) => p.userId)).toEqual(["2"]);
    expect(plan[0].setTotal).toBe(false);
    expect(plan[0].summaryComment).toBe("Q1: % gives the remainder");
  });

  it("sends override comments on questions not in the rubric, with score summary when asked", () => {
    const res = gradeAll(quiz, specs, { [overrideKey("3", "103")]: { score: 1, comment: "partial credit" } });
    const plan = planWrites(quiz, res, { ...opts, summaryComment: true });
    const hopper = plan.find((p) => p.userId === "3")!;
    expect(hopper.setTotal).toBe(true);
    expect(hopper.newScore).toBe(10);
    expect(hopper.summaryComment).toBe("Q3: partial credit\nScore changes: Q3 0 → 1. Total 9 → 10.");
  });
});

describe("ordering questions", () => {
  const q: Question = { id: "9", position: 9, kind: "ordering", rawType: "ordering", text: "", pointsPossible: 5, pointsSource: "inferred", blankIds: [], choices: [] };
  const resp = (order: string[]): Response => ({ questionId: "9", text: order.join("\n\n"), parts: order, canvasPoints: 2, answered: true });
  const spec = (scoring: string) => resolveSpecs(parseRubric(`questions:\n  "9":\n    scoring: ${scoring}\n    order: ['^a', '^b', '^c', '^d', '^e']\n`).rubric!, [q]).specs.get("9");
  const moved = ["a", "c", "d", "e", "b"]; // b dragged to the end

  it("position: a point per piece in its spot", () => {
    const c = gradeQuestion(q, spec("position"), resp(moved));
    expect(c.score).toBe(1);
    expect(c.parts!.map((p) => p.score)).toEqual([1, 0, 0, 0, 0]);
  });
  it("sequence: longest run in the right order", () => {
    const c = gradeQuestion(q, spec("sequence"), resp(moved));
    expect(c.score).toBe(4);
    expect(c.parts!.map((p) => p.matched[0])).toEqual(["piece 1, in order", "piece 3, in order", "piece 4, in order", "piece 5, in order", "piece 2, out of order"]);
  });
  it("flags pieces it can't identify", () => {
    const c = gradeQuestion(q, spec("position"), resp(["a", "b", "zz", "d", "e"]));
    expect(c.score).toBe(4);
    expect(c.flags).toEqual(["piece 3 doesn't match any pattern under order:"]);
  });
});
