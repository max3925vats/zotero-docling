# Security Policy

## Supported versions

This project is in active development and only the **latest published release** is supported. Older versions will not receive backported security fixes — please update before reporting.

| Version        | Supported |
| -------------- | --------- |
| latest         | ✅        |
| anything older | ❌        |

## Reporting a vulnerability

**Please do not open a public GitHub Issue for security reports.** Use [GitHub's Private Vulnerability Reporting](https://github.com/max3925vats/zotero-docling/security/advisories/new) to send the report privately. That keeps the details off the public timeline until a fix is available.

If for some reason you cannot use Private Vulnerability Reporting, you can also reach the maintainer by opening a **draft** issue titled "Security: please reach out" without details, and we'll move the conversation to a private channel from there.

### What to include

- A clear description of the issue
- Steps to reproduce (specific Zotero version, docling-serve version, plugin version, sample input if relevant)
- The impact you observed (file written outside expected directory, sensitive data leak, etc.)
- Any mitigations you've found

### What to expect

This plugin is solo-maintained on a best-effort basis. Realistic expectations:

- **Acknowledgement**: within ~1 week of report
- **Triage and assessment**: within ~2 weeks
- **Fix and release**: depends on severity and complexity; critical issues prioritised

Reporters will be credited in the release notes unless they prefer to remain anonymous.

## Scope

This plugin runs inside Zotero's plugin sandbox and communicates with a user-configured `docling-serve` HTTP endpoint. In-scope security concerns include:

- **Arbitrary file write outside the intended location** — e.g. a crafted PDF or server response that escapes the temp directory or export folder
- **Prefs / config injection** — a flaw that lets external content mutate plugin preferences
- **Server URL handling** — anything that lets a malicious actor redirect conversions to an attacker-controlled server without user consent
- **Markdown injection that escapes its container** — e.g. content that breaks out of Zotero's storage model or escapes the markdown attachment context
- **Subprocess / privileged-API abuse** — the plugin does not currently spawn subprocesses, but if it ever does, that surface is in scope

## Out of scope

- **Bugs in [Docling](https://github.com/docling-project/docling) itself** — report those to the [Docling team](https://github.com/docling-project/docling/issues).
- **Bugs in [docling-serve](https://github.com/docling-project/docling-serve)** — report to [docling-serve's repository](https://github.com/docling-project/docling-serve/issues).
- **Zotero itself** — report to the [Zotero team](https://www.zotero.org/support/reporting_bugs).
- **Network-level attacks** when the user has configured a remote `serverUrl` over plain HTTP. The plugin trusts whatever endpoint the user points it at; use HTTPS for non-local servers.
- **Vulnerabilities that require the attacker to already have access to the user's Zotero profile directory** — at that point the attacker can already do worse things directly.

## A note on AGPL

This project is licensed under [AGPL-3.0-or-later](LICENSE). If you redistribute a modified version of this plugin, you are responsible for the security of your fork. Security fixes from upstream are not automatically applied to forks.
