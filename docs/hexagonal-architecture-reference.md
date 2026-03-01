# Hexagonal Architecture (Ports & Adapters) — Reference

## Core Principles

1. **Domain centricity.** All business logic lives inside a technology-agnostic core (the "hexagon"). It holds zero references to frameworks, databases, file systems, or infrastructure.
2. **Explicit boundaries via ports.** Every interaction between the core and the outside world passes through a declared interface (a port). No external actor may reach the core directly.
3. **Interchangeable adapters.** Concrete technology is encapsulated in adapters that plug into ports. Multiple adapters can exist for the same port (real, mock, stub).
4. **Dependency inversion.** Source-code dependencies always point inward, toward the core. The core never imports adapter code. On the driven side, the core depends on a port interface that adapters implement.
5. **Symmetry of sides.** All external actors are treated uniformly — a CLI user, a test harness, and a batch script are all just "drivers" behind adapters. A Postgres database and an in-memory fake are both just "driven adapters."
6. **Testability by construction.** Because the core depends only on port abstractions, any adapter can be replaced with a test double.

## Ports

A **port** is an interface that defines a purposeful conversation between the application and an external actor. Ports belong to the application — they are defined inside the hexagon.

| | Driver (Primary) Port | Driven (Secondary) Port |
|---|---|---|
| **Defines how** | The domain can be used | What the domain needs from outside |
| **Implemented by** | Application service / use case | Adapter (infrastructure code) |
| **Called by** | Driver adapter (CLI, test) | Application service |
| **Examples** | `SyncPodcast`, `CheckFeed` | `FileSystem`, `ObjectStore`, `Transcriber` |

**Rules:**
- A port represents a **domain concept**, not a technology. Name it after what the domain needs, not what implements it (`ObjectStore` not `S3Client`).
- The port interface uses **domain types**, not infrastructure types. No SDK-specific objects, no framework types.
- Ports form the **application boundary**. Everything inside = hexagon. Everything outside = adapters.

## Adapters

An **adapter** converts between a technology-specific protocol and the technology-agnostic port interface.

| | Driver (Primary) Adapter | Driven (Secondary) Adapter |
|---|---|---|
| **Direction** | Outside → Inside | Inside → Outside |
| **Responsibility** | Translate CLI args / HTTP / test setup → port call | Translate port call → S3 PUT / shell exec / SQL |
| **Examples** | CLI command handler, test harness | S3 storage, ffmpeg wrapper, yt-dlp wrapper |

**Rules:**
- An adapter contains **zero business logic**. Only translation/mapping.
- Adapters are **replaceable**. The core is unaware which adapter is plugged in.
- Mapping between domain models and adapter-specific models happens **in the adapter**, not in the core.

## Dependency Rule

All source-code dependencies point inward.

**Driver side (natural):**
```
[CLI Adapter] --depends on--> [Driver Port] <--implements-- [Application Service]
```

**Driven side (requires inversion):**
```
[Application Service] --depends on--> [Driven Port Interface] <--implements-- [S3 Adapter]
```

**Composition Root:** A startup component outside the hexagon wires everything:
1. Instantiates driven adapters (real S3, real ffmpeg)
2. Instantiates the application, injecting driven adapters
3. Instantiates driver adapters (CLI), injecting the application
4. Runs the driver adapter

## Common Violations

| # | Violation | Description |
|---|---|---|
| V1 | Infrastructure leaking into core | SDK types, framework decorators, or tool-specific logic inside domain code |
| V2 | Core depending on adapter types | Importing concrete adapter code or SDK from inside the hexagon |
| V3 | Technology-named ports | Port named after implementation (`S3Port`) instead of domain purpose (`ObjectStore`) |
| V4 | Business logic in adapters | Validation, transformation, or decision-making in a CLI handler or adapter |
| V5 | Use cases with technology knowledge | A use case that "knows" it's talking to S3, or constructs SQL, or formats CLI output |
| V6 | Shared models across boundaries | Same object as both domain model and persistence/API model |
| V7 | Skipping adapter mapping | Passing raw infrastructure responses directly into the core |
| V8 | Adapter cross-dependencies | One adapter silently depending on another adapter's infrastructure |
| V9 | Config mixing concerns | Infrastructure config (model paths, env vars) mixed with domain config |

## Application to CLI Tools

- **CLI command handler** = driver adapter (parses args, calls use case, zero business logic)
- **Application services** = driver port implementations (`sync()`, `check()`, `publish()`)
- **External tools** = driven adapters (yt-dlp, ffmpeg, whisper, Claude, S3)
- **Test doubles** = alternative driven adapters (mock, stub, memory-fs)
- **CLI entry point** = composition root (wires adapters, creates app, starts CLI)

## Sources

- Alistair Cockburn — Hexagonal Architecture (original)
- Juan Manuel Garrido de Paz — hexagonalme.github.io
- AWS Prescriptive Guidance — Hexagonal Architecture Pattern
- HappyCoders — Hexagonal Architecture: What Is It?
