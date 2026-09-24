---
name: crew
description: Install and initialize Crew in the current Git repository, submit authorized engineering tasks or goals, and inspect worker and PR status through Crew CLI. Use for Crew delegation rather than implementing the delegated change in the current checkout.
---

# Crew

Crew Cloud hosts the proprietary Runner and model Gateway. The CLI runs a persistent worker and keeps GitHub credentials on that machine. Use the current Git repository; never create Cloud repository configuration by hand.

## Initialize

1. Resolve the Git root. Inspect `crew --version`, Node (24+), Git, GitHub CLI and user-service support. Reuse the approved version when installed.
2. This skill targets **0.4.0-rc.3**, an unpublished pilot candidate. If Crew is missing, ask for the pilot bundle location; verify its SHA-256 manifest, then run `npm install --global /absolute/path/bosun-sh-crew-cli-0.4.0-rc.3.tgz`. Use the supplied installer for a user-local installation. Never fetch a floating latest version or invent an unpublished download URL. Missing OS packages may need administrator authorization; show corrective commands without changing unrelated settings.
3. Run `crew doctor --json`. Persistent GitHub access uses `gh auth login` and `gh auth setup-git` when needed. Never request or read tokens, passwords or session files into model context.
4. Run `crew setup --dashboard CLOUD_URL --json`. Default Cloud is https://crew.bosun.sh; override only for an explicitly supplied private or test deployment. Let the user complete browser login and execution consent. Use `--yes` only when repository execution and service installation were explicitly authorized. Account creation and credit purchase remain human steps.
5. An unborn, empty repository needs a PR base branch. Only after explicit authorization use `crew setup --initialize-empty` to create and publish an empty base commit. Never stage or publish developer files to make setup pass.
6. Verify `crew status --json` identifies the expected repository/organization and an online worker. Linux needs `sudo loginctl enable-linger "$USER"` for survival after logout/reboot; explain this rather than silently elevating. Keep the machine online.

For an empty repository, obtain the selected stack and explicitly authorized commands/timeout before scaffolding; setup accepts `--commands` and `--timeout-seconds`. Reconnect preserves saved settings unless explicitly overridden. Finish or cancel active work before an authorized policy change because it restarts the worker; never broaden command permissions silently.

## Delegate

Use `crew goal add "Outcome" --verify "Observable checks" --max-cost USD --json` for goals, or `crew task add` for bounded tasks. Obtain authorized scope, verification and cap before paid submission. `--yes` confirms existing permission; never invent a cap or buy credits automatically. New goals require one understanding confirmation in Cloud and default to automatic internal review, including disclosed TypeSafe processing when qualified. Use `--manual-review` when requested. Never bypass an enabled decision gate.

Use `crew tasks` or `crew goals` to open the repository’s Cloud board. Desktop defaults print and open; SSH/headless defaults print only. `--no-browser` only prints; `--browser` requests launch with URL fallback on failure. Use `--list` or `--json` without browser launch for automation, and `crew status --json` for blockers. A write collaborator can request GitHub revisions with `/crew revise` and feedback. Submitted Request changes reviews by write collaborators also queue revisions, including inline feedback. Users merge manually and approve budget increases and lasting repository rules.

## Recover

JSON results go to stdout; progress goes to stderr. Inspect `ok`, `code`, `message` on failure. `not_a_repository`: enter the intended checkout. `not_connected`: run setup. `organization_mismatch`: log in to the connected organization. `initialization_incomplete`: retry the same initialization; `initialization_conflict`: inspect Git state before continuing. Unknown failures need inspection, not speculative repair.

Retry existing setup after network/service failures; never delete `~/.crew` or create duplicate installations to bypass recovery. Never resubmit ambiguous paid work as a new goal—inspect existing work first. Closing a terminal preserves the worker; `crew logout` intentionally stops and revokes workers and is not a generic repair command.
