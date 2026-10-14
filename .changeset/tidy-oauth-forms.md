---
"@noknok/cli": patch
---

Fix browser OAuth form submissions sending a null Origin, and allow completed or denied authorizations to return to the validated client callback. Preserve strict Origin, CSRF, state, PKCE and exact redirect checks. Require a DNS callback host or 127.0.0.1; reject CSP wildcards, directive delimiters and unsupported IP literals instead of registering callbacks the browser cannot reach.
