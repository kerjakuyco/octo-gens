# Security

Octo Gens can hold exchange API keys and send real orders, so security reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue. Use **Report a vulnerability** under the repository's [Security tab](https://github.com/kerjakuyco/octo-gens/security/advisories/new), which opens a private advisory visible only to the maintainers.

Include what you found, how to reproduce it, and what an attacker could do with it. Never include real API keys; revoke any key that was exposed while testing.

Fixes are released for the latest version only.

## How the app protects you

| Risk | Protection |
| --- | --- |
| The model places a trade you did not want | No tool can place, change or cancel an order. The assistant drafts a ticket and you confirm it. Live tickets from the assistant are off by default. |
| A double click sends an order twice | A draft is consumed by its first submission. Live orders carry a client id, so the exchange rejects a repeat. |
| Keys leak to disk | The OpenRouter key and remembered exchange keys live in the system keychain. Preferences, the journal and snapshots never contain them. |
| Keys leak to a model or the interface | Keys never enter prompts, tool results or the web view. Errors and answers are scrubbed of the OpenRouter key. |
| A hostile page or tool output hijacks the app | The web view has no network access and can only call the app's own commands. The model is told to treat tool output as data, and the rules above hold even if it is fooled. |
| A signed request is replayed elsewhere | HTTP redirects are never followed. Signed requests are sent once, to the exchange's main host only. |
| An MCP server does more than read | The assistant may call only tools a server marks read-only. Official servers are pinned to exact versions. |

## What you should do

- Create exchange API keys **without withdrawal permission**, and restrict them to your IP address where the exchange allows it.
- Attach only MCP servers you trust. A custom command runs with your user's permissions.
- Keep the app up to date.

## Limits you should know

- If your system has no keychain, keys are kept in memory for the session and must be entered again next launch.
- Local builds are not code-signed. Signed, notarized installers need certificates this repository does not hold.
- The paper account ignores fees and slippage. It is for practice, not a prediction of live results.
