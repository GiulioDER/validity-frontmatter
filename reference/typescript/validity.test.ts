/**
 * Conformance tests for the Validity Frontmatter 1.0 TypeScript reference implementation.
 *
 * Sections 11.1 to 11.11 are the specification's own test vectors, verbatim. Any implementation
 * in any language should reproduce them. Everything after that is implementation detail.
 *
 * Run:  node --experimental-strip-types --test validity.test.ts
 *   or: npx tsx --test validity.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGraph,
  evaluate,
  evaluateAll,
  frontmatterSpan,
  isCurrent,
  parseDocument,
  parseValidityDate,
  readValidity,
  resolutionKey,
  terminalSuccessor,
  type EvaluateOptions,
  type ValidityDocument,
  type Verdict,
} from "./validity.ts";

/* ------------------------------------------------------------------ *
 * The specification's worked corpus (section 11)
 * ------------------------------------------------------------------ */

const day = (iso: string) => parseValidityDate(iso);

const SOURCES: Array<[id: string, text: string, recordedAt: string]> = [
  ["a.md", "---\nvalid_until: 2026-06-30\n---\n\nrate limits, first version\n", "2026-01-10"],
  ["b.md", "---\nsupersedes: [[a]]\nvalid_from: 2026-07-01\n---\n\nrate limits, revised\n", "2026-07-01"],
  ["c.md", "---\nsupersedes: b.md\n---\n\nrate limits, current\n", "2026-08-01"],
  ["d.md", "---\nvalid_from: 2026-12-01\nvalid_until: 2026-11-01\n---\n\nimpossible window\n", "2026-01-01"],
];

const CORPUS: ValidityDocument[] = SOURCES.map(
  ([id, text, recordedAt]) => parseDocument(id, text, day(recordedAt)).document,
);

const GRAPH = buildGraph(CORPUS);

function verdictOf(id: string, options: EvaluateOptions) {
  const doc = CORPUS.find((d) => d.id === id);
  assert.ok(doc, `no such document: ${id}`);
  return evaluate(doc, GRAPH, options);
}

function expect(
  id: string,
  options: EvaluateOptions,
  verdict: Verdict,
  supersededBy: string | null = null,
) {
  const result = verdictOf(id, options);
  assert.equal(result.verdict, verdict, `${id}: ${result.reason}`);
  assert.equal(result.supersededBy, supersededBy);
}

/* ------------------------------------------------------------------ *
 * Specification test vectors
 * ------------------------------------------------------------------ */

test("vector 1: a chain resolves to its terminal successor", () => {
  expect("a.md", { at: day("2026-08-19") }, "superseded", "c.md");
});

test("vector 2: a middle link is superseded by the terminal successor", () => {
  expect("b.md", { at: day("2026-08-19") }, "superseded", "c.md");
});

test("vector 3: the terminal document is ok", () => {
  expect("c.md", { at: day("2026-08-19") }, "ok");
});

test("vector 4: an empty window is invalid metadata", () => {
  expect("d.md", { at: day("2026-08-19") }, "invalid_metadata");
});

test("vector 5: edge filtering is per step, not on the terminal answer", () => {
  // The b -> c edge is asserted 2026-08-01, after the knowledge instant, so the chain stops
  // at b. Filtering only the terminal successor would wrongly answer c.
  expect("a.md", { at: day("2026-08-19"), knownAsOf: day("2026-07-15") }, "superseded", "b.md");
});

test("vector 6: a document recorded after the knowledge instant is not yet known", () => {
  expect("c.md", { at: day("2026-08-19"), knownAsOf: day("2026-07-15") }, "not_yet_known");
});

test("vector 7: not_yet_known outranks any consideration of the window", () => {
  expect("a.md", { at: day("2026-08-19"), knownAsOf: day("2026-01-05") }, "not_yet_known");
});

test("vector 8: inside its window, with no edge yet asserted, a document is ok", () => {
  expect("a.md", { at: day("2026-05-01"), knownAsOf: day("2026-06-01") }, "ok");
});

test("vector 9: known, past valid_until, not yet superseded, is expired", () => {
  expect("a.md", { at: day("2026-08-19"), knownAsOf: day("2026-06-01") }, "expired");
});

const AMBIGUOUS_CORPUS: ValidityDocument[] = [
  parseDocument("notes/policy.md", "---\ntitle: policy\n---\n").document,
  parseDocument("archive/policy.md", "---\ntitle: policy\n---\n").document,
  parseDocument("update.md", "---\nsupersedes: policy\n---\n").document,
];

test("vectors 10 and 11: every candidate of an ambiguous reference is marked", () => {
  const results = evaluateAll(AMBIGUOUS_CORPUS, { at: day("2026-08-19") });
  assert.equal(results.get("notes/policy.md")?.verdict, "ambiguous_supersession");
  assert.equal(results.get("archive/policy.md")?.verdict, "ambiguous_supersession");
  // The declaring document itself is unaffected.
  assert.equal(results.get("update.md")?.verdict, "ok");
});

test("an ambiguous reference produces no edge at all", () => {
  const graph = buildGraph(AMBIGUOUS_CORPUS);
  assert.equal(graph.claims.size, 0);
  assert.deepEqual([...graph.ambiguous].sort(), ["archive/policy.md", "notes/policy.md"]);
});

/* ------------------------------------------------------------------ *
 * Reference resolution (section 6)
 * ------------------------------------------------------------------ */

test("resolution normalises brackets, extension case, and path segments", () => {
  assert.equal(resolutionKey("[[notes/rate limits v1]]"), "rate limits v1");
  assert.equal(resolutionKey("rate_limits_v1.MD"), "rate_limits_v1");
  assert.equal(resolutionKey("  archive/old.md  "), "old");
  assert.equal(resolutionKey("[name]"), "name");
  assert.equal(resolutionKey("plain"), "plain");
});

test("all four reference styles designate the same document", () => {
  const keys = ["notes/target.md", "target", "[target]", "[[target]]"].map(resolutionKey);
  assert.deepEqual(new Set(keys), new Set(["target"]));
});

test("a dangling reference is inert and reported", () => {
  const corpus = [parseDocument("only.md", "---\nsupersedes: missing.md\n---\n").document];
  const graph = buildGraph(corpus);
  assert.equal(graph.claims.size, 0);
  assert.deepEqual(graph.dangling, [{ from: "only.md", reference: "missing.md" }]);
  assert.equal(evaluate(corpus[0], graph, { at: day("2026-08-19") }).verdict, "ok");
});

test("a self-reference declares nothing", () => {
  const corpus = [parseDocument("loop.md", "---\nsupersedes: loop\n---\n").document];
  const graph = buildGraph(corpus);
  assert.equal(graph.claims.size, 0);
  assert.equal(graph.selfClaims.length, 1);
  assert.equal(evaluate(corpus[0], graph, { at: day("2026-08-19") }).verdict, "ok");
});

/* ------------------------------------------------------------------ *
 * The supersession graph (section 7)
 * ------------------------------------------------------------------ */

test("a cycle terminates and resolves to the direct successor", () => {
  const corpus = [
    parseDocument("x.md", "---\nsupersedes: y\n---\n").document,
    parseDocument("y.md", "---\nsupersedes: x\n---\n").document,
  ];
  const graph = buildGraph(corpus);
  assert.equal(terminalSuccessor("x.md", graph), "y.md");
  assert.equal(terminalSuccessor("y.md", graph), "x.md");
});

test("a three-document cycle also terminates", () => {
  const corpus = [
    parseDocument("p.md", "---\nsupersedes: r\n---\n").document,
    parseDocument("q.md", "---\nsupersedes: p\n---\n").document,
    parseDocument("r.md", "---\nsupersedes: q\n---\n").document,
  ];
  const graph = buildGraph(corpus);
  assert.equal(terminalSuccessor("p.md", graph), "q.md");
});

test("fan-in prefers the claim asserted last", () => {
  const corpus = [
    parseDocument("base.md", "---\ntitle: base\n---\n", day("2026-01-01")).document,
    parseDocument("early.md", "---\nsupersedes: base\n---\n", day("2026-02-01")).document,
    parseDocument("late.md", "---\nsupersedes: base\n---\n", day("2026-03-01")).document,
  ];
  const graph = buildGraph(corpus);
  assert.equal(terminalSuccessor("base.md", graph), "late.md");
});

test("fan-in among undated claims is deterministic", () => {
  const corpus = [
    parseDocument("base.md", "---\ntitle: base\n---\n").document,
    parseDocument("zebra.md", "---\nsupersedes: base\n---\n").document,
    parseDocument("alpha.md", "---\nsupersedes: base\n---\n").document,
  ];
  const graph = buildGraph(corpus);
  assert.equal(terminalSuccessor("base.md", graph), "alpha.md");
});

test("an undated edge applies even when a knowledge instant is set", () => {
  const corpus = [
    parseDocument("old.md", "---\ntitle: old\n---\n", day("2026-01-01")).document,
    parseDocument("new.md", "---\nsupersedes: old\n---\n").document, // no recordedAt
  ];
  const graph = buildGraph(corpus);
  assert.equal(terminalSuccessor("old.md", graph, day("2026-02-01")), "new.md");
});

test("a document with no recorded write time stays visible under a knowledge instant", () => {
  const corpus = [parseDocument("undated.md", "---\ntitle: x\n---\n").document];
  const graph = buildGraph(corpus);
  const result = evaluate(corpus[0], graph, {
    at: day("2026-08-19"),
    knownAsOf: day("2020-01-01"),
  });
  assert.equal(result.verdict, "ok");
});

/* ------------------------------------------------------------------ *
 * Dates (section 5)
 * ------------------------------------------------------------------ */

test("valid_until is inclusive to the end of its day", () => {
  const corpus = [
    parseDocument("end.md", "---\nvalid_until: 2026-06-30\n---\n").document,
  ];
  const graph = buildGraph(corpus);
  const lastMoment = new Date(Date.UTC(2026, 5, 30, 23, 59, 59, 999));
  const justAfter = new Date(Date.UTC(2026, 6, 1, 0, 0, 0, 0));
  assert.equal(evaluate(corpus[0], graph, { at: lastMoment }).verdict, "ok");
  assert.equal(evaluate(corpus[0], graph, { at: justAfter }).verdict, "expired");
});

test("valid_from is inclusive from the start of its day", () => {
  const corpus = [parseDocument("start.md", "---\nvalid_from: 2026-07-01\n---\n").document];
  const graph = buildGraph(corpus);
  const firstMoment = new Date(Date.UTC(2026, 6, 1, 0, 0, 0, 0));
  const justBefore = new Date(Date.UTC(2026, 5, 30, 23, 59, 59, 999));
  assert.equal(evaluate(corpus[0], graph, { at: firstMoment }).verdict, "ok");
  assert.equal(evaluate(corpus[0], graph, { at: justBefore }).verdict, "not_yet_valid");
});

test("dates must be zero padded and real", () => {
  assert.throws(() => parseValidityDate("2026-2-1"));
  assert.throws(() => parseValidityDate("2026-02-30"));
  assert.throws(() => parseValidityDate("26-02-01"));
  assert.throws(() => parseValidityDate("2026/02/01"));
  assert.doesNotThrow(() => parseValidityDate("2024-02-29"));
  assert.doesNotThrow(() => parseValidityDate("0026-02-01"));
});

test("a four digit year below 100 is not remapped onto 1900", () => {
  assert.equal(parseValidityDate("0026-02-01").getUTCFullYear(), 26);
});

test("a malformed date is invalid metadata, not a crash", () => {
  const properties = readValidity("---\nvalid_from: last tuesday\n---\n");
  assert.notEqual(properties.invalid, null);
  const graph = buildGraph([{ id: "bad.md", validity: properties }]);
  const result = evaluate({ id: "bad.md", validity: properties }, graph, { at: day("2026-08-19") });
  assert.equal(result.verdict, "invalid_metadata");
});

/* ------------------------------------------------------------------ *
 * Frontmatter recognition (section 4)
 * ------------------------------------------------------------------ */

test("two thematic breaks are not a frontmatter block", () => {
  const text = "---\n\n- first point\n- second point\n---\n\nbody\n";
  assert.equal(frontmatterSpan(text), null);
  const { body } = parseDocument("rule.md", text);
  assert.equal(body, text, "the body must be returned intact");
});

test("a block declaring no key is refused", () => {
  assert.equal(frontmatterSpan("---\njust a sentence with no colon\n---\n"), null);
});

test("a real block is recognised and excluded from the body", () => {
  const text = "---\nvalid_until: 2026-06-30\ntags:\n- archive\n---\nthe body\n";
  assert.equal(frontmatterSpan(text), 4);
  const { body, document } = parseDocument("real.md", text);
  assert.equal(body, "the body\n");
  assert.equal(document.validity.validUntil?.getUTCDate(), 30);
});

test("an unclosed block is refused", () => {
  assert.equal(frontmatterSpan("---\nvalid_from: 2026-01-01\n\nno closing fence\n"), null);
});

test("a UTF-8 BOM before the opening fence is tolerated", () => {
  const text = "﻿---\nvalid_from: 2026-01-01\n---\nbody\n";
  assert.notEqual(frontmatterSpan(text), null);
  assert.notEqual(readValidity(text).validFrom, null);
});

test("unknown keys are ignored and coexist with other vocabularies", () => {
  const text = [
    "---",
    "title: Quarterly review",
    "date created: 2026-01-04",
    "tags:",
    "- work",
    "- review",
    "cssclasses: []",
    "supersedes: q3-review",
    "---",
    "body",
    "",
  ].join("\n");
  const properties = readValidity(text);
  assert.deepEqual(properties.supersedes, ["q3-review"]);
  assert.equal(properties.invalid, null);
});

test("a document with no frontmatter is unconstrained, not an error", () => {
  const properties = readValidity("# Just a note\n\nNo frontmatter here.\n");
  assert.deepEqual(properties, {
    validFrom: null,
    validUntil: null,
    supersedes: [],
    invalid: null,
  });
});

test("quoted values are unwrapped one layer", () => {
  assert.deepEqual(readValidity('---\nsupersedes: "v1.md"\n---\n').supersedes, ["v1.md"]);
  assert.equal(readValidity("---\nvalid_from: '2026-01-01'\n---\n").invalid, null);
});

test("supersedes may be a block sequence", () => {
  const text = "---\nsupersedes:\n- first.md\n- second.md\n---\n";
  assert.deepEqual(readValidity(text).supersedes, ["first.md", "second.md"]);
});

test("supersedes may be repeated", () => {
  const text = "---\nsupersedes: first.md\nsupersedes: second.md\n---\n";
  assert.deepEqual(readValidity(text).supersedes, ["first.md", "second.md"]);
});

/* ------------------------------------------------------------------ *
 * Presentation helpers (section 9.4)
 * ------------------------------------------------------------------ */

test("only ok counts as current", () => {
  assert.equal(isCurrent("ok"), true);
  for (const verdict of [
    "invalid_metadata",
    "not_yet_known",
    "ambiguous_supersession",
    "superseded",
    "expired",
    "not_yet_valid",
  ] as Verdict[]) {
    assert.equal(isCurrent(verdict), false, verdict);
  }
});

test("evaluateAll covers every document exactly once", () => {
  const results = evaluateAll(CORPUS, { at: day("2026-08-19") });
  assert.equal(results.size, CORPUS.length);
  assert.deepEqual(
    [...results.keys()].sort(),
    CORPUS.map((d) => d.id).sort(),
  );
});
