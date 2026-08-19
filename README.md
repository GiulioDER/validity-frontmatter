# Validity Frontmatter

**An open vocabulary for saying, inside a note, that the note has stopped being true.**

Three YAML keys. No product, no service, no account, no dependency. Implement it in an afternoon.

---

## The problem

A folder of notes kept over time is a record of changing beliefs, not a set of facts. Decisions get
reversed, limits get raised, experiments get falsified. The note recording the old belief is not
deleted, because deleting it would destroy the history. So the old note and its correction sit in
the corpus together.

Search cannot tell them apart. Worse, it usually prefers the wrong one:

```text
query: how many requests per second can a client make?

  cos=0.784  rate_limits_v2.md   # API rate limits (revised)
  cos=0.806  rate_limits_v1.md   # API rate limits ... limited to 100
```

The stale note scores **higher**. It is shorter, more focused and more confidently worded, so it is
the better match by every measure a ranker has. Every system that ranks on similarity serves it,
and every language model downstream narrates it as current.

No amount of ranking work fixes this. The ranker has no notion of validity to rank on, and the fact
that v2 replaced v1 is not in the text, not in the embedding and not in the filesystem.

Somebody has to write it down. This is the smallest way to write it down.

---

## The vocabulary

```yaml
---
supersedes: rate_limits_v1.md
valid_from: 2026-07-01
valid_until: 2026-12-31
---
```

| Key | Means |
|---|---|
| `supersedes` | This document replaces the one referenced. |
| `valid_from` | The content began to be true on this date. Inclusive. |
| `valid_until` | The content stopped being true after this date. Inclusive. |

All three are optional. A document declaring none of them is unconstrained, which is the normal
case and never an error. Unknown keys are ignored, so this coexists with Obsidian Properties,
Jekyll, Hugo, Dataview and anything else already in your frontmatter.

References are forgiving about form and strict about ambiguity. `target`, `target.md`, `[target]`,
`[[target]]` and `notes/target.md` all designate the same document. A reference matching **two**
documents is refused rather than guessed at, and both candidates are flagged.

---

## What an evaluator returns

Exactly one verdict per document, from seven:

| Verdict | |
|---|---|
| `ok` | Nothing declared disqualifies it. |
| `superseded` | Another document declares that it replaces this one. The successor is reported with it. |
| `expired` | Past `valid_until`. |
| `not_yet_valid` | Before `valid_from`. |
| `not_yet_known` | Had not been recorded yet, at the point in time being asked about. |
| `ambiguous_supersession` | A reference resolves to this document and at least one other. |
| `invalid_metadata` | A date is unparseable, or the declared window is empty. |

Every one of those is derivable from declared metadata and two clocks. **No verdict depends on a
score, a model, an embedding or a database**, which is the whole point: a note-taking app can
implement this specification completely, with a YAML parser and a `Date`.

---

## Read it

**→ [The specification, version 1.0](spec/1.0.md)**

Sixteen sections, eleven executable test vectors, and an appendix that states the approach's
measured weakness rather than hiding it.

## Implement it

| Language | Level | |
|---|---|---|
| **TypeScript** | 3 | [reference/typescript](reference/typescript/) — one file, zero dependencies, MIT. Runs in a browser, in Node, and in an Obsidian plugin on desktop **and mobile**. |
| **Python** | 3 | [RE-call](https://github.com/GiulioDER/RE-call), the engine this was extracted from. Apache-2.0. |

Three conformance levels, so adoption can be incremental:

- **Level 1, Reader.** Parse the keys, normalise references. No evaluation.
- **Level 2, Evaluator.** Six verdicts at a single instant. This is the level a note app should target.
- **Level 3, Bi-temporal.** Adds `not_yet_known` and point-in-time replay.

## Use it

Anyone may implement this, in any language, for any purpose, **without permission and without
attribution**. The specification and the reference implementation are both MIT licensed. There is
nothing to buy, nothing to sign up for, and no engine you are obliged to adopt.

If you ship an implementation, opening an issue so it can be listed is appreciated and is not
required.

---

## Status and versioning

Version **1.0.0**, draft. Stable enough to implement.

- A change to a normative rule requires a **major** version and MUST arrive with a test vector.
- A new optional key or an added test vector is a **minor** version.
- Wording, examples and clarifications are a **patch**.

The specification will not claim any key beginning `x_`, so that is a safe namespace for your own
extensions. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Where this came from

Extracted from [RE-call](https://github.com/GiulioDER/RE-call), a retrieval engine built for a
long-running research agent whose memory outgrew its context window and started confidently
repeating conclusions it had already disproved. Every rule here exists because that system failed a
specific way without it.

The honest limitation is stated in the specification's [appendix note A](spec/1.0.md): this
vocabulary requires a human to write `supersedes:`, and on the corpus it was designed against, 2
documents in 792 did so while 60 closed a decision only in prose. It buys precision on the edges it
has and pays for it in coverage. That trade is deliberate, because a confidently wrong supersession
edge suppresses a true document and promotes a false one, with the full weight of an explicit
declaration behind it.
