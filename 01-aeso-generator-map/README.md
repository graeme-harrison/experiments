# 01 - AESO Generator Status Map

Static web app that calls AESO public APIs directly from the browser.

## Files

- `index.html`: App layout.
- `styles.css`: App styling.
- `app.js`: AESO API integration, status merge, filtering, map rendering.
- `data/asset-coordinates.json`: Optional coordinate overrides by asset ID.
- `docs/aeso-api/`: Provided AESO OpenAPI specs.

## Notes

- API key is prefilled in the UI for this first experiment.
- Requests authenticate with `API-KEY` request header.
- If browser CORS blocks direct calls, use nginx proxy routes (`/aeso` or `/aeso-apimgw`).
- No coordinate fields are documented in the provided AESO OpenAPI specs; map points use AESO payload coordinates if present, otherwise `data/asset-coordinates.json` overrides.
