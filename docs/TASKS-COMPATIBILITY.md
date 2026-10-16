# Experimental Tasks compatibility spike

The installed `@modelcontextprotocol/sdk` 1.31.0 exposes experimental Tasks APIs through `client.experimental.tasks` and `server.experimental.tasks`. This is the SDK's experimental contract, not a claim of compatibility with every later Tasks extension or every MCP client.

## Verified locally

`src/tasks-compat.test.ts` connects SDK client and server over `InMemoryTransport`. It checks advertised task capabilities and the SDK's `tasks/get`, `tasks/result`, `tasks/list`, and `tasks/cancel` against synthetic, pre-seeded store entries. A separate server without Tasks verifies ordinary tool execution once and rejects unsupported task access. The tests create no inference runner, HTTP listener, external service, or production state.

The inspected installed sources are `experimental/tasks/client.d.ts`, `experimental/tasks/mcp-server.js`, `experimental/tasks/stores/in-memory.d.ts`, and `shared/protocol.js`. The high-level SDK can register task tools, and supplying `taskStore` installs protocol handlers. Its demonstration store is volatile and cleans entries by TTL. Its cancellation handler updates task status; that alone does not cancel a `JobManager` process or prove that its inference stopped.

## Production decision

Production Tasks integration remains deferred. No real user client was verified to negotiate this specific experimental contract. A production adapter must map each task to exactly one existing `JobManager` job, implement actual cancellation through the existing owner checks, preserve uncertain and recovery states, and read results from persistent job state. It must not add a second runner or infer that a protocol cancellation confirms stopped execution. Protocol TTL must never delete operational job history.

The spike deliberately does not implement that adapter or alter the current submit/get/list/cancel tools. Existing clients continue using those tools. SDK upgrades, newer extension adoption, and changes to the production capability advertisement require separate compatibility evidence.
