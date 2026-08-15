# BrainPet Hook Helper

Cross-platform, short-lived bridge used by coding-agent lifecycle hooks. It
reads one hook JSON object from stdin, keeps only the normalized lifecycle
fields, and sends one authenticated schema-v1 `agent.activity` request to the
BrainPet desktop runtime. If an installed runtime is not running, it validates
the per-user install marker, starts the BrainPet executable with no arguments,
and keeps all launch, discovery and send work inside a 2.6-second deadline. Invalid or missing markers remain
silent no-ops.

Supported targets for the first public package:

- `x86_64-pc-windows-msvc`
- `aarch64-pc-windows-msvc`
- `x86_64-apple-darwin`
- `aarch64-apple-darwin`
- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu`

The helper is deliberately fail-open: malformed input, a missing runtime, or a
connection error results in a successful silent exit so an Agent turn is never
blocked. It never reads prompt, transcript, tool input/output, cwd, or project
files.

Development build:

```sh
cargo test --manifest-path native/brainpet-hook/Cargo.toml
cargo build --release --manifest-path native/brainpet-hook/Cargo.toml
```

Release binaries are copied into the Codex plugin's platform folders by the
release packaging job. The current JavaScript bridge remains a development-only
fallback until all signed binaries are produced by CI.
