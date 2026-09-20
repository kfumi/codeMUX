# Issue tracker: Local Markdown

Issues and specs (you may know a spec as a PRD) for this repo live as markdown files in `docs/` — specs in `docs/specs/`, tickets in `docs/tickets/`.

## Conventions

- Specs are flat files: `docs/specs/YYYY-MM-DD-<feature-slug>.md`; tickets are grouped per feature: `docs/tickets/<feature-slug>/`
- The spec is the matching `docs/specs/YYYY-MM-DD-<feature-slug>.md` file
- Implementation issues are one file per ticket at `docs/tickets/<feature-slug>/<NN>-<slug>.md`, numbered from `01` — never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `docs/tickets/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

Layout rationale and the full documentation index live in [docs/README.md](../README.md).
