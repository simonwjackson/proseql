---
id: 2026-10-24-investigate-forgerie-file-watches-exhausting-the-host-limit
title: Investigate Forgerie file watches exhausting the host limit
status: To Do
created: 2026-10-24
source: forgerie-suggestion
  01a16bc6-2bf8-7620-87aa-158b201fa18f/1f84831f-a944-4c11-8c94-66c48992dabc
---

This follow-up belongs to Forgerie, not ProseQL. During ProseQL verification on 2026-10-24, fresh Node and Bun processes could not create a watch on a synthetic temporary directory or file. Node 24.13.0 reported ENOSPC; Bun 1.3.9 reported EINVAL. The configured fs.inotify.max_user_watches was 524288. Reading /proc showed Forgerie's Node process PID 3489569, cwd /home/simonwjackson/code/sandbox/forgerie, with 524142 watch entries across 20 inotify descriptors. FD aliases can duplicate counts, so this is not a proven unique-watch total or proof of a leak. The watch failures blocked ProseQL TypeScript, parity-example and browser gates. Investigate whether project watchers include generated trees, dependencies, scratch work or duplicate roots, and verify watcher disposal. Evidence: /home/simonwjackson/.local/share/forgerie/artifacts/proseql-zero-idle-20261024/watch-environment-controls/. Do not stop or restart services, raise system limits, or change user project settings without approval. The ProseQL branch must remain unlanded while mandatory gates fail.

## Context

### Why
A fresh Node process reproduced the host-capacity failure outside ProseQL. This prevents reliable verification in this project and can affect other projects.

### Files
None.

### Decisions
- Treat the measured process watch count as diagnostic evidence, not proof of a leak.
- Do not change global limits or restart unrelated services during the ProseQL task.
- The suggestion must not start work or file an external issue without a user action.

Suggested in proseql handoff file height (01a16bc6-2bf8-7620-87aa-158b201fa18f), 2026-10-24
