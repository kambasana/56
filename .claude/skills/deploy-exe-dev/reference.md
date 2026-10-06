# exe.dev reference (last verified 2026-10-06)

Always re-check against https://exe.dev/llms.txt and `ssh exe.dev help` — this is a snapshot.

| Task | Command | Source |
|---|---|---|
| Show commands / details | `ssh exe.dev help` · `ssh exe.dev help <cmd>` | exe.dev official skill (github.com/boldsoftware/exe.dev, `skill/SKILL.md`) |
| Create a VM | `ssh exe.dev new --json` | official skill |
| List VMs | `ssh exe.dev ls --json` | official skill |
| Delete a VM | `ssh exe.dev rm <vm>` | official skill |
| Shell / copy files | `ssh <vm>.exe.xyz` · `scp f <vm>.exe.xyz:~/` | official skill |
| Change proxied port | `ssh exe.dev share port <vm> <port>` (keeps visibility) | https://exe.dev/docs/cli-share |
| Public / private | `ssh exe.dev share set-public <vm>` · `share set-private <vm>` | https://exe.dev/docs/cli-share |

Facts:
- Every VM gets `https://<vm>.exe.xyz/` with automatic TLS; the default `exeuntu` image proxies port **8000**.
- Only one port is shared publicly; ports 3000–9999 are forwarded to users with access to the VM.
- VMs are plain Linux: root, apt, systemd, persistent disk.
- The lobby (`exe.dev`) has no shell/scp; the VM (`<vm>.exe.xyz`) has full SSH.
- Non-interactive SSH can hang on host-key prompts; use `-o StrictHostKeyChecking=accept-new`.

Docs: https://exe.dev/docs.md (index), https://exe.dev/docs/all.md (single page), https://exe.dev/llms.txt, https://exe.dev/llms-full.txt.
