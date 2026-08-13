# Architecture

Grok UI is a single-user local developer tool with three data planes.

## Runtime plane

`LiveMonitor` watches `active_sessions.json` plus bounded tails of active `events.jsonl` and `updates.jsonl` files. Filesystem events are debounced and projected into a small `LiveSnapshot`, then delivered through server-sent events.

Historical aggregate views use `summary.json` and `signals.json`. The Session Workbench reads bounded tails of `updates.jsonl` and, for older sessions without structured updates, `chat_history.jsonl`. Memory bodies, system prompts, raw terminal history, and authentication files are not read.

## Control plane

`GrokController` supervises one `grok agent --no-leader stdio` child process and uses the official TypeScript ACP SDK.

The connection supports:

- ACP initialization and cached Grok authentication
- `session/new`
- `session/load`
- `session/prompt`
- `session/cancel`
- `session/update`
- `session/request_permission`

Each permission request stays pending as a server-side promise until an authenticated user selects one of Grok’s options or cancels the turn. The browser cannot manufacture an option that Grok did not advertise.

## Durable UI state

`SessionStateStore` atomically persists Grok UI-owned annotations and managed ACP lanes to `~/.grok-ui/state.json` with user-only file permissions. It never mutates Grok’s session directories. Rename and archive are therefore reversible UI overlays.

Managed lanes retain a bounded event tail and usage totals. If the server exits during a turn, the lane restores as idle with a `server_restarted` stop reason; the user can explicitly resume it through `session/load` and `session/prompt`.

## Workspace plane

`WorkspaceInspector` runs argument-separated Git commands against workspaces associated with recorded or controlled Grok sessions. It never invokes a shell.

Diff paths are resolved beneath the repository root. Reads are bounded, binary content is not rendered, and untracked files are represented without leaving the repository.

## Preview plane

`PreviewSupervisor` detects package scripts only inside the workspace associated
with a known session. The browser cannot provide an arbitrary preview working
directory or command.

Starting a preview binds the child on `127.0.0.1` and publishes it through a
cookie-stripping proxy at `http://preview.localhost:<port>`. That hostname is
a different cookie host from `127.0.0.1` and `localhost`. The proxy also
drops `Cookie` and `Authorization` before they reach generated code. Known
frameworks receive explicit loopback host flags. Other scripts only get
`HOST`/`PORT` as a best-effort bind; they may still listen on `0.0.0.0` if
they ignore `HOST`.

Spawn uses argument separation and `shell: false`. Package managers may still
invoke a shell internally to run the script body. Start and stop are serialized
per session and terminate with `SIGTERM`, a short wait, then `SIGKILL`. Output
is stripped of terminal control sequences and kept as a bounded in-memory tail.
Preview processes are not restored after a restart and are stopped during
graceful server shutdown.

The application iframe uses the `preview.localhost` origin and a sandbox.
Spawn env also omits Grok credentials and the Grok UI token.

## Network boundary

The production server binds to the loopback interface by default. A non-loopback host requires `GROK_UI_TOKEN`.

Authenticated browsers receive an in-memory session ID through an `HttpOnly`, `SameSite=Strict` cookie. Mutations using that cookie are same-origin checked. API clients may use the configured token as a bearer credential.

No browser request contains Grok credentials. No product analytics are emitted.
