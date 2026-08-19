# Contributing

This is a specification first and a codebase second, so the bar for changing it is deliberately
higher than for an ordinary library.

## The one rule

**A change to a normative rule must arrive with a test vector.**

A rule stated in prose that no vector exercises is a rule two implementations will read two ways.
Section 11 of the specification is the portable part: any implementation in any language should
reproduce it, and it is how a second implementation proves it agrees with the first rather than
merely claiming to.

If you cannot write a vector for your change, that is usually evidence the change is not yet
specific enough to be normative. Propose it as a non-normative note instead.

## Versioning

| Change | Version |
|---|---|
| A normative rule changes meaning | **major** |
| A new optional key, or an added test vector | **minor** |
| Wording, examples, clarifications, typos | **patch** |

The specification will never claim a key beginning `x_`. That namespace is yours.

## Proposing a change to the specification

Open an issue before a pull request, and say three things:

1. **The document that is handled wrongly today.** A concrete example, not a category.
2. **The verdict it currently gets, and the verdict it should get.**
3. **What breaks if the rule changes.** Every rule in this specification protects against something,
   and several protect against a failure that is not obvious from the rule alone. The appendix notes
   record which. If your change removes a protection, say which one and why the trade is worth it.

Changes that make the vocabulary larger need to clear a higher bar than changes that make it
smaller. Three keys is a feature.

## Proposing a change to the reference implementation

Pull requests welcome. Two constraints that are not negotiable, because they are what makes the
reference implementation usable as a reference:

- **Zero dependencies.** No runtime imports at all.
- **No platform APIs.** No `fs`, no `path`, no `child_process`, no `process`, no DOM. The only
  globals used are `Date`, `Map` and `Set`. This is what lets a plugin depending on it run on
  mobile, where Node is unavailable.

Run both before opening a pull request:

```bash
cd reference/typescript
node --experimental-strip-types --test validity.test.ts
npx --yes -p typescript@5.7 tsc --noEmit -p tsconfig.json
```

Node 22.6 or newer. On Node 23 and later the flag is unnecessary.

## Adding an implementation in another language

Please do, and please open an issue so it can be listed in the README.

An implementation earns a listing by passing the section 11 vectors and stating its conformance
level. It does not need to be complete: a Level 1 reader is genuinely useful and is a reasonable
thing to publish.

State your deviations. The TypeScript reference implementation documents three of its own in its
README, including one where a JavaScript `Date` simply cannot represent what the specification
says. An undocumented deviation is a bug in someone else's code six months from now.

## Reporting a disagreement between implementations

This is the most valuable issue you can open. If the TypeScript reference and the Python engine
disagree about a document, at least one of them is wrong and possibly the specification is.

One such disagreement is already known and recorded as appendix note D: RE-call 0.9.5 does not
detect an empty validity window. The specification states the intended behaviour, test vector 4
covers it, and the implementation is expected to follow.

## Code of conduct

Be straightforward and assume good faith. Disagree with the argument rather than the person. That
is the whole policy.
