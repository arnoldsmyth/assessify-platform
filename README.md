# Assessify — build workspace

The complete build specification lives in this repo at `docs/spec/` — **start with `docs/spec/00-README.md`.**

The backlog is the beads database in this folder (`.beads/`, prefix `asy`):

```
bd ready        # unblocked work, priority order
bd show <id>    # full issue detail incl. spec references
```

Notes for build agents:
- First real task is `A1 Monorepo scaffold` (Epic A: Foundations, `asy-aq5.1`). Everything else is dependency-blocked behind it.
- Issue descriptions reference spec docs as `development-files/assessify-spec/NN-*.md` — those files are now `docs/spec/NN-*.md` in this repo.
- The original planning drafts (superseded by the spec package) remain in the legacy repo: `PRO-D-Production-2024/development-files/`.
