# Experiments Workspace

## Postmortem: Alberta AESO experiment (failed run)

### What went wrong
- The integration was built against incorrect/assumed AESO endpoint patterns before validating the exact APIM gateway routes in use.
- Nginx proxy updates were changed repeatedly while API contract details were still uncertain, which created extra failure modes and slowed debugging.
- The implementation moved ahead without first proving a single successful end-to-end API call (`curl` from local nginx proxy to AESO APIM endpoint).

### Why this failed (agent process issue)
- The agent did not lock to the current primary API source of truth first (the official AESO APIM docs/portal routes provided by the user).
- The agent relied on inferred or mixed endpoint conventions instead of validating exact path + header requirements with a minimal reproducible call sequence.
- The agent changed multiple layers (app + nginx + fallback logic) before stabilizing the base API connectivity.

### What an agent must do better next time
1. Start by confirming the exact AESO APIM gateway host and endpoint paths from the current official docs the user points to.
2. Validate one endpoint with `curl` directly to gateway, then through nginx proxy, before writing app code.
3. Freeze config scope: make one minimal nginx change, test, and only then proceed.
4. Implement app integration only after successful proxy validation (`200` + expected JSON schema).
5. Keep contract assumptions explicit in this README (host, path, required headers, expected status codes).
6. Avoid adding fallback architectures until the primary integration is proven working.
