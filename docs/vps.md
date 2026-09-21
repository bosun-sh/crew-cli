# VPS release candidate guide

Crew does not provide a machine or VPS. You can start on your existing macOS or Linux computer; keep it awake and online for scheduled work. For your own always-on VPS, use a dedicated Linux account with Node.js 24 or newer, Git, GitHub CLI (`gh`), and a systemd user session. Crew executes with this account's permissions. Clone one repository before connecting; existing staged and unstaged work stays in that checkout while Crew uses separate worktrees.

On Debian/Ubuntu, install Git, GitHub CLI and the user-session prerequisites:

```sh
sudo apt-get update
sudo apt-get install git gh dbus-user-session
sudo loginctl enable-linger "$USER"
node --version
git --version
gh --version
systemctl --user show-environment
```

Install Node 24+ using your host's supported installation method if the version check fails. Reconnect over SSH after installing `dbus-user-session`. Lingering lets user services run after SSH disconnect and start at boot.

## Install and authenticate

Copy the reviewed RC tarball and its checksum file to the VPS, verify the checksum, then install that exact file. This RC is a local artifact; these commands do not assume registry publication.

```sh
sha256sum bosun-sh-crew-cli-0.3.0-rc.1.tgz
npm install --global ./bosun-sh-crew-cli-0.3.0-rc.1.tgz
crew --version
```

Compare the checksum with the release manifest before installation. Use an npm prefix writable by this dedicated account.

Configure persistent GitHub authentication using a fine-grained token limited to the selected repository, with repository contents and pull-request write access. Use the GitHub CLI prompt; do not put tokens in command arguments, service definitions, repository files, or task descriptions.

```sh
env -u GH_TOKEN -u GITHUB_TOKEN gh auth login --hostname github.com --git-protocol https
gh auth setup-git
gh auth status --hostname github.com
git clone https://github.com/OWNER/REPOSITORY.git
cd REPOSITORY
crew setup . --dashboard https://YOUR-CREW-DASHBOARD
```

Open the printed URL on your laptop, log in, compare the code, and approve. The VPS needs no browser. An expired code requires another `crew login`. Interactive login expiry does not revoke a connected worker.

```sh
crew connect .
crew status
```

Connect checks GitHub write access and authentication without temporary environment tokens or an SSH agent. Repeating connect resumes provisioning and service installation. Connections are bound to the Dashboard and organization; changing organization requires logout and reconnect. Store the GitHub CLI credentials under the dedicated account, with private permissions. On Linux without a keyring, `gh` may use its private configuration file.

## Delegate and review

```sh
crew task add "Fix the small validation issue and run the existing tests" --verify "Run the existing test suite and report results" --max-cost 2
crew task add "Check dependencies and propose a small maintenance PR" --at 2026-10-01T12:00:00Z --verify "Run the existing test suite and report results" --max-cost 2
crew task add "Run maintenance checks and propose necessary fixes" --weekly mon --time 09:00 --timezone America/New_York --verify "Run the existing test suite and report results" --max-cost 2 --monthly-cap 10
crew tasks
```

CLI caps are USD; 100 Crew credits equal $1. One lifecycle cap covers attempts, failures, retries and revisions. Recurrences reserve their full occurrence caps against the monthly limit and wait for outstanding work. Missed dates coalesce into one occurrence.

Open the task link and PR, inspect verification evidence, and request a revision with a collaborator comment beginning `/crew revise` followed by concrete feedback. Check the PR instructions and remaining budget. Ordinary comments do not launch work. Merge manually. Closed without merge and verified no-change are separate outcomes.

For exhausted tasks, approve a higher lifecycle cap on the task page within the organization and recurrence limits, then retry. A restart with an uncertain command outcome requires inspecting the saved branch and external effects before retrying. Publication retries reuse the same PR and do not rerun implementation.

## Status, logs and recovery

```sh
crew status
crew tasks
systemctl --user list-units 'crew-*.service'
journalctl --user -u 'crew-*.service' --since '1 hour ago'
loginctl show-user "$USER" -p Linger
```

Worker connection files, audit trails and worktrees live under `~/.crew/connections/`. Do not delete them during recovery: they preserve identity, authentication and acknowledged operation results. Keep local state private and include it in the host's protected backups.

For upgrades, verify and install the new exact tarball, then run `crew connect .` in each repository to refresh the service executable path. On macOS, the same command uses a per-user LaunchAgent; logs are in each connection directory's `worker.log`. macOS LaunchAgents require a logged-in user and are not a substitute for VPS lingering.

`crew logout` stops connected services and revokes their Cloud installs. If stopping or revocation fails, local state is retained: rerun logout when connectivity returns. Logout is different from closing SSH: close SSH to keep scheduled work running.

## Acceptance canary

1. Connect a disposable repository and confirm organization, worker availability and budgets.
2. Submit a small fix; disconnect SSH; inspect the single PR and its verification results.
3. Request an authorized revision; confirm the same PR and cumulative spend.
4. Merge manually; confirm Done after review synchronization.
5. Schedule maintenance, reboot the VPS, reconnect, and check service logs, next occurrence, PR count and charges.
6. Cancel another task during execution; verify no subsequent publication and reconcile any already-completed action.
7. Log out; verify the worker stops and its install cannot bootstrap again.

Record actual results. Local mock-provider tests do not prove GitHub, email, provider billing, or VPS reboot behavior.
