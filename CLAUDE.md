# Fundient Dashboard — Claude Instructions

## Secret Phrase Gates

Three separate gates control what actions are allowed. All gates reset at the start of a new session.

### EUREKA — unlocks coding + committing
Do not write or edit any code, do not run `git commit` until the user says **EUREKA**.

Until EUREKA is spoken, stay in planning mode only — scoping, questions, design decisions, reading existing code, drafting approaches. No file edits, no new files, no state-modifying commands, no commits.

Once EUREKA is said, coding and committing are unlocked for the rest of the session.

### EUREKA2 — unlocks pushing to develop
Do not run `git push origin develop`, open PRs to `develop`, or merge anything into `develop` until the user says **EUREKA2**.

Once EUREKA2 is said, pushing/PRing to `develop` is unlocked for the rest of the session.

### EUREKA3 — unlocks pushing to main
Do not run `git push origin main`, open PRs to `main`, or merge anything into `main` until the user says **EUREKA3**.

Once EUREKA3 is said, pushing/PRing to `main` is unlocked for the rest of the session.

### Summary table

| Gate | Phrase | Unlocks |
|---|---|---|
| 1 | EUREKA | Coding + committing |
| 2 | EUREKA2 | Push / PR to `develop` |
| 3 | EUREKA3 | Push / PR to `main` |

Each gate is independent. Saying EUREKA3 does not imply EUREKA or EUREKA2 — all three must be said explicitly in the session to unlock all actions.
