Real Vitest 5 JUnit reports of the Course Desk server (`examples/reference-app`), produced with
`npx vitest run --reporter=junit --outputFile=<file>` in `server/`:

- `vitest-pass.xml`: the unmodified fixture, all 8 cases pass.
- `vitest-fail-skip.xml`: "rejects an enrollment into a full course…" made to fail (expected
  `COURSE_FULL_X`) and "rejects a repeat enrollment…" skipped with `it.skip`.

Paths in them are relative to `server/`, so they are read with root `server`.
