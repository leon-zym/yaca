# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: use `gh issue list` with appropriate label and state filters
- **Comment**: `gh issue comment <number> --body "..."`
- **Apply/remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` handles this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

- **Map**: an issue labelled `wayfinder:map`
- **Child ticket**: a GitHub sub-issue, labelled `wayfinder:<type>`
- **Blocking**: use GitHub’s native issue dependencies when available
- **Frontier**: the first open, unblocked, unassigned child in map order
- **Claim**: `gh issue edit <number> --add-assignee @me`
- **Resolve**: comment with the answer, close the issue, then update the map’s Decisions-so-far
