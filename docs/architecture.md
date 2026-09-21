# Architecture

Crew CLI is the customer installation. Crew Cloud owns Dashboard, Gateway and the proprietary hosted Runner.

1. Browser device authorization connects the CLI to a Cloud organization.
2. Guided setup verifies repository access and saves a revocable connection under `~/.crew`.
3. A user service runs `crew worker` with that saved connection. It exchanges its credential for short-lived sessions and polls Cloud outbound; it exposes no listening HTTP server.
4. Hosted Runner orchestrates model calls and durable tool jobs. The worker applies local policy and executes approved tools in separate worktrees.
5. The worker saves results atomically before delivery. Recovery resends saved results without repeating acknowledged execution; uncertain mutations require attention.

GitHub credentials stay on the customer machine. Requested source excerpts, diffs, command output and repository metadata cross the outbound connection and may reach Cloud's configured model provider. Worktrees isolate changes, not hostile code.
