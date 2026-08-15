# packages/adapter-core/

Minimal provider-adapter kernel. It owns the product-target resolver and the
structural contracts shared by installation and runtime adapters.

## Contracts

- `TargetProfile`: exact product identity, discovery path, runtime marker,
  update channel, and adapter version.
- `AdapterDescriptor`: provider identity, products, installer kind, lifecycle
  method, and bounded capability matrix.
- `EventMapper<Input, Output>`: pure provider-event normalization boundary.
- `InstallerPlan`: provider, target, scope, and install/doctor/remove mode.

`generated-contract.ts` is produced from the release JSON facts by
`scripts/generate-brainpet-adapter-contracts.mjs`; drift fails the release gate.
