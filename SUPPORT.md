# Support

Grok UI is an independent community project.

Before opening an issue:

1. Run `grok-ui doctor`.
2. Confirm the problem still occurs on the latest release.
3. Search existing issues.
4. Reduce the report to a sanitized reproduction.

Use the bug template for reproducible failures and the feature template for
new workflows. GitHub Discussions can be used for general questions when
enabled on the repository.

Never post credentials, access tokens, prompts, source code, local session
archives, personal names, private filesystem paths, or public IP addresses.
Report suspected vulnerabilities through GitHub private vulnerability
reporting as described in [SECURITY.md](SECURITY.md).

## State recovery

If startup reports that `state.json` could not be loaded, Grok UI preserves the
file and disables writes instead of replacing session annotations, managed
sessions, or usage history with an empty store. Stop the server, keep a copy of
the file named in the error (normally `~/.grok-ui/state.json`), and restore a
known-good backup or repair the reported format or access problem. Restart
after the repair. For an unsupported newer version, use a Grok UI version that
supports that file; do not change the version number by hand. Do not delete the
file unless you intentionally want to discard its stored UI state.

A single invalid record (one session, annotation, or usage entry) does not stop
startup. Grok UI copies the original to `state.json.invalid-<timestamp>` next to
it, logs how many records it skipped, and continues with the rest.
