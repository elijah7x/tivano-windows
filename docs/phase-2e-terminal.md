# Phase 2e — embedded terminal development slice

An explicitly opened, per-thread terminal now uses a real PTY on macOS.
It supports separate tabs, keyboard input, resize, close and restart, and
keeps screen state when switching threads or hiding the panel. Shells and
scrollback are ephemeral. Reopening the application never starts a shell.

Windows terminal spawning remains unavailable. The native Windows Job
helper has component evidence, but this utility-process transport has not
been integrated with that helper or tested on Windows. The real-provider
gate remains closed. This is partial F12 development, not complete Windows
terminal acceptance or an installer.

## Runtime and authorization

Exact pins: node-pty 1.1.0, @xterm/xterm 6.0.0, @xterm/addon-fit 0.11.0,
Electron 44.8.0. The native binding loads only in a dedicated Electron
utility process; the renderer has no Node integration. Build restores the
packaged macOS spawn-helper executable bit, so a fresh install does not
rely on a manual chmod. No link, clipboard or WebGL addon is registered.

Main owns the shell specification: /bin/zsh -f, a per-incarnation isolated
HOME/ZDOTDIR/TMPDIR and an explicit environment. No login shell or inherited
provider credentials are passed to the shell. xterm's generated theme and
measurement style elements are permitted by style-src-elem; script-src
remains self-only and style-src-attr remains none. Actual Electron checks
measure text contrast and confirm an injected inline script is blocked. Project grants are checked
on creation, immediately before the ready host receives spawn, on restart
and before keyboard input. IPC accepts IDs/dimensions/input only, never a
shell executable, cwd or environment. Read-only/closing blocks input as
well as creation/restart; cleanup remains available.

Each terminal host belongs to one incarnation. Input, resize and ACKs carry
that incarnation. Restart waits for old-host cleanup and exit before a
replacement is created. Capacity is reserved synchronously (4 active
terminals per thread, 16 globally); confirmed failed starts release it.

## Output bounds

Host frames are at most 4096 UTF-16 code units. Host unacknowledged bytes
pause at 128 KiB, resume below 32 KiB, and fail visibly beyond 512 KiB.
Main caps unacknowledged output at 1 MiB/2048 frames, pauses above 256
frames or 512 KiB and resumes below 64 frames/256 KiB. No ACK progress for
15 seconds triggers teardown even if the host paused before main did.
Control messages do not depend on output credit. Sequence gaps, oversized
frames, future ACKs and stale-incarnation ACKs are rejected.

Main retains a 65536-character recent-history tail; xterm scrollback is
5000 lines. Pre-attach transport buffering is capped at 512 frames/256K
characters; overflow withholds credit and surfaces a stalled terminal.
Snapshot hydration buffers concurrent live frames, writes the tail first,
and then writes only newer frames. Old xterm completion callbacks cannot
credit a replacement terminal. A stale list response cannot overwrite
newer state events. Hidden terminals retain consumers.

## Cleanup and its limits

A PTY shell exit, descendant cleanup and utility-host exit are separate
observations. Close/delete/dispose retain ownership until cleanup and host
exit are confirmed; a 6-second timeout leaves an error and retryable
records. A second dispose cannot turn an unresolved first attempt into
success by forgetting the process. No delayed process-group or TTY-name
kill timer remains in main.

The macOS development tracker records PID and start time. It enumerates a
TTY only while its original shell is still present, rechecks recorded
identities before signals, stops discovering members after that anchor
leaves, and observes termination. Query/permission failure is not success.
Changing a child's process group or losing its controlling TTY does not
change its recorded birth identity. Main keeps an ownership snapshot for a
crashed host. Identity acquisition waits briefly for node-pty's spawn
helper to finish attaching its terminal.

This POSIX tracker is a development cleanup mechanism, not a kernel
containment boundary: ps start times have finite resolution and snapshots
cannot prove containment of every rapidly detached/daemonized descendant.
It must not enable the Windows or real-provider gates. Windows requires
Job Object ownership and its own end-to-end tests.

## Evidence

Evidence is kept in the maintainer archive outside the repository.
Eight initially failing regressions reproduced
read-only input, late grant revocation, login-shell inheritance,
close-before-ready, overlapping restart and false cleanup success. These
now pass alongside renderer ordering and process-identity regressions.

The actual Electron tests cover Unicode/ANSI output, observed PTY row and
column dimensions, Ctrl-C under output load, two independent terminals,
thread switching, close/restart, ordinary background-child cleanup and
English/Chinese/unavailable screenshots. A separate isolated native probe
observed cleanup of a TERM-ignoring background child and a background child
after deliberately crashing its utility host. It records before/after
process identities and the service's cleanup result. The maintainer decision
records the final test counts and source hashes; implementation reports
are not acceptance evidence.

Windows terminal, ordinary-user Windows installation, real authentication,
packaging, signing and updating are not tested by this slice.
