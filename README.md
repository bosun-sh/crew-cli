# Crew CLI

`crew login` defaults to `https://crew.bosun.sh`; approve its device code from any browser. `crew tasks` and `crew goals` open repository-filtered Cloud boards. SSH/headless sessions print links; use `--no-browser`, `--browser`, `--list` or `--json` as needed. New goals receive one understanding confirmation, then automatic internal review; choose `--manual-review` for stage checkpoints. See the [VPS guide](docs/vps.md).

Connect a repository on your machine to Crew Cloud and delegate bounded engineering tasks. Crew Cloud hosts the proprietary Runner and model Gateway; your background worker executes approved tools in isolated Git worktrees using your GitHub credentials.

Requires Node.js 24+, Git, GitHub CLI, and macOS or Linux. Linux background services require a systemd user session and lingering for work after logout or reboot.

## Release candidate installation

Verify the supplied release manifest, then install the reviewed local package:

```sh
npm install --global ./bosun-sh-crew-cli-0.4.0-rc.3.tgz
crew login
crew setup
crew status
crew task add "Fix a small issue" --verify "Run existing tests" --max-cost 2
crew tasks
```

Setup guides browser login, GitHub access, execution consent and background service installation. Keep your machine online. Review the resulting PR, request changes with `/crew revise` followed by feedback, and merge manually. Crew synchronizes the merged status.

`crew logout` stops workers and revokes access. Closing SSH keeps workers running when Linux lingering is enabled. State lives under `~/.crew`; retain it for recovery.

See the [VPS and acceptance guide](docs/vps.md), [architecture](docs/architecture.md) and [threat model](docs/threat-model.md). This candidate is not yet published to npm.

## Development

Repository-local setup also works from subdirectories. `crew status --json` and `crew tasks --json` report the connected repository. `crew goal add "Build the feature" --verify "Acceptance checks" --max-cost 5` creates staged work. Existing goals stay manual; `--auto-review` explicitly permits qualified internal review, never automatic merge.

The packaged [Crew skill](skills/crew/SKILL.md) guides Codex or Claude Code through installation and delegation. Browser login, credits and execution permission remain human steps. For a truly empty unborn checkout and empty remote, `crew setup --initialize-empty` explicitly authorizes an empty initial commit; it never stages developer files.

```sh
bun install --frozen-lockfile
bun run check
npm pack
```
