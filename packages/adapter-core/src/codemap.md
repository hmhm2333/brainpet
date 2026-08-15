# packages/adapter-core/src/

- **index.ts**: validates descriptors and installer plans and resolves an exact
  BrainPet/OpenPets `TargetProfile` without cross-product fallback.
- **generated-contract.ts**: generated adapter version and product identity/path
  segments; never edit by hand.
- **check-adapter-core.ts**: deterministic target, descriptor, and plan tests.
