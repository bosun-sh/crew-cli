# Crew CLI

Connect a repository on your machine to Crew Cloud and delegate bounded engineering tasks. Crew Cloud hosts the proprietary Runner and model Gateway; your background worker executes approved tools in isolated Git worktrees using your GitHub credentials.

Requires Node.js 24+, Git, GitHub CLI, and macOS or Linux. Linux background services require a systemd user session and lingering for work after logout or reboot.

## Release candidate installation

Verify the supplied release manifest, then install the reviewed local package:

```sh
npm install --global ./bosun-sh-crew-cli-0.3.0-rc.1.tgz
crew setup . --dashboard https://YOUR-CREW-DASHBOARD
crew status
crew task add "Fix a small issue" --verify "Run existing tests" --max-cost 2
crew tasks
```

Setup guides browser login, GitHub access, execution consent and background service installation. Keep your machine online. Review the resulting PR, request changes with `/crew revise` followed by feedback, and merge manually. Crew synchronizes the merged status.

`crew logout` stops workers and revokes access. Closing SSH keeps workers running when Linux lingering is enabled. State lives under `~/.crew`; retain it for recovery.

See the [VPS and acceptance guide](docs/vps.md), [architecture](docs/architecture.md) and [threat model](docs/threat-model.md). This candidate is not yet published to npm.

## Development

```sh
bun install --frozen-lockfile
bun run check
npm pack
```
