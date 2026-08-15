# packages/install-pet/

Thin product-targeted pet installation CLI.

## Responsibility

Requires `--product brainpet|openpets` and sends `pets.install` to that exact
running desktop host through `@open-pets/client`. It never downloads or extracts
packages, selects a user-data directory, acquires a direct-state lock, or writes
application state while the host is offline.

## Flow

```text
install-pet --product <target> <pet-id>
  -> validate product and pet id
  -> createOpenPetsClient({ target })
  -> running host pets.install
  -> print the host-validated receipt
```

Unavailable targets fail with a bounded instruction to start the selected host.
The desktop remains the sole owner of catalog validation, ZIP safety, state
migration and atomic persistence.

## Integration Points

- Dependency: `@open-pets/client`
- Binary: `install-pet --product <brainpet|openpets> <pet-id>`
- Exports: `installPet()`, `parseArgs()`, `validatePetId()`
