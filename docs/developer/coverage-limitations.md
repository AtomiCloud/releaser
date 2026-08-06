---
id: coverage-limitations
title: What the Coverage Gate Does Not Prove
---

# What the 100% coverage gate does and does not prove

`scripts/ci/test.sh` fails the build unless every line in the tier's scope is reported hit. That gate
is worth keeping — it caught a genuinely uncalled method during the bump-preset work and failed the
build honestly. **But it has a measured blind spot, and this note exists so nobody reads a green
`100%` as proof that a particular new line executed.**

## The measurement

**Reproduced in this repository.** A `for…of` loop over an empty array was added inside a `runPhase`
closure in `src/lib/release/release-service.ts`. The body cannot execute, and it contained a `throw`
that would have failed the suite if it had. The suite passed, so the body provably never ran — and
`lcov.info` reported its lines as hit **31, 24 and 45 times**. The gate passed at **100%**.

**The same constructs in a minimal project report correctly.** A two-file scratch project exercising a
never-entered `for…of` inside a closure, a plain never-entered `for…of`, a never-taken `if`, a
never-taken `catch`, a never-entered `while`, and a wholly uncalled function reported **every**
unexecuted body line as `0`.

⇒ **The blind spot is NOT construct-specific.** It did not follow the loop, the closure, or the branch
kind. It appeared in a large file inside a 13-file suite and not in a small one, which points at **line
attribution drifting in the lcov output** rather than at any particular syntax.

**A related signal, visible in both cases: the hit COUNTS are not trustworthy.** In the scratch project
a single test run reported 37 hits on one line. Treat `DA:` counts as "nonzero/zero" at best, and in a
large file not even that.

## What this means in practice

- **`100%` does not prove a specific line ran.** It proves nothing was reported unhit.
- **The gate still catches whole uncalled functions**, which is most of its day-to-day value. Do not
  remove it on the strength of this note.
- **`% Funcs` is reported alongside and behaved honestly** in the case above, but it is not the gate
  and has not been characterised here.

## How to actually prove a line ran

Do not reason from the coverage number. Use one of these:

1. **Sabotage.** Put a `throw` in the body you believe is covered and re-run the suite. If everything
   still passes, the body never runs — regardless of what coverage says. This is the check that found
   the blind spot, and it takes about a minute.
2. **Assert an observable effect** that can only occur if the code executed — a written file, a
   returned path, a recorded call — rather than asserting the absence of an error.
3. **Include a must-differ control**, so a test that would pass whether or not the code ran is visible
   as such.

## Scope of this note

Measured against `bun test`'s lcov output at the version pinned in this repository, on this
repository's suite. **Not** established: whether it affects other reporters, other bun versions, or
which property of a file triggers it. Extracting the logic into a named method made the same lines
report correctly on one occasion, but that was a single observation and is **not** a verified
workaround.
