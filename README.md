# Obsidian QMD Semantic Search

A minimal, local-first Obsidian desktop plugin for semantic search through your vault using [QMD](https://github.com/tobi/qmd).

The plugin is intentionally small: it provides the Obsidian UI, vault setup flow, search modal, and file-opening behavior. QMD does the actual indexing, embedding, and searching locally.

## What you get

- Local semantic search for an Obsidian vault.
- Fast keyword results first, then brief semantic refinement.
- Manual-only refresh: no background indexing while you write.
- Vault-local QMD database/config.
- Click a result to open the matching note and jump near the relevant line.
- Setup modal with progress, cancel/resume, and clear status.
- Suggested hotkey: `Ctrl/Cmd + Shift + S` (assign it in Obsidian hotkey settings if you want it).

## Requirements

This plugin requires the local QMD command-line tool to be installed first.

Install QMD with Bun:

```bash
bun install -g @tobilu/qmd
```

Or with npm:

```bash
npm install -g @tobilu/qmd
```

You can test QMD outside Obsidian with:

```bash
qmd status
```

### Note for Bun on Windows

On some Windows systems, Bun's generated `qmd.exe` shim may fail because QMD's package entrypoint uses a shell script. This plugin detects Bun's global QMD install and bypasses the shim by running QMD's JavaScript CLI through Bun directly:

```text
bun run ~/.bun/install/global/node_modules/@tobilu/qmd/dist/cli/qmd.js ...
```

So the plugin can still work even if the `qmd` shim itself is unreliable.

## Installation

Download the latest `qmd-semantic-search.zip` from the [GitHub Releases page](https://github.com/winboost/obsidian-qmd-semantic-search/releases), then extract it into your vault so the folder is named `qmd-semantic-search`.

The release contains these three production files:

```text
main.js
manifest.json
styles.css
```

Alternatively, build from source and copy those same three files into your vault:

```text
<your-vault>/.obsidian/plugins/qmd-semantic-search/
```

Final structure:

```text
<your-vault>/.obsidian/plugins/qmd-semantic-search/main.js
<your-vault>/.obsidian/plugins/qmd-semantic-search/manifest.json
<your-vault>/.obsidian/plugins/qmd-semantic-search/styles.css
```

Then in Obsidian:

1. Open **Settings → Community plugins**.
2. Disable **Restricted mode** if needed.
3. Enable **Obsidian QMD Semantic Search**.

## First-run setup

When the plugin starts, it checks whether this vault has a local QMD index.

If not, it opens a setup window explaining what will happen:

1. Create a QMD collection for the vault.
2. Index markdown files.
3. Generate local embeddings.

Click **Prepare search**.

The setup window shows:

- QMD runner path.
- Local QMD database path.
- collection status.
- indexed file count.
- embedding count.
- pending embeddings.
- progress bar.

You can cancel during preparation. Partial progress is kept, and you can resume later.

## How to search

After setup, open semantic search with any of these:

- the ribbon magnifying-glass icon
- the bottom status bar item
- command palette → **Semantic search**

Optional: assign `Ctrl/Cmd + Shift + S` to **Semantic search** in Obsidian hotkey settings.

Type a query. The plugin shows fast keyword results first and then tries semantic refinement briefly.

Why this design? Local semantic search can be slow on the first query because QMD may need to load the embedding model. Showing keyword results first keeps the UI responsive.

## Opening results

Click a result or press `Enter` on the selected result.

The plugin opens the note and tries to jump to the relevant part inside the note. It uses QMD's line information when available and also falls back to matching the snippet/query against the note content.

For very broad semantic matches, line placement may not be perfect, but the plugin tries to land near the relevant section instead of only opening the file at the top.

## Updating the index when notes change

The plugin intentionally does **not** refresh automatically.

That is a deliberate performance/privacy/UX choice: no background indexing, no hidden embedding jobs, no surprise CPU/GPU usage while you are writing.

When you add or edit notes and want search to include them, open the command palette with `Ctrl/Cmd + P` and run:

```text
Obsidian QMD Semantic Search: Refresh semantic index now
```

Or open plugin settings and click:

```text
Refresh semantic index
```

This runs locally:

```text
qmd update
qmd embed
```

## Where data is stored

The vault-specific QMD database and config are stored inside the vault plugin folder:

```text
<your-vault>/.obsidian/plugins/qmd-semantic-search/qmd/index.sqlite
<your-vault>/.obsidian/plugins/qmd-semantic-search/qmd/config/index.yml
```

This keeps each vault's index separate.

Large downloaded QMD model files are still stored in QMD's normal global model cache, for example:

```text
~/.cache/qmd/models/
```

This avoids downloading/copying large model files for every vault.

## Privacy model

This plugin does not call remote APIs.

It does not use:

- `fetch`
- HTTP requests
- telemetry
- analytics
- cloud LLM APIs

It only starts the local QMD executable through `child_process.spawn()` with `shell: false` and argument arrays.

Important distinction: this plugin can only vouch for its own behavior. QMD is separate software. QMD may download local models from Hugging Face the first time embeddings are generated.

## How it works

The plugin delegates to local QMD commands:

```text
qmd collection add <vault> --name <collection> --mask **/*.md
qmd update
qmd embed
qmd search <query> --json
qmd vsearch <query> --json
```

QMD stores documents and vectors in SQLite. Semantic search works by converting text to vectors with a local embedding model, then finding nearby vectors for your query.

No chat LLM is required for embeddings. An embedding model is an AI model, but it can run fully locally and simply maps text to numeric vectors.

## Build from source

```bash
npm install
npm run build
```

Or with Bun:

```bash
bun install
bun run build
```

The build outputs:

```text
main.js
manifest.json
styles.css
```

## Repository layout

```text
src/main.ts             plugin source
main.js                 bundled production plugin
manifest.json           Obsidian plugin manifest
styles.css              plugin styles
production/qmd-semantic-search copy-ready production folder
```

## Troubleshooting

### QMD is missing

Install it:

```bash
bun install -g @tobilu/qmd
```

or:

```bash
npm install -g @tobilu/qmd
```

Then restart Obsidian.

### Search is stale

Open the command palette with `Ctrl/Cmd + P` and run:

```text
Refresh semantic index now
```

### Search opens but results are weak

Try fewer words or more exact terms. Technical command searches often work better with keyword matching, which the plugin shows first.

### Semantic search is slow

The first semantic query may need to load the local embedding model. Later queries are usually faster. The plugin uses keyword-first search so you are not stuck waiting for semantic results.

### I want no background impact

That is the default. The plugin does not auto-refresh. It only indexes/embeds when you explicitly prepare or refresh.

## License

MIT
