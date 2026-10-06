---
name: deploy-exe-dev
description: Deploy Blastradius (or any app in this repo) to an exe.dev VM — create or reuse the VM, copy a build, run it under systemd on port 8000, and share it at https://<vm>.exe.xyz/. Use when the user asks to deploy, host, ship or publish to exe.dev, an exe VM, or *.exe.xyz, or to set up nightly Blastradius scans on a VM.
---

# Deploy to exe.dev

exe.dev gives Linux VMs (root, apt, systemd, persistent disk) managed entirely over SSH. Every VM gets `https://<vm>.exe.xyz/`, proxied to one port on the VM (default **8000**), **private by default** (only people with access to the VM can open it).

## 0. Read the live docs first

exe.dev's CLI changes. Before running anything, fetch the current docs and the command help, and prefer them over this file when they disagree:

- LLM index: https://exe.dev/llms.txt · full text: https://exe.dev/llms-full.txt
- Docs index: https://exe.dev/docs.md · everything in one page: https://exe.dev/docs/all.md
- `ssh exe.dev help` and `ssh exe.dev help <command>` (e.g. `help new`, `help share`)

If the docs host is blocked by a network policy, say so and fall back to `ssh exe.dev help`. `reference.md` in this folder lists what we last verified, with sources.

## Two SSH destinations — don't mix them up

- `ssh exe.dev <command>` — the **lobby**: VM lifecycle, sharing, config. No shell, no scp/sftp.
- `ssh <vm>.exe.xyz` — the **VM itself**: full shell, scp, rsync, port forwarding.

Non-interactive shells: always pass `-o StrictHostKeyChecking=accept-new -o BatchMode=yes` so a host-key prompt can't hang silently. If auth fails, check `~/.ssh/config`:

```
Host exe.dev *.exe.xyz
  IdentitiesOnly yes
  IdentityFile ~/.ssh/id_ed25519
```

The key must already be registered with the user's exe.dev account. If no key is available (common in cloud sandboxes), stop and tell the user how to provide one (an environment secret, or run the skill locally). Never generate and register keys on their behalf.

## Confirm before these — every time

- **Creating a VM** (`ssh exe.dev new`) — it counts against their subscription. Reuse an existing VM when one fits (`ssh exe.dev ls --json`).
- **Making it public** (`share set-public`). Blastradius reports name packages, maintainers and funders; keep them private unless the user explicitly wants them public.
- **Deleting a VM** (`ssh exe.dev rm <vm>`) — irreversible; only when asked.

## Deploy steps

1. **Pick the VM.** `ssh exe.dev ls --json`. If the user named one, use it. Otherwise, after confirming, `ssh exe.dev new --json` (check `ssh exe.dev help new` for naming flags) and read the VM name from the JSON.
2. **Build locally**, from `blastradius/`: `npm ci && npm run build && npm test`. Don't deploy a red build.
3. **Ship it** with `scripts/deploy.sh` (see below). It uploads a release into `/opt/<app>/releases/<timestamp>`, installs production deps on the VM, flips `/opt/<app>/current`, writes a systemd unit with `PORT=8000`, restarts it and health-checks `http://localhost:8000/` on the VM. It keeps the last 3 releases for rollback.
4. **Share.** The proxy already targets 8000 on new VMs. If the app uses another port: `ssh exe.dev share port <vm> <port>`. Only after the user agrees: `ssh exe.dev share set-public <vm>`; undo with `share set-private <vm>`.
5. **Verify** from the VM (`ssh <vm>.exe.xyz curl -fsS localhost:8000/`) and give the user `https://<vm>.exe.xyz/`. A private share will ask outsiders to log in — that's expected.

## Running deploy.sh

```
.claude/skills/deploy-exe-dev/scripts/deploy.sh <vm> <mode> [app-name]
```

- `mode=reports` — **Blastradius today** (it's a CLI). Installs the built CLI, a systemd **timer** that runs `blastradius scan` nightly over the targets in `/etc/blastradius/targets` (one repo URL per line), writes JSON/SARIF/HTML into `/srv/blastradius/out/<date>/`, and serves that folder read-only on port 8000.
- `mode=server` — for a future web/API server: runs `node dist/server.js` (override with `START_CMD=...`) under systemd with `PORT=8000`.

Secrets (e.g. `GITHUB_TOKEN` for higher GitHub rate limits) go in `/etc/<app>/env` on the VM, mode 600, set with `ssh <vm>.exe.xyz 'sudo install -m600 /dev/stdin /etc/<app>/env' < local-env-file`. Never commit them or pass them on a command line.

## Rollback and logs

- Logs: `ssh <vm>.exe.xyz journalctl -u <app> -n 200 --no-pager` (timer runs: `-u <app>-scan`).
- Rollback: `ssh <vm>.exe.xyz 'cd /opt/<app>/releases && ls'`, then `sudo ln -sfn /opt/<app>/releases/<previous> /opt/<app>/current && sudo systemctl restart <app>`.

## Report back

Tell the user: VM name, URL, public or private, release id, health-check result, and (reports mode) when the next scan runs (`systemctl list-timers <app>-scan.timer`).
