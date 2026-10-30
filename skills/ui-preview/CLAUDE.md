# UI Preview

Use this skill for headless screenshots, responsive/dark-mode checks, scripted
UI flows, console/network audits, and pixel diffs.

Read `SKILL.md` for the full workflow. `SKILL_DIR` is this folder.

```bash
SKILL_DIR=/path/to/ui-preview
PREVIEW="$SKILL_DIR/scripts/preview.mjs"

node "$PREVIEW" --out /tmp/page.png
node "$PREVIEW" --full --out /tmp/page-full.png
node "$PREVIEW" --device iphone-15 --dark --out /tmp/mobile.png
node "$PREVIEW" --selector '.card' --padding 16
node "$PREVIEW" --actions examples/dropdown-flow.json
node "$PREVIEW" --no-sandbox --full --fail-on-error
```

Show generated images with your harness's image viewer or attachment mechanism.
For multiple states use `scripts/contact-sheet.py` and show the sheet. Prefer
built-in browser tools when available; use this for headless/CI and portable
flows. Never commit temp screenshots.
