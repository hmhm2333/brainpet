# BrainPet Codex bridge

The canonical local Codex plugin source is
`plugins/brainpet-codex-bridge`. It maps Codex task lifecycle hooks to
BrainPet's authenticated local `agent.activity` IPC method.

Privacy boundary: the bridge sends only schema version, agent id, Codex session
id, optional turn id, lifecycle state, timestamp, declared capability names,
and a category-only permission summary when applicable. It never sends prompt
text, tool input/output, transcript content, paths, commands, or the working
directory.

The current development hook command can fall back to the local Node.js
executable available to Codex. Running-runtime IPC is capped at 400ms. If a
packaged BrainPet is installed but stopped, the bridge validates its per-user
install marker, starts it, and waits at most 2.5 seconds for the first IPC. All
failures are swallowed. This is not the public distribution contract: the
release plugin must contain the bundled, no-dependency platform helper.

Install the plugin into a personal marketplace, approve the hook trust review,
and open a new Codex task. Remove the installed plugin to roll back; this does
not modify Codex's native pet assets or task data.

See `docs/brainpet-distribution.md` for the public directory, installer,
versioning, trust, and rollback plan.
