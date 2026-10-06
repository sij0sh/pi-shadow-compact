# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `sij0sh/pi-shadow-compact`.
Use the `gh` CLI for all operations.
Run commands inside this clone so `gh` resolves the repository from the remote.

## Conventions

- Create: `gh issue create --title "..." --body "..."`.
- Use a heredoc for multiline issue bodies.
- Read: `gh issue view <number> --comments`.
- Fetch labels and structured data with `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`.
- Add appropriate `--label` and `--state` filters when listing issues.
- Comment: `gh issue comment <number> --body "..."`.
- Apply labels: `gh issue edit <number> --add-label "..."`.
- Remove labels: `gh issue edit <number> --remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

## Pull requests as a triage surface

PRs as a request surface: no.

GitHub shares one number space across issues and pull requests.
Resolve an ambiguous number with `gh pr view <number>`.
Fall back to `gh issue view <number>` if it is not a pull request.

## Skill operations

When a skill says "publish to the issue tracker", create a GitHub issue.
When a skill says "fetch the relevant ticket", run `gh issue view <number> --comments`.

## Wayfinding operations

The map is one issue labeled `wayfinder:map`.
Its body contains Notes, Decisions-so-far, and Fog.
Create it with `gh issue create --label wayfinder:map`.

Link child tickets to the map with GitHub sub-issues.
If sub-issues are unavailable, list children in the map's task list.
Put `Part of #<map>` at the top of each fallback child body.
Label children `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.

Record blockers with GitHub native issue dependencies:
`gh api --method POST repos/sij0sh/pi-shadow-compact/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.

Get the blocker's database ID with:
`gh api repos/sij0sh/pi-shadow-compact/issues/<number> --jq .id`.

Use the database ID, not the issue number or node ID.
If dependencies are unavailable, put `Blocked by: #<number>` at the top of the child body.
A ticket is unblocked when every blocker is closed.

For the frontier, list the map's open children.
Exclude tickets with an assignee or an open blocker.
Use `issue_dependencies_summary.blocked_by` to check native blockers.
For fallback blockers, check whether each referenced issue is open.
Choose the first eligible ticket in map order.

Claim a ticket with `gh issue edit <number> --add-assignee @me`.
Claiming is the wayfinder session's first write.

Resolve a ticket by commenting with the answer and closing it.
Append a context pointer, such as a gist link, to the map's Decisions-so-far.
