# Validity Frontmatter, TypeScript reference implementation

A complete, dependency-free implementation of
[Validity Frontmatter 1.0](../../spec/1.0.md), in one file.

**MIT licensed.** Copy [`validity.ts`](validity.ts) into your project. There is nothing to install,
nothing to configure, and no build step required beyond whatever already compiles your TypeScript.

| | |
|---|---|
| **Conformance** | Level 3 (bi-temporal evaluator) |
| **Dependencies** | None |
| **Runtime requirements** | None. No Node APIs, no filesystem, no globals beyond `Date`, `Map` and `Set`. |
| **Runs in** | Browser, Electron, Node, Deno, Bun, service worker, Obsidian desktop **and** Obsidian mobile |
| **Size** | One file, no runtime imports |

Every function is pure. The only clock read is the caller's, and it can be supplied explicitly, so
evaluation is fully deterministic and trivially testable.

---

## Quick start

```ts
import { parseDocument, evaluateAll } from "./validity.ts";

const documents = files.map((f) => parseDocument(f.path, f.text, f.firstSeen).document);
const verdicts = evaluateAll(documents, { at: new Date() });

for (const [id, result] of verdicts) {
  if (result.verdict === "superseded") {
    console.log(`${id} was replaced by ${result.supersededBy}`);
  }
}
```

That is the whole library in six lines. Everything below is detail.

---

## API

### Reading (Level 1)

```ts
frontmatterSpan(text: string): number | null
```
Index of the line closing a real frontmatter block, or `null`. Distinguishes a block from two
Markdown thematic breaks, so it never silently deletes body text. See section 4 of the spec.

```ts
readValidity(text: string): ValidityProperties
```
The three properties, parsed. A document with no block, or a block declaring none of the three
keys, is unconstrained and returns nulls with `invalid: null`. That is the normal case, never an
error. A malformed date or an empty window sets `invalid` to a human-readable reason.

```ts
parseDocument(id: string, text: string, recordedAt?: Date | null):
  { document: ValidityDocument; body: string }
```
Convenience wrapper: reads the properties and returns the body with the block removed.

`recordedAt` is **transaction time**: the first moment this document was recorded in your corpus.
Omit it for Level 2. Never take it from frontmatter, and never update it on re-index; using the
most recent write instead claims a document edited today never existed before today.

```ts
parseValidityDate(value: string, endOfDay?: boolean): Date
```
Strict `YYYY-MM-DD` in UTC. Throws on anything else, including `2026-2-1` and `2026-02-30`.

### Resolution and the graph (Levels 1 and 2)

```ts
resolutionKey(reference: string): string
buildGraph(documents: readonly ValidityDocument[]): SupersessionGraph
terminalSuccessor(id: string, graph: SupersessionGraph, knownAsOf?: Date | null): string | null
```

`buildGraph` returns `claims`, plus three diagnostic collections worth surfacing to the author:

- **`ambiguous`** — document ids targeted by a reference that matches more than one document.
  Every candidate is marked, and no edge is created. The implementation never guesses.
- **`dangling`** — references matching no document. Inert.
- **`selfClaims`** — documents claiming to supersede themselves. Always an authoring mistake.

Pass every document in the corpus to `buildGraph`, not only the ones declaring `supersedes`.
Ambiguity is a property of two documents sharing a resolution key, so it can only be detected
against the whole corpus.

### Evaluation (Levels 2 and 3)

```ts
evaluate(document, graph, options?): Evaluation
evaluateAll(documents, options?): Map<string, Evaluation>
```

`options.at` is the evaluation instant (valid time), defaulting to now.
`options.knownAsOf` is the knowledge instant (transaction time). Leaving it unset is Level 2
evaluation; setting it enables `not_yet_known` and per-step edge filtering.

An `Evaluation` carries the verdict, `supersededBy` when relevant, both bounds, and a `reason`
string. The reason is stable in meaning, not in wording; do not parse it.

### Presentation

```ts
isCurrent(verdict: Verdict): boolean
NOT_CURRENT: ReadonlySet<Verdict>
```

`isCurrent` is true only for `ok`. Section 9.4 of the spec recommends that anything else is not
handed to a language model as current fact without its verdict attached.

---

## Using it in an Obsidian plugin

```ts
import { Plugin, TFile } from "obsidian";
import { parseDocument, evaluateAll, type ValidityDocument } from "./validity";

export default class ValidityPlugin extends Plugin {
  async verdicts() {
    const files: TFile[] = this.app.vault.getMarkdownFiles();
    const documents: ValidityDocument[] = [];

    for (const file of files) {
      const text = await this.app.vault.cachedRead(file);
      // file.stat.ctime is a reasonable stand-in for transaction time in a vault. It is the
      // creation time on disk, which is not quite "first recorded in this corpus", so treat
      // point-in-time replay in a vault as approximate.
      documents.push(parseDocument(file.path, text, new Date(file.stat.ctime)).document);
    }

    return evaluateAll(documents, { at: new Date() });
  }
}
```

Two notes specific to Obsidian.

**Read the raw text, not `metadataCache.getFileCache(file)?.frontmatter`.** Obsidian's own
frontmatter parser applies its Properties type system, and it treats `[[wikilinks]]` differently
from this vocabulary, where `[[a]]`, `[a]`, `a` and `a.md` must all designate the same document
(spec section 6.1). Parsing the raw text with `readValidity` keeps behaviour identical to the
specification. `cachedRead` is the cheap read and is the right one here.

**This file is mobile safe.** It uses no Node API, so a plugin depending only on it does not need
`isDesktopOnly: true`. That matters: Obsidian mobile has no `fs`, no `path` and no
`child_process`, and every embedding-based plugin in the ecosystem disables itself there.

---

## Documented deviations

The specification requires an implementation to state where it differs, and where it makes a
choice the spec leaves open.

**1. Millisecond resolution.** `valid_until` closes at `23:59:59.999` rather than the spec's
`23:59:59.999999`, because a JavaScript `Date` has millisecond resolution. Unobservable to any
caller whose clock is also a `Date`.

**2. Fan-in tie-breaking (spec section 7.3).** Where several documents supersede the same target
and the implementation must reduce to one successor, the rule here is: the latest asserted claim
wins; an undated claim loses to any dated one; ties and all-undated sets are broken by document id
ascending. An undated claim still *applies*, it simply carries no evidence about recency, so it
should not displace a claim that does. The rule is deterministic, which is the property that
matters for a reference implementation.

**3. Flow sequences are not parsed.** `supersedes: [name]` is a wikilink-style reference in this
vocabulary, not a one-element YAML list, and section 6.1 strips those brackets during
normalisation. Block sequences (`supersedes:` followed by `- a` and `- b` lines) are supported, as
is repeating the key.

---

## Tests

38 tests, including all eleven of the specification's own test vectors.

```bash
node --experimental-strip-types --test validity.test.ts
```

Node 22.6 or newer. On Node 23 and later the flag is unnecessary. With any other toolchain:

```bash
npx tsx --test validity.test.ts
```

The eleven spec vectors are the first block of the test file and are marked as such. Any
implementation in any language should reproduce them; they are the portable part.

Verified passing on Node v22.11.0 on 2026-08-19: 38 tests, 38 passing.

### Typecheck

```bash
npx --yes -p typescript@5.7 tsc --noEmit -p tsconfig.json
```

`tsconfig.json` covers `validity.ts` only, because the library has zero dependencies and needs no
ambient types at all. The test file imports `node:test` and `node:assert`, so add `@types/node` and
put it in `include` if you want it checked too.

Verified clean on 2026-08-19 under `strict`, `noUnusedLocals`, `noUnusedParameters` and
`noImplicitOverride` with TypeScript 5.7.

---

## Relationship to RE-call

[RE-call](https://github.com/GiulioDER/RE-call) is the Python implementation this vocabulary was
extracted from, and it is the origin of the design notes in the specification's appendix. It goes
considerably further: hybrid retrieval, calibrated abstention, immutable generations, tenancy.

None of that is required to conform, and none of it is here. This file implements the whole
specification and nothing beyond it, which is the point: the vocabulary must be adoptable by
something that is not RE-call, or it is not a specification at all.

The two implementations disagree in exactly one place today, recorded as appendix note D of the
spec: RE-call 0.9.5 does not detect an empty validity window and reports `expired` or
`not_yet_valid` where this implementation reports `invalid_metadata`. Test vector 4 covers it.
This file follows the specification.
