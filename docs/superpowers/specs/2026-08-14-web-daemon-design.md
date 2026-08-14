# Web daemon launch design

## Scope

`dsh web` gains optional detached execution for local Web UI servers. The foreground invocation and all existing Web options keep their current behavior.

## Command line

`dsh web --daemon` and `dsh web --background` are equivalent aliases. Either flag may appear with existing Web options, and passing both starts one child. These flags are valid only for the Web profile.

`dsh web --help` takes precedence over detached execution. An invocation that includes `--help` and either alias prints Web help and does not create a child process.

## Process lifetime

The foreground CLI process removes the detached-execution flags, re-executes the same Node entry point with the remaining original arguments, and exits after the child process is created. The child uses the unchanged Web profile boot path, so it retains the existing host, port, trust, readiness, and signal-disposal behavior.

The parent launches a cross-platform detached child, closes its standard input, redirects standard output and standard error to one log file under `$DSH_HOME/logs/`, releases its process reference, and prints the child PID and log path. The successful parent result means that the child was created; it does not assert that the Web server completed startup.

## Failures and operation

Failure to create the log directory, open the log file, or spawn the child reports an error and exits nonzero. Failures that happen during ordinary Web startup remain in the child log and use the existing Web failure behavior. The feature does not add service management commands, startup-at-login behavior, non-loopback listening, or readiness polling.

## Implementation and tests

The CLI owns detached-process orchestration because it must occur before the Web profile mounts. A focused helper receives the original argv, identifies and removes the aliases, constructs the child launch, and is dependency-injectable for unit tests.

Tests cover both aliases, duplicate aliases, argument preservation, help precedence, failed log or spawn setup, and the detached child launch options. A built-CLI integration test starts a Web child, observes a response after the parent exits, and terminates the child through the existing process signal path.
