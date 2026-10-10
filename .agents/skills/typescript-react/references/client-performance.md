# Client performance

Start from a specific slow scenario or an explicit cost investigation. Record the runtime, data size, network conditions, loading path and available profiler/timing evidence. Code appearance alone establishes no improvement.

- Trace prerequisites in the actual request/loading graph. Start independent operations concurrently; preserve sequencing when one result supplies another's inputs. Compare the same failure and success paths, including overlapping requests and cancellation where relevant.
- Inspect import, bundle and loading evidence before introducing splitting or a replacement dependency. Preserve the host's public import conventions; do not transplant Next.js or server rules into a client host.
- Find demonstrated hot render work. Derive values directly where appropriate instead of introducing synchronized copies or unnecessary effects. An effect that synchronizes an external system still needs correct ownership, dependencies and cleanup.
- Apply the measured-cost/stable-identity memoization rule from [React implementation](react-implementation.md#callbacks-and-hooks); do not wrap every value or callback.
- Inspect touched large collections, stable identity and content growth using [React implementation](react-implementation.md#components-and-ui). Preserve its pagination/virtualization threshold and product behavior.
- Compare the same scenario/environment before and after with available profiling or timing tools. Record the observed measure and limitations; distinguish fewer sequential waits from measured user-visible speed.
- In the touched component, test long/localized text and meaningful empty/error/loading/recovery states where they affect rendering or loading. Preserve input on recoverable failures; account for paste/autofill when an input participates in the flow.
