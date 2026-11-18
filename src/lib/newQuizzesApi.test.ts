import { describe, expect, it } from "vitest";
import { collectAnswerKey, defsFromSessionItems, participantSessionFromUrl, responseFromResult, type ApiItemResult, type ApiSessionItem } from "./sources/newQuizzesApi";
import { buildNqResultsPayload, camelizeKeys } from "./writeback";
import { gradeQuestion } from "./grader";
import { parseRubric, resolveSpecs } from "./rubric";

// Shapes copied from real New Quizzes responses (values made up).
const B1 = "b4bde7b6-6a85-4afc-a743-e6326d2c7ef8";
const B2 = "960a51d0-fc10-478f-afd5-0b8741f1080c";
const C1 = "8a93c214-29b9-430f-a802-8ad936efbd59";
const C2 = "71e93893-3cb8-46d6-bee5-4ac1df4ded7c";
const O1 = "a97a3c7a-8bff-4d38-86e2-4abcb5186d0d";
const O2 = "be3df78f-3405-4644-b750-30460eea2544";
const O3 = "721e3c4b-1f56-4817-88cf-9b0390f11f1b";

const items: ApiSessionItem[] = [
  { position: 3, question_number: 3, points_possible: 2, item: { id: "300", item_body: "<p>Fill: `a` then `b`</p>", interaction_type: { slug: "rich-fill-blank" }, interaction_data: { blanks: [{ id: B1 }, { id: B2 }] } } },
  { position: 1, question_number: 1, points_possible: 1, item: { id: "100", item_body: "<p>What does % do?</p>", interaction_type: { slug: "choice" }, interaction_data: { choices: [{ id: C1, item_body: "<p>Remainder</p>" }, { id: C2, item_body: "Quotient" }] } } },
  { position: 2, question_number: 2, points_possible: 1, item: { id: "200", interaction_type: { slug: "true-false" }, interaction_data: {} } },
  { position: 4, question_number: 4, points_possible: 3, item: { id: "400", interaction_type: { slug: "ordering" }, interaction_data: { choices: { [O1]: { id: O1, item_body: "<div>first()</div>" }, [O2]: { id: O2, item_body: "<div>second()</div>" }, [O3]: { id: O3, item_body: "<div>third()</div>" } } } } },
  { position: 5, question_number: 5, points_possible: 2, item: { id: "500", interaction_type: { slug: "essay" }, interaction_data: {} } },
  { position: 6, points_possible: 0, item: null }, // stimulus
];

const results: ApiItemResult[] = [
  { item_id: "300", position: 3, points_possible: 2, score: 1, grading_method: "autograde", feedback: { item_feedback: {} }, scored_data: { correct: false, value: {
    [B2]: { correct: false, correct_answer: ["else if(x<1.5)", "if(x<1.5)"], result_score: 0, user_response: "else if (x < 1.5)" },
    [B1]: { correct: true, correct_answer: "if (x<1)", result_score: 1, user_response: "if (x<1)" },
  } } },
  { item_id: "100", position: 1, points_possible: 1, score: 1, scored_data: { value: { [C1]: { result_score: 1, user_responded: true } } } },
  { item_id: "200", position: 2, points_possible: 1, score: 0, scored_data: { value: { false: { result_score: 0, user_responded: true } } } },
  { item_id: "400", position: 4, points_possible: 3, score: 0, scored_data: { correct: false, value: [
    // value = the correct chunk for the slot, user_responded = what the student put there
    { id: 1, result_score: 0, user_responded: O3, value: O2 },
    { id: 0, result_score: 1, user_responded: O1, value: O1 },
    { id: 2, result_score: 0, user_responded: O2, value: O3 },
  ] } },
  { item_id: "500", position: 5, points_possible: 2, score: 2, scored_data: { value: "<p>It returns <b>nothing</b>.</p>" } },
];

const defs = defsFromSessionItems(items);
const resp = (id: string) => responseFromResult(defs.get(id), results.find((r) => r.item_id === id)!);

describe("New Quizzes API parsing", () => {
  it("builds questions in order, skipping stimuli", () => {
    const qs = [...defs.values()].map((d) => d.question).sort((a, b) => a.position - b.position);
    expect(qs.map((q) => [q.id, q.kind, q.pointsPossible])).toEqual([
      ["100", "choice", 1], ["200", "true_false", 1], ["300", "fill_blank", 2], ["400", "ordering", 3], ["500", "essay", 2],
    ]);
  });

  it("reads each answer type", () => {
    expect(resp("100")).toMatchObject({ text: "Remainder", canvasPoints: 1, answered: true });
    expect(resp("200")).toMatchObject({ text: "false", answered: true });
    expect(resp("300").parts).toEqual(["if (x<1)", "else if (x < 1.5)"]); // in blank order, not key order
    expect(resp("400").parts).toEqual(["first()", "third()", "second()"]); // slot order
    expect(resp("500")).toMatchObject({ text: "It returns nothing.", answered: true });
  });

  it("collects the answer key per blank", () => {
    expect(collectAnswerKey(defs.get("300")!, results)).toEqual([["if (x<1)"], ["else if(x<1.5)", "if(x<1.5)"]]);
  });

  it("works with the existing Parsons rubric format", () => {
    const q = defs.get("400")!.question;
    const { rubric } = parseRubric(`questions:\n  "400":\n    scoring: sequence\n    order: ['^first', '^second', '^third']\n`);
    const spec = resolveSpecs(rubric!, [q]).specs.get("400");
    expect(gradeQuestion(q, spec, resp("400")).score).toBe(2);
  });
});

describe("New Quizzes save payload", () => {
  it("camelizes snake_case keys only, leaving ids and UUIDs alone", () => {
    expect(camelizeKeys({ scored_data: { value: { [B1]: { user_response: "x", correct_answer: ["a"] } } }, false: 1, "1": 2 }))
      .toEqual({ scoredData: { value: { [B1]: { userResponse: "x", correctAnswer: ["a"] } } }, false: 1, "1": 2 });
  });

  it("resends every result, changing only the requested scores", () => {
    const body = buildNqResultsPayload(results, new Map([["400", 2]])) as Record<string, unknown>[];
    expect(body).toHaveLength(results.length);
    expect(body.map((r) => r.score)).toEqual([1, 1, 0, 2, 2]);
    expect(body[0]).not.toHaveProperty("gradingMethod");
    expect(body[0]).not.toHaveProperty("grading_method");
    expect(body[0]).toMatchObject({ itemId: "300", pointsPossible: 2, feedback: { itemFeedback: {} } });
    expect((body[0].scoredData as { value: Record<string, unknown> }).value[B1]).toMatchObject({ userResponse: "if (x<1)" });
  });
});

describe("template from the New Quizzes answer key", () => {
  it("uses accepted answers for blank patterns", async () => {
    const { buildTemplate } = await import("./template");
    const q = { ...defs.get("300")!.question, answerKey: collectAnswerKey(defs.get("300")!, results) };
    const quiz = { source: "new_quizzes_api" as const, title: "T", pointsPossible: 2, postManually: null, questions: [q], notes: [],
      students: [{ userId: "1", name: "A B", sortableName: "B, A", attempt: 1, canvasScore: 1, submittedAt: null, responses: { "300": resp("300") } }] };
    const t = buildTemplate(quiz);
    const block = t.split("\n").filter((l) => l.includes("# key:")).map((l) => l.replace(/^\s*#\s*/, ""));
    expect(block[0]).toContain("'^if\\s*\\(\\s*x\\s*<\\s*1(?:\\.0*)?\\s*\\)$'");
    expect(block[1]).toMatch(/^- \['\^else\\s\*if/);
    const yaml = "questions:\n  \"300\":\n    blanks:\n" + block.map((l) => "      " + l).join("\n");
    const { rubric, problems } = parseRubric(yaml);
    expect(problems.filter((p) => p.level === "error")).toEqual([]);
    const spec = resolveSpecs(rubric!, [q]).specs.get("300");
    expect(gradeQuestion(q, spec, resp("300")).score).toBe(2); // "else if (x < 1.5)" now matches the key
  });
});

describe("ordering answer key", () => {
  it("takes the correct order from each slot's value", () => {
    expect(collectAnswerKey(defs.get("400")!, results)).toEqual([["first()"], ["second()"], ["third()"]]);
  });

  it("builds order: from the key even when nobody got full credit", async () => {
    const { buildTemplate } = await import("./template");
    const d = defs.get("400")!;
    const q = { ...d.question, answerKey: collectAnswerKey(d, results) };
    const quiz = { source: "new_quizzes_api" as const, title: "T", pointsPossible: 3, postManually: null, questions: [q], notes: [],
      students: [{ userId: "1", name: "A B", sortableName: "B, A", attempt: 1, canvasScore: 0, submittedAt: null, responses: { "400": resp("400") } }] };
    const lines = buildTemplate(quiz).split("\n");
    expect(lines.some((l) => l.includes("from the quiz's answer key"))).toBe(true);
    const start = lines.findIndex((l) => l.includes('# "400":'));
    const block = lines.slice(start).filter((l, i) => i === 0 || (l.startsWith("  # ") && !l.startsWith("  # ──"))).map((l) => l.replace(/^(\s*)# ?/, "$1"));
    const { rubric, problems } = parseRubric("questions:\n" + block.join("\n"));
    expect(problems.filter((p) => p.level === "error")).toEqual([]);
    const spec = resolveSpecs(rubric!, [q]).specs.get("400");
    const cell = gradeQuestion(q, spec, resp("400"));
    expect(cell.flags).toEqual([]);
    expect(cell.score).toBe(1); // first() is in its spot; second()/third() are swapped
  });
});

describe("ordering from New Quizzes' own slot data", () => {
  it("records each slot's correct position", () => {
    expect(resp("400").orderIndex).toEqual([0, 2, 1]);
  });
  it("grades with order: key and ignores unrecognizable patterns", () => {
    const q = defs.get("400")!.question;
    const keyed = resolveSpecs(parseRubric(`questions:\n  "400": { order: key }\n`).rubric!, [q]).specs.get("400");
    expect(gradeQuestion(q, keyed, resp("400"))).toMatchObject({ score: 1, flags: [] });
    const bad = resolveSpecs(parseRubric(`questions:\n  "400":\n    order: ['zzz', 'yyy', 'xxx']\n`).rubric!, [q]).specs.get("400");
    expect(gradeQuestion(q, bad, resp("400"))).toMatchObject({ score: 1, flags: [] });
  });
  it("order: key flags instead of guessing when there's no slot data (CSV)", () => {
    const q = defs.get("400")!.question;
    const keyed = resolveSpecs(parseRubric(`questions:\n  "400": { order: key }\n`).rubric!, [q]).specs.get("400");
    const csvResp = { ...resp("400"), orderIndex: undefined };
    expect(gradeQuestion(q, keyed, csvResp).flags[0]).toMatch(/answer key/);
  });
  it("finds the attempt id in a Canvas submission URL", () => {
    expect(participantSessionFromUrl("https://osu.instructure.com/courses/1/external_tools/retrieve?assignment_id=2&url=https%3A%2F%2Fosu.quiz-lti-iad-prod.instructure.com%2Flti%2Flaunch%3Fparticipant_session_id%3D1113009%26quiz_session_id%3D1123864")).toBe("1113009");
    expect(participantSessionFromUrl("not a url")).toBeNull();
  });
});
