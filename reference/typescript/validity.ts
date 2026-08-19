/**
 * Validity Frontmatter 1.0 — TypeScript reference implementation.
 *
 * Spec: ../../spec/1.0.md
 * License: MIT. Copy this file into your project; there is nothing to install.
 *
 * Zero dependencies. No Node APIs, no filesystem, no clock reads except the caller's own.
 * Every function here is pure, so this runs unchanged in a browser, in Electron, in an
 * Obsidian plugin (desktop and mobile alike), in a service worker, or under Node.
 *
 * Conformance: Level 3 (bi-temporal evaluator). Levels 1 and 2 are the same code paths with
 * `recordedAt` and `knownAsOf` left unset.
 *
 * Two deliberate deviations from the specification's wording, both documented in the README:
 *
 *   1. `valid_until` closes at 23:59:59.999 rather than 23:59:59.999999, because a JavaScript
 *      Date has millisecond resolution. The difference is unobservable to any caller whose
 *      clock is also a Date.
 *   2. Fan-in among undated claims is broken by sorting on document id, which the spec leaves
 *      to the implementation and requires it to document. See `pickClaim`.
 */

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** The seven normative verdicts of specification section 9.1. */
export type Verdict =
  | "ok"
  | "invalid_metadata"
  | "not_yet_known"
  | "ambiguous_supersession"
  | "superseded"
  | "expired"
  | "not_yet_valid";

/** The three declared properties, after parsing. */
export interface ValidityProperties {
  /** Inclusive start of the validity window, or null when undeclared. */
  validFrom: Date | null;
  /** Inclusive end of the validity window, or null when undeclared. */
  validUntil: Date | null;
  /** References exactly as written, before normalisation. May be empty. */
  supersedes: string[];
  /**
   * Non-null when a declared property could not be parsed, or when the declared window is
   * empty. A document carrying this MUST evaluate to `invalid_metadata`, and the string is
   * the human-readable reason.
   */
  invalid: string | null;
}

/**
 * One document, as the host application sees it.
 *
 * `id` must be unique within the corpus and stable. A root-relative path is the usual choice.
 * It is NOT the resolution key: two documents may share a resolution key, and detecting that
 * is exactly what section 6.4 is for.
 *
 * `recordedAt` is transaction time: the FIRST time this document was recorded in the corpus.
 * Leave it undefined for Level 2. Never take it from frontmatter (specification section 8.2).
 */
export interface ValidityDocument {
  id: string;
  validity: ValidityProperties;
  recordedAt?: Date | null;
}

/** One assertion that some document replaces another. */
export interface Claim {
  /** id of the document that declared `supersedes`. */
  by: string;
  /** Transaction time of the declaring document, or null when unknown. */
  assertedAt: Date | null;
}

export interface SupersessionGraph {
  /** superseded document id -> the documents claiming to replace it. */
  claims: Map<string, Claim[]>;
  /** Document ids that are the target of an ambiguous reference (section 6.4). */
  ambiguous: Set<string>;
  /** References that matched no document. Inert, but worth reporting to the author. */
  dangling: Array<{ from: string; reference: string }>;
  /** Self-references, which are always an authoring mistake (section 6.3). */
  selfClaims: Array<{ from: string; reference: string }>;
}

export interface EvaluateOptions {
  /** Evaluation instant (valid time). Defaults to the moment of the call. */
  at?: Date;
  /**
   * Knowledge instant (transaction time). Leave unset for Level 2 evaluation.
   * Setting it enables `not_yet_known` and per-step edge filtering.
   */
  knownAsOf?: Date | null;
}

export interface Evaluation {
  verdict: Verdict;
  /** Terminal successor, set only when the verdict is `superseded`. */
  supersededBy: string | null;
  validFrom: Date | null;
  validUntil: Date | null;
  /** Human-readable justification. Stable in meaning, not in wording. */
  reason: string;
}

/* ------------------------------------------------------------------ *
 * Level 1: reading a frontmatter block
 * ------------------------------------------------------------------ */

/**
 * A mapping key: a quoted key, or a bare one, then a colon.
 *
 * A bare key may contain spaces (`date created:` is ordinary frontmatter) and may lead with a
 * digit or a non-ASCII letter. What it may not lead with is any character Markdown uses to
 * open a line: `#` `-` `*` `+` `>` `|` backtick and `[`. None of those is a plausible unquoted
 * key, and excluding them is what stops `**Warning**: text`, `[spec]: https://x` and
 * `> quoted: x` from reading as keys.
 *
 * `-` and `+` are readmitted when the next character is not a space, because a Markdown bullet
 * REQUIRES the space: `-k: x` is a mapping and `- k` is a list item. `*` gets no such reprieve,
 * since `*emphasis*: text` is ordinary Markdown.
 */
const KEY_LINE = /^(?:["'][^"']*["']|(?:[-+](?=\S)|[^\s:#\-*+`[>|])[^:]*)\s*:/;

/** YAML explicit key syntax. Neither `?` nor `:` opens a line in Markdown. */
const EXPLICIT_KEY = /^[?:](\s|$)/;

/** A block sequence item at column 0. Identical in text to a Markdown bullet. */
const SEQUENCE_ITEM = /^-(\s|$)/;

/** The closing bracket of a flow collection written across several lines. */
const FLOW_CLOSER = /^[\]}],?\s*$/;

/** A block sequence item together with its value. */
const SEQUENCE_VALUE = /^-\s+(.*)$/;

/** One `key: value` mapping line, with optional quoting around the key. */
const MAPPING_LINE = /^(?:"([^"]*)"|'([^']*)'|([^:]*?))\s*:\s*(.*)$/;

/**
 * Index of the line closing a real frontmatter block, or null when there is none.
 *
 * `---` opens a frontmatter block AND draws a thematic break. Testing only "line 0 is `---` and
 * some later line is `---`" pairs two rules that happen to sit either side of a section, and
 * everything between them is then silently deleted from the body.
 *
 * A block is recognised only when every line before the closing fence is a plausible member AND
 * at least one of them is a key. That last clause is what keeps two adjacent rules apart. Order
 * carries the weight: `- archive` and `# Notes` are a sequence item and a comment, and also a
 * bullet and a heading, with nothing in the text to tell them apart. A sequence belongs to the
 * key that opened it, so it counts only after one has been seen.
 *
 * Known limit, stated plainly because the rule reads more generously than it is: one key
 * unlocks the rest of the block. A prose section led by a key-shaped line is still paired. The
 * bar for "key shaped" is low, because allowing spaces inside a key means any sentence with a
 * colon in it qualifies. What this reliably protects is a section whose first non-blank line is
 * a heading, a bullet, a blockquote, a link reference definition, a table row, or a sentence
 * with no colon in it.
 */
export function frontmatterSpan(text: string): number | null {
  const lines = text.split("\n");
  if (lines.length === 0) return null;
  // Tolerate a UTF-8 BOM: editors add one, and a BOM that silently disabled frontmatter would
  // mean validity metadata lost with no signal.
  if (lines[0].replace(/^﻿/, "").trim() !== "---") return null;

  let seenKey = false;
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.trim();
    if (stripped === "---") return seenKey ? i : null;
    if (stripped === "") continue;
    if (raw !== raw.replace(/^\s+/, "")) continue; // indented: a continuation
    if (KEY_LINE.test(stripped) || EXPLICIT_KEY.test(stripped)) {
      seenKey = true;
      continue;
    }
    if (
      seenKey &&
      (stripped.startsWith("#") || SEQUENCE_ITEM.test(stripped) || FLOW_CLOSER.test(stripped))
    ) {
      continue;
    }
    return null; // an implausible member: this is not a block
  }
  return null; // never closed
}

/** Strip one layer of matching quotes. `supersedes: "v1.md"` is a common YAML habit. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parse the mapping lines of a frontmatter block into key -> values.
 *
 * Scalars and block sequences are both supported, so `supersedes: a` and a `supersedes:` key
 * followed by `- a` / `- b` lines both work. FLOW sequences are deliberately NOT parsed:
 * `supersedes: [name]` is a wikilink-style reference in this vocabulary, not a one-element
 * list, and specification section 6.1 strips those brackets during normalisation.
 */
function parseMapping(lines: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let currentKey: string | null = null;

  const push = (key: string, value: string) => {
    const existing = out.get(key);
    if (existing) existing.push(value);
    else out.set(key, [value]);
  };

  for (const raw of lines) {
    const stripped = raw.trim();
    if (stripped === "" || stripped.startsWith("#")) continue;

    const item = stripped.match(SEQUENCE_VALUE);
    if (item && currentKey !== null) {
      const value = unquote(item[1].trim());
      if (value !== "") push(currentKey, value);
      continue;
    }

    const pair = stripped.match(MAPPING_LINE);
    if (!pair) {
      currentKey = null;
      continue;
    }
    const key = (pair[1] ?? pair[2] ?? pair[3] ?? "").trim();
    const value = unquote(pair[4].trim());
    currentKey = key;
    if (value !== "") push(key, value);
  }
  return out;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a strict `YYYY-MM-DD` date as UTC.
 *
 * `endOfDay` selects the inclusive end bound (23:59:59.999) rather than the inclusive start
 * (00:00:00.000). Throws on anything that is not a real, zero-padded calendar date, so
 * `2026-2-1` and `2026-02-30` are both rejected.
 */
export function parseValidityDate(value: string, endOfDay = false): Date {
  const m = value.trim().match(ISO_DATE);
  if (!m) throw new Error(`expected YYYY-MM-DD, got ${JSON.stringify(value)}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  // setUTCFullYear rather than Date.UTC, because Date.UTC maps a two-digit year onto 1900 and
  // a four-digit regex still admits `0026`.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`not a real calendar date: ${JSON.stringify(value)}`);
  }
  return date;
}

/**
 * Read the three validity properties out of a document's raw text.
 *
 * A document with no frontmatter block, or a block declaring none of the three keys, is
 * unconstrained. That is the normal case and is never an error.
 *
 * A malformed date, or a window whose start is after its end, sets `invalid`. The caller does
 * not have to check it: `evaluate` reports `invalid_metadata` for any document carrying one.
 */
export function readValidity(text: string): ValidityProperties {
  const unconstrained: ValidityProperties = {
    validFrom: null,
    validUntil: null,
    supersedes: [],
    invalid: null,
  };

  const span = frontmatterSpan(text);
  if (span === null) return unconstrained;

  const mapping = parseMapping(text.split("\n").slice(1, span));

  let validFrom: Date | null = null;
  let validUntil: Date | null = null;

  const rawFrom = mapping.get("valid_from")?.[0];
  const rawUntil = mapping.get("valid_until")?.[0];

  try {
    if (rawFrom !== undefined) validFrom = parseValidityDate(rawFrom, false);
  } catch (err) {
    return { ...unconstrained, invalid: `bad valid_from: ${(err as Error).message}` };
  }
  try {
    if (rawUntil !== undefined) validUntil = parseValidityDate(rawUntil, true);
  } catch (err) {
    return { ...unconstrained, invalid: `bad valid_until: ${(err as Error).message}` };
  }

  if (validFrom !== null && validUntil !== null && validFrom.getTime() > validUntil.getTime()) {
    return {
      validFrom,
      validUntil,
      supersedes: [],
      invalid: "empty validity window: valid_from is after valid_until",
    };
  }

  return {
    validFrom,
    validUntil,
    supersedes: mapping.get("supersedes") ?? [],
    invalid: null,
  };
}

/** Convenience: read validity and return the body with the frontmatter block removed. */
export function parseDocument(
  id: string,
  text: string,
  recordedAt?: Date | null,
): { document: ValidityDocument; body: string } {
  const span = frontmatterSpan(text);
  const body = span === null ? text : text.split("\n").slice(span + 1).join("\n");
  return {
    document: { id, validity: readValidity(text), recordedAt: recordedAt ?? null },
    body,
  };
}

/* ------------------------------------------------------------------ *
 * Section 6: reference resolution
 * ------------------------------------------------------------------ */

/**
 * Normalise a reference or a document id to the key both sides are compared on.
 *
 * Forgiving about form, because a reference is written by hand and the failure that actually
 * happens is a well-formed reference in an unexpected style. Strict about ambiguity, which is
 * handled in `buildGraph`, because there the corpus genuinely does not determine an answer.
 *
 *   "[[notes/rate limits v1]]" -> "rate limits v1"
 *   "rate_limits_v1.MD"        -> "rate_limits_v1"
 *   "  archive/old.md  "       -> "old"
 */
export function resolutionKey(reference: string): string {
  let v = reference.trim();
  while (v.length >= 2 && v.startsWith("[") && v.endsWith("]")) {
    v = v.slice(1, -1).trim();
  }
  if (v.toLowerCase().endsWith(".md")) v = v.slice(0, -3);
  const segments = v.split("/");
  return segments[segments.length - 1].trim();
}

/* ------------------------------------------------------------------ *
 * Section 7: the supersession graph
 * ------------------------------------------------------------------ */

/**
 * Build the supersession graph for a corpus.
 *
 * Every document in `documents` contributes its resolution key, whether or not it declares
 * anything, because ambiguity is a property of two documents sharing a key and must be
 * detected against the whole corpus rather than against the declaring subset.
 */
export function buildGraph(documents: readonly ValidityDocument[]): SupersessionGraph {
  const byKey = new Map<string, string[]>();
  for (const doc of documents) {
    const key = resolutionKey(doc.id);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(doc.id);
    else byKey.set(key, [doc.id]);
  }

  const claims = new Map<string, Claim[]>();
  const ambiguous = new Set<string>();
  const dangling: Array<{ from: string; reference: string }> = [];
  const selfClaims: Array<{ from: string; reference: string }> = [];

  for (const doc of documents) {
    for (const reference of doc.validity.supersedes) {
      const matches = byKey.get(resolutionKey(reference)) ?? [];

      if (matches.length === 0) {
        // Dangling. Inert by section 6.2, but the author should hear about it.
        dangling.push({ from: doc.id, reference });
        continue;
      }
      if (matches.length > 1) {
        // Ambiguous. Do not guess: mark every candidate so the read path fails closed.
        // Dropping the edge silently would leave a possibly superseded document reading as
        // `ok`, which is the exact wrong answer this vocabulary exists to prevent.
        for (const id of matches) ambiguous.add(id);
        continue;
      }
      const target = matches[0];
      if (target === doc.id) {
        selfClaims.push({ from: doc.id, reference });
        continue;
      }
      const claim: Claim = { by: doc.id, assertedAt: doc.recordedAt ?? null };
      const bucket = claims.get(target);
      if (bucket) bucket.push(claim);
      else claims.set(target, [claim]);
    }
  }

  return { claims, ambiguous, dangling, selfClaims };
}

/**
 * Choose one claim where several documents supersede the same target (section 7.3).
 *
 * The specification requires an implementation that reduces to a single successor to document
 * its rule. This one is: **among eligible claims, the latest asserted wins; an undated claim
 * loses to any dated one; ties and all-undated sets are broken by document id ascending, so
 * the result is deterministic.**
 *
 * Undated losing to dated is deliberate. An undated claim still APPLIES (section 8.3), it just
 * carries no evidence about recency, so it should not displace a claim that does.
 */
function pickClaim(candidates: readonly Claim[]): Claim {
  return candidates.reduce((best, candidate) => {
    const a = candidate.assertedAt;
    const b = best.assertedAt;
    if (a !== null && b === null) return candidate;
    if (a === null && b !== null) return best;
    if (a !== null && b !== null && a.getTime() !== b.getTime()) {
      return a.getTime() > b.getTime() ? candidate : best;
    }
    return candidate.by < best.by ? candidate : best;
  });
}

/** One step along the chain, honouring the knowledge instant if there is one. */
function step(id: string, graph: SupersessionGraph, knownAsOf: Date | null): string | null {
  const candidates = graph.claims.get(id);
  if (!candidates || candidates.length === 0) return null;

  // An edge with no recorded assertion time applies unconditionally. That is the inverse of
  // the rule for a document with no recorded write time, and deliberately so: both fail
  // closed. Ignoring an undated edge would serve a memory the corpus marks as stale, while
  // hiding an undated document would silently empty results for corpora predating the record.
  const eligible =
    knownAsOf === null
      ? candidates
      : candidates.filter(
          (c) => c.assertedAt === null || c.assertedAt.getTime() <= knownAsOf.getTime(),
        );

  if (eligible.length === 0) return null;
  return pickClaim(eligible).by;
}

/**
 * Terminal successor of `id`, or null when it has none.
 *
 * The filter is applied per STEP rather than to the final answer. In a chain a -> b -> c where
 * only the first edge predates the knowledge instant, the answer is `b`. Gating the terminal
 * successor instead would answer `c`, a document that had not yet superseded anything.
 *
 * A cycle cannot loop: the walk stops on the first revisit and the cycle member resolves to its
 * direct successor.
 */
export function terminalSuccessor(
  id: string,
  graph: SupersessionGraph,
  knownAsOf: Date | null = null,
): string | null {
  const first = step(id, graph, knownAsOf);
  if (first === null) return null;

  const seen = new Set<string>([id, first]);
  let current = first;
  for (;;) {
    const next = step(current, graph, knownAsOf);
    if (next === null) return current;
    if (seen.has(next)) return first; // cycle: fall back to the direct successor
    seen.add(next);
    current = next;
  }
}

/* ------------------------------------------------------------------ *
 * Section 9: evaluation
 * ------------------------------------------------------------------ */

/**
 * Evaluate one document against the corpus graph. Returns exactly one verdict.
 *
 * Precedence, per specification section 9.2:
 *
 *   invalid_metadata > not_yet_known > ambiguous_supersession > superseded
 *                    > expired | not_yet_valid > ok
 *
 * `not_yet_known` outranks `superseded` because a document that did not exist at the knowledge
 * instant cannot meaningfully have a fate; reporting one would describe what later happened to
 * a document the caller is not allowed to see.
 */
export function evaluate(
  document: ValidityDocument,
  graph: SupersessionGraph,
  options: EvaluateOptions = {},
): Evaluation {
  const at = options.at ?? new Date();
  const knownAsOf = options.knownAsOf ?? null;
  const { validFrom, validUntil, invalid } = document.validity;
  const bounds = { validFrom, validUntil };

  if (invalid !== null) {
    return { verdict: "invalid_metadata", supersededBy: null, ...bounds, reason: invalid };
  }

  if (knownAsOf !== null) {
    const recordedAt = document.recordedAt ?? null;
    // A document with no recorded write time is left visible rather than hidden. Defaulting an
    // unknown write time to "after the instant" would silently empty result sets for corpora
    // whose data predates the record.
    if (recordedAt !== null && recordedAt.getTime() > knownAsOf.getTime()) {
      return {
        verdict: "not_yet_known",
        supersededBy: null,
        ...bounds,
        reason: `not recorded until ${iso(recordedAt)}, after the knowledge instant ${iso(knownAsOf)}`,
      };
    }
  }

  if (graph.ambiguous.has(document.id)) {
    return {
      verdict: "ambiguous_supersession",
      supersededBy: null,
      ...bounds,
      reason:
        "a supersession reference resolves to this document and to at least one other; disambiguate before trusting it",
    };
  }

  const successor = terminalSuccessor(document.id, graph, knownAsOf);
  if (successor !== null) {
    return {
      verdict: "superseded",
      supersededBy: successor,
      ...bounds,
      reason: `replaced by ${successor}; consult the successor, not this document`,
    };
  }

  if (validUntil !== null && at.getTime() > validUntil.getTime()) {
    return {
      verdict: "expired",
      supersededBy: null,
      ...bounds,
      reason: `valid until ${iso(validUntil)}, which is before ${iso(at)}`,
    };
  }
  if (validFrom !== null && at.getTime() < validFrom.getTime()) {
    return {
      verdict: "not_yet_valid",
      supersededBy: null,
      ...bounds,
      reason: `not valid until ${iso(validFrom)}, which is after ${iso(at)}`,
    };
  }

  return {
    verdict: "ok",
    supersededBy: null,
    ...bounds,
    reason: "no declared constraint disqualifies this document",
  };
}

/** Evaluate a whole corpus in one pass. Builds the graph once. */
export function evaluateAll(
  documents: readonly ValidityDocument[],
  options: EvaluateOptions = {},
): Map<string, Evaluation> {
  const graph = buildGraph(documents);
  const out = new Map<string, Evaluation>();
  for (const document of documents) {
    out.set(document.id, evaluate(document, graph, options));
  }
  return out;
}

/**
 * Verdicts that mean a document should not be presented as current fact without its verdict
 * attached (specification section 9.4).
 */
export const NOT_CURRENT: ReadonlySet<Verdict> = new Set<Verdict>([
  "invalid_metadata",
  "not_yet_known",
  "ambiguous_supersession",
  "superseded",
  "expired",
  "not_yet_valid",
]);

/** True when the verdict means the document may be used as current fact. */
export function isCurrent(verdict: Verdict): boolean {
  return !NOT_CURRENT.has(verdict);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
