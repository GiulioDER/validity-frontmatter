# Changelog

Versioning policy is in [CONTRIBUTING.md](CONTRIBUTING.md). In short: a normative rule change is a
major version and must arrive with a test vector.

## 1.0.0 — 2026-08-19

Initial specification, and the TypeScript reference implementation.

- Three properties: `valid_from`, `valid_until`, `supersedes`.
- Reference resolution: forgiving about form, strict about ambiguity.
- Supersession graph: chains, cycles, self-claims, fan-in, ambiguous targets.
- Two time axes: valid time declared by the author, transaction time observed by the system.
- Seven verdicts with a defined precedence.
- Three conformance levels.
- Eleven test vectors.
