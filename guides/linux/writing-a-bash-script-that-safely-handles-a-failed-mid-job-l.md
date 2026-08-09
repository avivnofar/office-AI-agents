<!--
Written by: The Team Lead (draft)
Finalized by: The Architect (final review + fact-check)
Date: 2026-08-09
Domain: linux
Source: gap:3be2f92f-cafc-417d-bbd7-b18dc50496b7
-->

# Technical Guide: Implementing Robust Lock File Management in Bash

## Introduction
In automated systems, scripts frequently require mutual exclusion to prevent concurrent execution of resource-intensive tasks. Relying on simple file presence checks often leads to "stale" lock files when a process is terminated abruptly—via `SIGKILL`, system power loss, or hardware failure. This guide outlines professional, production-grade patterns for handling lock files safely in Bash, ensuring that automation remains resilient against mid-job crashes.

## The Problem with Naive Locking
Confidence: high

A naive implementation typically checks for a file's existence and creates it if absent:
```bash
if [ -f "$LOCKFILE" ]; then
    echo "Job already running."
    exit 1
fi
touch "$LOCKFILE"
# ... job ...
rm "$LOCKFILE"
```
This pattern contains a fatal race condition known as a "Time-of-Check to Time-of-Use" (TOCTOU) vulnerability. Between the `if` check and the `touch` command, a context switch could allow another instance to run, leading to both processes believing they hold the lock. Furthermore, if the script dies before reaching `rm`, the system remains locked until manual intervention occurs.

## The Atomic Solution: `mkdir`
Confidence: high

The most reliable way to handle locking in POSIX-compliant environments is using the `mkdir` command. Unlike `touch` or file redirection, `mkdir` is an atomic system call at the kernel level. If two processes attempt to create the same directory simultaneously, the underlying filesystem ensures only one succeeds; the other will receive a non-zero exit code.

Implementation pattern:
```bash
LOCKDIR="/var/run/myjob.lock"

if mkdir "$LOCKDIR" 2>/dev/null; then
    # Successfully created, trap exit to ensure cleanup
    trap 'rmdir "$LOCKDIR"' EXIT
else
    echo "Job is currently running or previous run crashed."
    exit 1
fi
```
Using `trap` ensures that even if the script is interrupted by standard signals (like `SIGINT` or `SIGTERM`), the directory is removed, preventing unnecessary manual cleanup. Note that `trap ... EXIT` cannot run if the process receives `SIGKILL`, since that signal cannot be caught or trapped — this is why PID verification or `flock`-based approaches (below) are needed to handle truly abrupt terminations.

## Handling Stale Locks via PID Verification
Confidence: high

When using process-based locks, one must account for stale files. To address the scenario where a process was killed via `SIGKILL` (which cannot be trapped), developers often store the Process ID (PID) inside a lock file.

**A Critical Caveat: The PID Reuse Problem**
When implementing PID checks, one must be aware that PIDs are not unique for the lifetime of the system; they are recycled by the kernel. If a process dies and the system assigns its PID to an entirely different, unrelated process, a check like `ps -p "$PID"` will return true, falsely indicating that the lock is still held by the original script.

To mitigate this, one should ideally verify the process command line or start time (e.g., via `/proc/[pid]/stat` or `ps -o lstart= -p "$PID"`) to ensure the process being checked is indeed the expected instance of your script.

## Advanced Patterns: File Descriptor Locking
Confidence: high

For high-concurrency environments, relying on file existence is less robust than using `flock`. The `flock` utility is provided by the `util-linux` package (not GNU Coreutils). It creates an advisory lock on a file descriptor. This is superior because the kernel automatically releases the lock when the process terminates, regardless of how it terminated (even after `SIGKILL`).

```bash
(
    flock -n 200 || exit 1
    # Critical section code here
) 200>/var/lock/myjob.lock
```
In this snippet, `flock -n 200` attempts to acquire an exclusive lock on file descriptor 200. If it fails, it exits immediately. Because the file descriptor is tied to the process life cycle, the kernel manages the cleanup, making this the "gold standard" for scripts requiring high reliability.

## Conclusion and Best Practices
Confidence: high

When designing your automation scripts:
1. **Prefer `flock`:** It is the most robust method as it offloads lock management to the kernel and is unaffected by `SIGKILL`.
2. **Use `trap`:** Always clean up your resources on `EXIT`, `SIGINT`, and `SIGTERM` — but remember `trap` cannot protect against `SIGKILL`.
3. **Validate PIDs with Caution:** If you must use file-based locks, be aware that PIDs can be recycled. Always verify that the process is not just running, but is the *correct* process (e.g., comparing start times).
4. **Log Failures:** Always provide clear diagnostic output when a lock is detected, so administrators can distinguish between a busy system and a hung process.

## Sources
Confidence: high

- **util-linux Documentation:** *flock(1) man page* – Describes the advisory locking mechanism provided by the util-linux package.
- **IEEE Std 1003.1 (POSIX.1):** *System Interfaces - mkdir(2) and kill(2) specifications.*
- **Advanced Bash-Scripting Guide (Mendel Cooper):** *Chapter 20: Signals and Traps.*
- **Linux Programmer's Manual:** *proc(5) – details on accessing process information for PID lifecycle and validation.*
