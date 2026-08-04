# ADR-0006: Extensions live in independent repositories

## Status
Accepted

## Context
An extension grew alongside substrate work in this monorepo. Its product
semantics became entangled with core documentation and examples, making
extension-specific assumptions appear to be substrate requirements. The
monorepo made that coupling easy and invisible.

The substrate must remain a general contract for actors, contexts, events,
deliveries, hooks, and extension discovery. Product extensions must be able to
evolve independently without changing those core concerns.

## Decision

The Floe monorepo contains substrate only. Extensions live in independent
repositories and build against the substrate contract.

Extension discovery remains a runtime substrate capability: the bus exposes
`GET /v1/extensions` and publishes `extensions_updated`. An extension may
declare a view, but runtime loading of external extension view components is
not implemented. Such a view renders a placeholder.

## Consequences

- Extension product code, tests, files, and documentation do not belong in this
  repository.
- Substrate documentation describes extension contracts and invariants without
  treating an extension as a worked-in product.
- Runtime discovery remains available to external extensions.
- The design for loading external extension view components is an open question;
  this ADR does not choose one.
