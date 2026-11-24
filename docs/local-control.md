# Local control (protocol v1, edition `dev`)

Local control drives **an already-running Tivano Windows**. It is off by
default and listens only while **both** gates are on: Settings → Alpha and
the separate Local control switch. Closing either gate stops the listener
and drops every connection; accepted turns keep running — the gate never
cancels work. Approvals and questions stay in the app: clients can observe
waiting but cannot approve, answer, log in or grant permissions.

This is a **same-account capability**, not protection against malicious
processes with your UID. It is a bounded port of the frozen macOS
`AppControlService`/`ControlSocket` contract; differences are called out
below as *bounded*.

## Socket and framing

- Endpoint: `<dataRoot>/control/control.sock` — the directory is created
  `0700`, the socket `0600`, a stale socket is unlinked before bind, and
  only the socket this instance created is unlinked on stop.
- Frames are 4-byte big-endian lengths followed by JSON. The first frame
  is the `version`/`edition`/optional `expectedInstance` handshake; every
  later request also pins the negotiated `instance`.
- Limits: 8 connections/active handlers, one request in flight per
  connection, 128 KiB request, 1 MiB frame, 64 KiB text, 15 s client-side
  bounded exchange.

## Commands

```sh
tivano info | providers | projects | threads
tivano thread <uuid> | history <uuid>
tivano create [--provider ID] [--model ID] [--workspace local]
              [--project UUID] [--hydra on|off]
tivano send <uuid> --text TEXT | --stdin
tivano interrupt <uuid> --turn <uuid>
tivano operation <ticket>
tivano settings [get [KEY]] [set KEY=VALUE]...
```

- `threads` defaults to `archive=active` and `role=normal`. `normal`
  excludes Hydra heads (`!isHydraHead`); `role=head` lists heads,
  `all` lists everything, `helper` is `unsupported` (helpers do not
  exist in this build).
- `thread` reports `hydra` — the app-wide Hydra switch AND the chat's
  own flag — and `role` (`normal` or `head`).
- `create` never inherits the selected UI thread's model, permissions,
  Hydra pair or the saved new-chat defaults. **New threads start Hydra
  off** unless `--hydra on` is passed (`--hydra off` disables it
  explicitly); the UI's per-chat default is not touched. `--hydra on`
  requires the app-wide Hydra switch — otherwise the create fails
  `unsupported` / `hydra_disabled` — and a saved Hydra pair for this
  provider, otherwise `unsupported` / `hydra_pair_missing`. With
  `--model` omitted, the pair's saved lead model and effort apply.
  Bounded deviation: upstream `createExternalThread` tolerates a nil
  pair (Hydra on, heads run on the chat's model); this build refuses
  the create instead so a Hydra-led remote chat never starts
  pair-less. Bounded: `workspace=worktree` and foreign providers are
  `unsupported`.
- A Hydra-LED chat accepts `send` and `interrupt`. `send` replies
  `busy` while any of its heads is working or its head reports wait to
  land. Writes aimed **at** a head thread fail `unsupported` /
  `hydra-head-target`.
- `send` rejects slash-command input, archived threads, running or
  waiting turns and unsupported continuations (`transcript` needs a
  native-API provider this build does not have).
- Provider and control failures carry **stable codes**, never localized
  message text — the same request returns the same `code`/`detail` under
  English and zh-Hans.
- **Remote MCP (`P2-25`):** hosted outside Alpha under Settings ›
  Connections on `127.0.0.1` with OAuth 2.1 (`tivano.read` /
  `tivano.write`). Remote-created chats start in `supervised` unless
  "Run remote chats without approval" (`remoteMCPFullAccess`) is on;
  `submit` to a Hydra-led chat via Remote MCP refuses `permission` /
  `hydra_requires_remote_full_access` unless `remoteMCPFullAccess` is on
  (local CLI submits remain unaffected), and `settingsGet`/`settingsSet`
  are refused for remote callers.

## Write tickets

Writes carry a client-issued ticket
`INSTANCE_UUID/OPERATION_UUID/ISSUED_MILLISECONDS`. Within one
instance/window, the same ticket and payload returns its stored receipt
and never re-executes; a changed payload is `conflict`. A first delivery
more than 30 s after issuance is `unknown` and is never executed. At
most 16 non-terminal operations and 256 receipts (one-hour retention)
are kept; capacity refuses new writes rather than evicting receipts.
The ledger is in memory — a restart makes every old ticket `unknown`.

## Refusal surface

Wire errors are `error.code` plus an optional `detail`:
`disabled`, `protocolMismatch`, `editionMismatch`, `instanceMismatch`,
`invalidRequest` (incl. unknown methods — approval/question answering
does not exist as a command), `bounds`, `busy`, `notFound`,
`missingProject`, `unsupported`, `archived`, `continuationUnavailable`,
`conflict`, `providerFailure`, `internalError` and the rest declared in
`src/main/localControl.ts`. Only `textGeneration`, `antiSlopEnabled`,
`performanceMode` and `showsSkylight` are writable through
`settings set`.
