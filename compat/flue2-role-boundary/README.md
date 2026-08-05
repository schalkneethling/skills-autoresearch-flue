# Flue 2 role-boundary compatibility gate

This isolated, credential-free fixture tests one compatibility question against
the exact public Flue 2.0.3 API: can producer and judge responsibilities remain
separate, addressable agent roles in one Node runtime?

## Verified contract

- `Producer` and `Judge` are registered top-level functions in a `'use agent'`
  module, with stable `agentName` identities.
- Each role selects its own exact faux model and receives only its own
  instructions, user messages, submit tool, and structured data channel. Flue's
  framework-provided `task` tool is present for both roles; neither role sees
  the other role's submit capability.
- Each data writer and submit tool is backed by a Valibot schema. Invalid judge
  arguments are rejected before the writer runs; a corrected retry is accepted.
- The test boots one runtime with
  `start({ agents, providers: [faux.provider], env: {} })`, addresses each role
  through `init(Role).dispatch()`/`read()`, checks exact model-call counts, and
  always disposes the runtime.
- Persistence uses Flue's default in-memory adapter. Neither agent declares a
  sandbox, and the test verifies that the fixture file inventory is unchanged.
- After stopping the exercised runtime, the test starts and stops a second
  runtime in the same worker to prove the process-global singleton was released.

## Decision

**GO** for planning a production role-boundary migration around addressable
top-level agents, `init()`/`dispatch()`/`read()`, and schema-backed data writers.

The production migration now uses this verified boundary. Its agents intentionally
declare no sandbox; application code provides bounded prompt inputs and applies
validated results. The runtime remains process-local and in-memory, and beta
persisted state was not migrated across the v2 boundary.

Run the gate from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter flue2-role-boundary-compatibility run check
```

The repository's root lockfile pins the fixture's complete dependency graph,
keeping the compatibility evidence reproducible with the rest of the workspace.

## Pins

- `@flue/runtime`: `2.0.3`
- `@earendil-works/pi-ai`: `0.83.0`

The fixture intentionally does not depend on `@flue/cli`; the executable
evidence uses the role-boundary runtime APIs directly.

## Risks and exclusions

This gate does not itself test production migration, CLI lifecycle, durable
database adapters, crash recovery, sandboxes, skills, telemetry, real providers,
or credential-backed calls. Passing it establishes go/no-go evidence for the
role boundary only. It is not, by itself, a recommendation to migrate production
code. Production integration has separate tests; this fixture remains focused on
the original role-boundary evidence.
