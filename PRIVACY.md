# BrainPet Privacy

BrainPet is local-first. The desktop runtime stores pet preferences, training progress, and bounded Agent activity on the user's device. It does not upload prompts, transcripts, the current working directory (cwd), tool input, tool output, or response text.

The Codex Bridge sends only the normalized Agent identifier, an ephemeral session identifier, an optional ephemeral turn identifier, lifecycle state, timestamp, declared lifecycle capability, and (only for permission hooks) the request kind to the local BrainPet IPC endpoint. It performs no network request. If the runtime is missing, stopped by policy, or cannot be authenticated, the Bridge exits successfully without changing the Agent task.

Checking for BrainPet updates makes a request to the public GitHub Releases API. No analytics or advertising SDK is included.

Removing the Bridge disconnects Agent lifecycle updates but leaves the offline pet and training data intact. Removing the BrainPet runtime removes its install marker, causing an installed Bridge to become a silent no-op. User progress is retained for a future reinstall unless the user deletes it separately.

Security and privacy issues can be reported at <https://github.com/hmhm2333/brainpet/issues>.
