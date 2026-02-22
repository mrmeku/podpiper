# Go Port of `packages/dag` — Type System Tradeoffs

## Context

The TypeScript DAG engine uses advanced generics (`InputsFor<P>`, phantom `NodeRef<T>`, generic `addNode<P, R>`) to give compile-time guarantees that node inputs match upstream outputs. This document examines what an idiomatic Go port looks like and how much definition-time safety we can recover.

## Idiomatic Go Design

### Core types

```go
type ExecStatus int
const (
    StatusDone ExecStatus = iota
    StatusCached
    StatusFail
    StatusDepFailed
)

type Node struct {
    Name   string
    Kind   string
    Deps   []string
    Config string
    Hash   string
    Action func(inputs map[string]json.RawMessage) (json.RawMessage, error)
}

type ExecResult struct {
    Name   string
    Hash   string
    Status ExecStatus
    Result json.RawMessage
    Err    error
}

type Cache interface {
    Get(hash string) (result string, hit bool)
    Put(hash string, result string)
}

type Flushable interface {
    Flush() error
}

type NodeRunner func(node Node, inputs map[string]json.RawMessage) (json.RawMessage, error)
```

Single struct with status iota for `ExecResult`. No pseudo-sum-types, no sealed interfaces.

### Phantom `NodeRef[T]`

Go rejects unused type parameters. A zero-length array satisfies the compiler at zero memory cost:

```go
type NodeRef[T any] struct {
    Name    string
    phantom [0]T
}
```

This lets `NodeRef[DownloadResult]` and `NodeRef[string]` be distinct types. The phantom type doesn't encode input/output matching into function signatures (Go can't do that without arity overloads), but it drives type inference on the two generic helpers: `Dep` and `Result`.

### Graph and `AddNode[R]`

```go
type Graph struct {
    nodes map[string]Node
    cache Cache
}

func (g *Graph) Add(def Node) error { /* validate deps, compute hash */ }

func (g *Graph) Execute(ctx context.Context, opts ExecuteOptions) ([]ExecResult, error) {
    // goroutines + semaphore channel for parallelism
    // context.Context for cancellation
}
```

One generic `AddNode` function. Actions receive `map[string]json.RawMessage` and return a typed `R`. The function handles output serialization internally:

```go
func AddNode[R any](g *Graph, name, config, kind string, deps []NodeRef[any],
    action func(inputs map[string]json.RawMessage) (R, error),
) NodeRef[R] {
    depNames := make([]string, len(deps))
    for i, d := range deps { depNames[i] = d.Name }
    g.Add(Node{
        Name: name, Kind: kind, Config: config, Deps: depNames,
        Action: func(inputs map[string]json.RawMessage) (json.RawMessage, error) {
            result, err := action(inputs)
            if err != nil { return nil, err }
            return json.Marshal(result)
        },
    })
    return NodeRef[R]{Name: name}
}
```

### Typed helpers: `Dep` and `Result`

These are where `NodeRef[T]`'s phantom type pays off. The compiler infers `T` from the ref, so you never write the type explicitly:

```go
func Dep[T any](inputs map[string]json.RawMessage, ref NodeRef[T]) (T, error) {
    var v T
    raw, ok := inputs[ref.Name]
    if !ok {
        return v, fmt.Errorf("missing dependency %q", ref.Name)
    }
    return v, json.Unmarshal(raw, &v)
}

func Result[T any](results []ExecResult, ref NodeRef[T]) (T, error) {
    for _, r := range results {
        if r.Name == ref.Name {
            var v T
            return v, json.Unmarshal(r.Result, &v)
        }
    }
    var zero T
    return zero, fmt.Errorf("node %q not found in results", ref.Name)
}
```

### User code

```go
dlRef := dag.AddNode[DownloadResult](g, "download:abc", dlCfg, "download", nil,
    func(inputs map[string]json.RawMessage) (DownloadResult, error) {
        return ports.Download(videoID)
    },
)

txRef := dag.AddNode[string](g, "transcribe:abc", txCfg, "transcribe",
    []dag.NodeRef[any]{{Name: dlRef.Name}},
    func(inputs map[string]json.RawMessage) (string, error) {
        dl, err := dag.Dep(inputs, dlRef)  // inferred as DownloadResult
        if err != nil { return "", err }
        return ports.Transcribe(dl.AudioPath)
    },
)

summaryRef := dag.AddNode[Summary](g, "summary:abc", sumCfg, "summary",
    []dag.NodeRef[any]{{Name: txRef.Name}, {Name: dlRef.Name}},
    func(inputs map[string]json.RawMessage) (Summary, error) {
        tx, err := dag.Dep(inputs, txRef)  // inferred as string
        if err != nil { return Summary{}, err }
        dl, err := dag.Dep(inputs, dlRef)  // inferred as DownloadResult
        if err != nil { return Summary{}, err }
        return ports.Summarize(tx, dl.Title)
    },
)
```

`dag.Dep(inputs, dlRef)` returns `DownloadResult` because `dlRef` is `NodeRef[DownloadResult]`. No explicit type annotation needed — the phantom type does the work.

### `defineAction` → plain functions

Go can't express `defineAction<Ctx, P, R>`. The idiomatic replacement is a function per action kind:

```go
func AddDownloadNode(g *Graph, ports Ports, videoID, url string) NodeRef[DownloadResult] {
    return dag.AddNode[DownloadResult](g, "download:"+videoID, url, "download", nil,
        func(inputs map[string]json.RawMessage) (DownloadResult, error) {
            return ports.Download(videoID, url)
        },
    )
}
```

More verbose than a factory, but completely type-safe and obvious to any Go reader.

### Executor loop

The TS Promise/resolve trick (graph.ts:130-141) maps to goroutines + semaphore:

```go
func (g *Graph) Execute(ctx context.Context, opts ExecuteOptions) ([]ExecResult, error) {
    sem := make(chan struct{}, opts.MaxParallelism)
    var wg sync.WaitGroup
    // ... dispatch goroutines per ready node, signal completion via channel
}
```

`context.Context` gives cancellation propagation that the TS version lacks.

---

## What the Compiler Catches vs. What It Misses

### Caught at compile time

- **Wrong output type at extraction**: `dag.Result(results, dlRef)` returns `DownloadResult`. If you try to assign it to `string`, the compiler rejects it.
- **Wrong dep type at consumption**: `dag.Dep(inputs, dlRef)` returns `DownloadResult`. If the action tries to use it as `string`, compile error.
- **Output type mismatch in action**: `AddNode[DownloadResult]` requires the action to return `DownloadResult`. Returning `string` is a compile error.

### Not caught at compile time

- **Dep not declared**: You can call `dag.Dep(inputs, someRef)` for a node that isn't in your `deps` slice. Compiles fine, fails at runtime (key missing from map).
- **Dep type drift**: If node A is refactored to produce `NewResult` instead of `OldResult`, downstream nodes that call `dag.Dep(inputs, aRef)` still compile if `aRef` was captured before the change. The phantom type on `aRef` reflects whatever type `AddNode` was called with — if you hold a stale ref, the types diverge silently.
- **Deps list vs. actual usage**: The `deps []NodeRef[any]` parameter is type-erased. The compiler can't verify that the deps you declare match the deps you actually `Dep()` on.

### TypeScript comparison

| Guarantee | TypeScript | Go |
|-|-|-|
| Output type tracked through refs | `NodeRef<R>` phantom `_T` | `NodeRef[R]` phantom `[0]T` |
| Input types auto-derived from deps | `InputsFor<P>` mapped type | No — manual `Dep(inputs, ref)` calls |
| Wrong dep type → compile error | Yes (via `InputsFor`) | Yes (via `Dep` return type inference) |
| Undeclared dep used → compile error | Yes (must be in `deps` record) | No — caught at runtime |
| Named deps prevent key typos | Yes (`inputs.audio`) | Partial — `Dep(inputs, ref)` uses ref, not string key |
| Exhaustive status matching | Yes (discriminated union) | No — use `exhaustive` linter |

---

## What Go Does Better

| Feature | Why |
|-|-|
| Runtime deserialization safety | `json.Unmarshal` validates structure. TS `as T` is unchecked — `parseRef` (types.ts:92-94) does `JSON.parse(raw) as T` with zero validation |
| Concurrency | Goroutines + semaphore channel vs. Promise/resolve trick |
| Cancellation | `context.Context` propagation — no TS equivalent |
| Error handling | `(T, error)` returns vs. thrown exceptions |
| Binary | Single static binary, no runtime |

---

## What Remains Unrecoverable

### `InputsFor<P>` — auto-derived input struct

TypeScript computes the input type from the deps record at compile time. Go generics have no mapped types, no conditional types, no `infer`. There's no way to derive struct shape from another struct's fields. This is the fundamental gap. Every approach in Go requires the action author to manually call `Dep()` per dependency.

### `defineAction<Ctx, P, R>` — 3-parameter generic factory

Go methods can't introduce new type parameters. Go functions can't partially apply generics. The factory pattern that TS uses to reduce boilerplate across action definitions has no Go equivalent. Plain functions per action kind are the replacement.

### Exhaustive matching on `ExecResult`

Go's `ExecStatus` iota has no exhaustiveness guarantee on switch. The `exhaustive` linter covers this gap in practice but it's not compiler-enforced.

---

## Summary

| | TypeScript | Go |
|-|-|-|
| **Output type safety** | `NodeRef<R>` phantom | `NodeRef[R]` phantom — equivalent |
| **Input type safety** | Automatic via `InputsFor<P>` | Manual via `Dep(inputs, ref)` — inferred, not derived |
| **Runtime validation** | None (`as T` cast) | `json.Unmarshal` validates structure |
| **Concurrency** | Promise/resolve trick | Goroutines + channels |
| **Cancellation** | Not built in | `context.Context` |
| **Boilerplate** | Low (types derived automatically) | Medium (explicit `Dep` calls, one function per action kind) |
| **Dep wiring errors** | Compile-time | Runtime (dep not in declared list) |
