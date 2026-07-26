# Issue tracker: Local markdown

Issues for this repo are tracked as markdown files under `.scratch/<feature>/` in the repository itself. There is no external issue tracker (no GitHub Issues, GitLab, Jira, etc.).

## Where issues live

- Root directory: `.scratch/`
- Per-feature subdirectories: `.scratch/<feature>/`
- Each issue is one `.md` file. Suggested naming: `YYYY-MM-DD-short-slug.md` (e.g. `.scratch/agent-runtime/2026-07-25-detect-cli-version.md`).

## Workflow

- **Creating an issue:** Create a new `.md` file under the appropriate `.scratch/<feature>/` directory. If the directory doesn't exist, create it. Front-load the title as an H1; follow with a short description, acceptance criteria, and any relevant context.
- **Reading issues:** List files under `.scratch/`. Read individual `.md` files for detail.
- **Updating status:** Edit the file. Keep status inline (e.g. a `Status: open` / `Status: in-progress` / `Status: done` line near the top) rather than moving files between directories.
- **Closing:** Update the status line to `Status: done` (or `wontfix`). Do not delete the file — it serves as a historical record.

## Conventions

- One issue per file.
- Use kebab-case for slugs.
- Colocate related issues under a feature directory; create a new directory only when an issue clearly doesn't fit an existing one.
- Reference issues in commits/PRs by relative path, e.g. `.scratch/agent-runtime/2026-07-25-detect-cli-version.md`.

## Notes for skills

- `to-tickets`, `to-spec`, `qa`, and other skills should write new issues as files under `.scratch/` rather than calling `gh issue create` or any external CLI.
- When listing open issues, scan `.scratch/**/*.md` and filter by the `Status:` line.
