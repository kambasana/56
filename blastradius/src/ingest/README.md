# ingest — owner: ingest agent

Static parsers → `Inventory` (PLAN §3.1). Nothing from the target is installed, built or executed.

- `ingest(target, opts?) → Promise<Inventory>`; `ingestDetailed(...)` also returns `workflows: WorkflowInfo[]` and `warnings`.
- `target`: local directory, or an https/ssh git URL (shallow `--depth 1` clone, hooks/templates/submodules/symlinks off, `GIT_TERMINAL_PROMPT=0`, temp dir removed afterwards).
- npm: `package.json` + `package-lock.json` / `npm-shrinkwrap.json` (lockfile v1, v2, v3, workspaces, nested `node_modules`, aliases, git deps). No lockfile → exact pins only, with a warning.
- GitHub Actions: `.github/workflows/*.yml` → `workflow:` assets, `pkg:githubactions/…` components (pinning sha/tag/branch), reusable workflows (`#.github/workflows/x.yml` subpath), `docker://`, job containers and services.
- Dockerfiles: `FROM` (ARG defaults, `--platform`, stages) and `COPY --from=<image>` → `pkg:docker/…`.
- `.blastradius.yml` at the target root overrides `environment` / `criticality` per path (longest match wins).
- Optional Syft (`opts.syft: true`, only when `syft` is on PATH): CycloneDX components not found by the static parsers are merged.
- Safety: symlinked dirs are never followed, symlinked files only when they resolve inside the target; reads are size-capped (2 MB, lockfiles 64 MB); the walk skips `node_modules`/`.git` and stops after 200k files.
- `select.ts` holds the file rules (which paths are manifests, lockfiles, workflows, Dockerfiles, config; skipped dirs; depth). The walk uses them, and so do connected repos (`server/sources`): they fetch exactly these files through the host API instead of cloning, and push events re-scan only when one of them changed.
