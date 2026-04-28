import {
  App,
  Notice,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath
} from "obsidian";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import * as path from "path";

interface PluginSettings {
  qmdPath: string;
  collectionName: string;
  indexName: string;
  fileMask: string;
  maxResults: number;
}

const DEFAULT_SETTINGS: PluginSettings = {
  qmdPath: "qmd",
  collectionName: "",
  indexName: "",
  fileMask: "**/*.md",
  maxResults: 20
};

interface QmdJsonResult {
  file?: string;
  path?: string;
  title?: string;
  snippet?: string;
  score?: number;
  line?: number;
}

interface QmdCommand {
  executable: string;
  prefixArgs: string[];
  displayName: string;
}

interface QmdSetupStatus {
  hasCollection: boolean;
  indexedFiles: number;
  embeddings: number;
  pendingEmbeddings: number;
  hasEmbeddings: boolean;
  rawStatus: string;
}

interface QmdProgress {
  message: string;
  percent: number | null;
  detail?: string;
}

interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  line: number | null;
  file: TFile | null;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "vault";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveQmdCommand(configuredPath: string): QmdCommand {
  if (configuredPath !== "qmd") {
    return { executable: configuredPath, prefixArgs: [], displayName: configuredPath };
  }

  // Bun's generated qmd.exe shim can fail on Windows because QMD's bin script has
  // a /bin/sh shebang. Bypass the shim and run QMD's JS entrypoint with Bun.
  const bunExecutable = path.join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  const bunQmdScript = path.join(homedir(), ".bun", "install", "global", "node_modules", "@tobilu", "qmd", "dist", "cli", "qmd.js");
  if (existsSync(bunExecutable) && existsSync(bunQmdScript)) {
    return {
      executable: bunExecutable,
      prefixArgs: ["run", bunQmdScript],
      displayName: `${bunExecutable} run ${bunQmdScript}`
    };
  }

  return { executable: "qmd", prefixArgs: [], displayName: "qmd" };
}

class QmdClient {
  private currentSearch: ChildProcessWithoutNullStreams | null = null;
  private readonly runningProcesses = new Set<ChildProcessWithoutNullStreams>();
  private cancelled = false;

  constructor(
    private readonly qmdCommand: QmdCommand,
    private readonly vaultPath: string,
    private readonly collectionName: string,
    private readonly indexName: string,
    private readonly qmdEnv: Record<string, string>
  ) {}

  abortSearch(): void {
    if (this.currentSearch) {
      this.currentSearch.kill();
      this.currentSearch = null;
    }
  }

  resetCancellation(): void {
    this.cancelled = false;
  }

  cancelAll(): void {
    this.cancelled = true;
    for (const child of this.runningProcesses) child.kill();
    this.currentSearch = null;
  }

  async status(): Promise<string> {
    const result = await this.run(["status"], 15_000);
    return result.stdout;
  }

  async setupStatus(): Promise<QmdSetupStatus> {
    const [status, collections] = await Promise.all([
      this.status(),
      this.run(["collection", "list"], 30_000).catch(() => ({ stdout: "", stderr: "" }))
    ]);

    const indexedFiles = Number(status.match(/Total:\s+(\d+)\s+files?\s+indexed/i)?.[1] ?? 0);
    const embeddings = Number(status.match(/Vectors:\s+(\d+)\s+embedded/i)?.[1] ?? 0);
    const pendingEmbeddings = Number(status.match(/Pending:\s+(\d+)\s+need embedding/i)?.[1] ?? 0);
    const hasCollection = collections.stdout.includes(this.collectionName) || collections.stdout.includes(`qmd://${this.collectionName}/`);

    return {
      hasCollection,
      indexedFiles,
      embeddings,
      pendingEmbeddings,
      hasEmbeddings: embeddings > 0,
      rawStatus: status
    };
  }

  async ensureCollection(fileMask: string): Promise<void> {
    const list = await this.run(["collection", "list"], 30_000).catch(() => ({ stdout: "", stderr: "" }));
    if (list.stdout.includes(this.collectionName) || list.stdout.includes(`qmd://${this.collectionName}/`)) return;

    await this.run(["collection", "add", this.vaultPath, "--name", this.collectionName, "--mask", fileMask], 120_000);
  }

  async updateIndex(): Promise<void> {
    await this.run(["update"], 30 * 60_000);
  }

  async generateEmbeddings(force: boolean, onProgress?: (progress: QmdProgress) => void): Promise<void> {
    const before = await this.setupStatus().catch(() => null);
    const startVectors = force ? 0 : before?.embeddings ?? 0;
    const expectedWork = Math.max(1, force ? before?.embeddings ?? before?.pendingEmbeddings ?? 1 : before?.pendingEmbeddings ?? 1);

    onProgress?.({
      message: "Generating local embeddings…",
      percent: before?.pendingEmbeddings === 0 && !force ? null : 0,
      detail: before ? `${before.embeddings} vectors stored, ${before.pendingEmbeddings} pending` : undefined
    });

    let stopped = false;
    const poll = window.setInterval(() => {
      this.setupStatus()
        .then((status) => {
          const completed = Math.max(0, status.embeddings - startVectors);
          const percent = Math.max(0, Math.min(99, Math.round((completed / expectedWork) * 100)));
          onProgress?.({
            message: "Generating local embeddings…",
            percent,
            detail: `${status.embeddings} vectors stored${status.pendingEmbeddings > 0 ? `, ${status.pendingEmbeddings} pending` : ""}`
          });
        })
        .catch(() => undefined);
    }, 2500);

    try {
      await this.run(force ? ["embed", "-f"] : ["embed"], 2 * 60 * 60_000);
    } finally {
      stopped = true;
      window.clearInterval(poll);
    }

    if (stopped) {
      const after = await this.setupStatus().catch(() => null);
      onProgress?.({
        message: "Embeddings complete.",
        percent: 100,
        detail: after ? `${after.embeddings} vectors stored` : undefined
      });
    }
  }

  async semanticSearch(query: string, timeoutMs = 20_000): Promise<QmdJsonResult[]> {
    // Semantic search can be slow because QMD may load the local embedding model.
    // Keep the UI snappy by using a short caller-controlled timeout and falling
    // back to keyword results instead of making the user wait indefinitely.
    const result = await this.run(["vsearch", query, "-c", this.collectionName, "-n", "50", "--json"], timeoutMs, true);
    return this.parseJsonResults(result.stdout);
  }

  async keywordSearch(query: string, timeoutMs = 15_000): Promise<QmdJsonResult[]> {
    const result = await this.run(["search", query, "-c", this.collectionName, "-n", "50", "--json"], timeoutMs, true);
    return this.parseJsonResults(result.stdout);
  }

  private fullArgs(args: string[]): string[] {
    return this.indexName ? ["--index", this.indexName, ...args] : args;
  }

  private run(args: string[], timeoutMs: number, isSearch = false): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.qmdCommand.executable, [...this.qmdCommand.prefixArgs, ...this.fullArgs(args)], {
        cwd: this.vaultPath,
        env: { ...process.env, ...this.qmdEnv, NO_COLOR: "1" },
        shell: false,
        windowsHide: true
      });

      this.runningProcesses.add(child);
      if (isSearch) this.currentSearch = child;

      let stdout = "";
      let stderr = "";
      const maxOutputBytes = 10 * 1024 * 1024;
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.runningProcesses.delete(child);
        if (isSearch && this.currentSearch === child) this.currentSearch = null;
        fn();
      };

      const timer = window.setTimeout(() => {
        child.kill();
        finish(() => reject(new Error(`QMD command timed out after ${Math.round(timeoutMs / 1000)}s`)));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > maxOutputBytes) child.kill();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > maxOutputBytes) child.kill();
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        finish(() => {
          if (error.code === "ENOENT") reject(new Error(`QMD executable not found: ${this.qmdCommand.displayName}`));
          else reject(error);
        });
      });

      child.on("close", (code, signal) => {
        finish(() => {
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }

          if (this.cancelled || signal) {
            reject(new Error("QMD command cancelled."));
            return;
          }

          const detail = (stderr || stdout || `exit code ${code}${signal ? `, signal ${signal}` : ""}`).trim();
          reject(new Error(`QMD failed: ${detail}`));
        });
      });
    });
  }

  private parseJsonResults(output: string): QmdJsonResult[] {
    const json = this.extractJsonArray(output);
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error("QMD did not return a JSON array");
    return parsed;
  }

  private extractJsonArray(text: string): string {
    const start = text.indexOf("[");
    if (start < 0) throw new Error("No JSON array found in QMD output");

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') inString = true;
      else if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }

    throw new Error("Incomplete JSON array in QMD output");
  }
}

class SearchModal extends Modal {
  private inputEl: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private searchTimer: number | null = null;
  private requestId = 0;
  private results: SearchResult[] = [];
  private selectedIndex = 0;
  private searching = false;

  constructor(
    app: App,
    private readonly plugin: LocalQmdSemanticSearchPlugin,
    private readonly client: QmdClient
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lqmd-search-modal-container");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lqmd-search-modal");

    this.inputEl = contentEl.createEl("input", {
      type: "text",
      placeholder: "Semantic search this vault…",
      cls: "lqmd-search-input"
    });

    this.statusEl = contentEl.createDiv({ cls: "lqmd-search-status", text: "Search UI is ready. Fast keyword results appear first; semantic refinement is attempted briefly in the background." });
    this.resultsEl = contentEl.createDiv({ cls: "lqmd-search-results" });

    this.inputEl.addEventListener("input", () => this.scheduleSearch());
    this.inputEl.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.setTimeout(() => this.inputEl?.focus(), 0);
  }

  onClose(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.client.abortSearch();
    this.contentEl.empty();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.moveSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.moveSelection(-1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (this.results.length > 0) {
        void this.openResult(this.results[this.selectedIndex] ?? this.results[0]);
      } else if (!this.searching) {
        void this.performSearch(true);
      }
    }
  }

  private scheduleSearch(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    const query = this.inputEl?.value.trim() ?? "";

    if (query.length < 2) {
      this.results = [];
      this.selectedIndex = 0;
      this.renderResults();
      this.setStatus("Search UI is ready. Fast keyword results appear first; semantic refinement is attempted briefly in the background.");
      return;
    }

    this.setStatus("Waiting…");
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      void this.performSearch(false);
    }, 350);
  }

  private async performSearch(immediate: boolean): Promise<void> {
    const query = this.inputEl?.value.trim() ?? "";
    if (query.length < 2) return;

    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }

    const id = ++this.requestId;
    this.searching = true;
    this.client.abortSearch();
    this.setStatus(immediate ? "Searching fast index now…" : "Searching fast index…");

    try {
      const keywordRaw = await this.client.keywordSearch(query);
      if (id !== this.requestId) return;

      this.results = keywordRaw.slice(0, this.plugin.settings.maxResults).map((item) => this.plugin.toSearchResult(item));
      this.selectedIndex = 0;
      this.renderResults();

      if (this.results.length > 0) {
        this.setStatus(`${this.results.length} fast keyword result(s). Refining semantically for up to 20s…`);
      } else {
        this.setStatus("No keyword matches. Trying semantic search for up to 20s…");
      }

      let semanticRaw: QmdJsonResult[] = [];
      let semanticError = "";
      try {
        semanticRaw = await this.client.semanticSearch(query, 20_000);
      } catch (error) {
        semanticError = errorMessage(error);
      }

      if (id !== this.requestId) return;

      if (semanticRaw.length > 0) {
        this.results = semanticRaw.slice(0, this.plugin.settings.maxResults).map((item) => this.plugin.toSearchResult(item));
        this.selectedIndex = 0;
        this.renderResults();
        this.setStatus(`${this.results.length} semantic result(s) · Enter opens selected result`);
        return;
      }

      if (this.results.length > 0) {
        this.setStatus(semanticError
          ? `${this.results.length} keyword result(s). Semantic refinement was skipped/too slow: ${semanticError}`
          : `${this.results.length} keyword result(s). No stronger semantic matches found.`);
      } else {
        this.setStatus(semanticError
          ? `No matches found. Semantic search was skipped/too slow: ${semanticError}`
          : "No matches found. Try fewer words or press Ctrl/Cmd+P and run “Refresh semantic index now”.");
      }
    } catch (error) {
      if (id !== this.requestId) return;
      this.results = [];
      this.renderResults();
      this.setStatus(errorMessage(error));
      new Notice(errorMessage(error), 8_000);
    } finally {
      if (id === this.requestId) this.searching = false;
    }
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.setText(text);
  }

  private moveSelection(delta: number): void {
    if (this.results.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.results.length) % this.results.length;
    this.renderResults();
  }

  private renderResults(): void {
    if (!this.resultsEl) return;
    this.resultsEl.empty();

    for (const [index, result] of this.results.entries()) {
      const item = this.resultsEl.createDiv({ cls: "lqmd-search-result" });
      if (index === this.selectedIndex) item.addClass("is-selected");

      item.createDiv({ text: result.title, cls: "lqmd-title" });
      item.createDiv({ text: result.path, cls: "lqmd-path" });
      if (result.snippet) item.createDiv({ text: result.snippet, cls: "lqmd-snippet" });
      const meta = [];
      if (Number.isFinite(result.score)) meta.push(`score ${result.score.toFixed(3)}`);
      if (result.line !== null) meta.push(`line ${result.line}`);
      if (meta.length > 0) item.createDiv({ text: meta.join(" · "), cls: "lqmd-score" });

      item.addEventListener("mousemove", () => {
        this.selectedIndex = index;
        this.renderResults();
      });
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        void this.openResult(result);
      });
    }
  }

  private async openResult(result: SearchResult): Promise<void> {
    if (!result.file) {
      new Notice(`File not found in vault: ${result.path}`);
      return;
    }

    const query = this.inputEl?.value ?? "";
    const targetLine = await this.plugin.resolveResultLine(result, query);

    this.close();
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(result.file);

    if (targetLine !== null && targetLine > 0) {
      this.revealLine(leaf, targetLine, 12);
    }
  }

  private revealLine(leaf: ReturnType<App["workspace"]["getLeaf"]>, targetLine: number, attemptsLeft: number): void {
    window.setTimeout(() => {
      const view = leaf.view as unknown as { editor?: { setCursor: (pos: { line: number; ch: number }) => void; scrollIntoView: (range: { from: { line: number; ch: number }; to: { line: number; ch: number } }, center?: boolean) => void; focus?: () => void } };
      const editor = view.editor;

      if (!editor) {
        if (attemptsLeft > 0) this.revealLine(leaf, targetLine, attemptsLeft - 1);
        return;
      }

      const line = Math.max(0, targetLine - 1);
      editor.setCursor({ line, ch: 0 });
      editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
      editor.focus?.();
    }, 100);
  }
}

class SetupModal extends Modal {
  private summaryEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private progressTextEl: HTMLElement | null = null;
  private prepared = false;
  private running = false;
  private cancelling = false;
  private startButton: HTMLButtonElement | null = null;
  private closeButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly plugin: LocalQmdSemanticSearchPlugin,
    private readonly initialStatus: QmdSetupStatus | null = null,
    private readonly initialError = ""
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lqmd-setup");

    contentEl.createEl("h2", { text: "Prepare semantic search" });
    contentEl.createEl("p", {
      cls: "lqmd-requirements",
      text: "Requirement: this plugin needs the local QMD command-line tool installed first, for example with Bun (`bun install -g @tobilu/qmd`) or npm (`npm install -g @tobilu/qmd`). If QMD is missing, setup cannot run."
    });
    contentEl.createEl("p", {
      text: "This vault needs a local QMD collection, an index, and embeddings before semantic search can work. Nothing is sent to a server; QMD runs locally. After setup, press Ctrl/Cmd+P and run “Refresh semantic index now” from time to time when you add or edit notes. The plugin does not refresh automatically, so it has no background indexing impact while you use Obsidian. The first embedding run can take a while and may download QMD's local embedding model."
    });
    contentEl.createEl("p", {
      cls: "lqmd-howto",
      text: "Once ready, open semantic search with Ctrl/Cmd+Shift+S, the ribbon magnifying-glass icon, the QMD status bar item, or the command palette command “Semantic search”."
    });

    contentEl.createDiv({ cls: "lqmd-command", text: `QMD runner: ${this.plugin.qmdDisplayName()}` });
    contentEl.createDiv({ cls: "lqmd-command", text: `Local QMD database: ${this.plugin.qmdIndexPath()}` });

    if (this.initialError) {
      contentEl.createDiv({ cls: "lqmd-error", text: `Current problem: ${this.initialError}` });
    }

    this.summaryEl = contentEl.createEl("ul");
    this.updateSummary(this.initialStatus);

    this.statusEl = contentEl.createDiv({ cls: "lqmd-setup-status", text: "Ready to prepare this vault." });
    this.progressEl = contentEl.createDiv({ cls: "lqmd-progress is-hidden" });
    const progressTrack = this.progressEl.createDiv({ cls: "lqmd-progress-track" });
    this.progressFillEl = progressTrack.createDiv({ cls: "lqmd-progress-fill" });
    this.progressTextEl = this.progressEl.createDiv({ cls: "lqmd-progress-text", text: "Waiting…" });

    const buttons = contentEl.createDiv({ cls: "lqmd-setup-buttons" });
    const ready = this.initialStatus?.hasCollection === true && this.initialStatus?.hasEmbeddings === true && this.initialStatus.pendingEmbeddings === 0;
    this.prepared = ready;
    this.startButton = buttons.createEl("button", { text: ready ? "Open search" : "Prepare search" });
    this.startButton.addClass("mod-cta");
    this.startButton.addEventListener("click", () => this.prepared ? this.openSearchAndClose() : this.start());

    this.closeButton = buttons.createEl("button", { text: ready ? "Close" : "Later" });
    this.closeButton.addEventListener("click", () => this.close());
  }

  onClose(): void {
    if (this.running) this.plugin.cancelActiveTask();
    this.contentEl.empty();
  }

  private updateSummary(status: QmdSetupStatus | null): void {
    if (!this.summaryEl) return;
    this.summaryEl.empty();
    this.summaryEl.createEl("li", { text: `Collection: ${status?.hasCollection ? "exists" : "will be created"}` });
    this.summaryEl.createEl("li", { text: `Indexed files: ${status?.indexedFiles ?? 0}` });
    this.summaryEl.createEl("li", { text: `Embeddings: ${status?.embeddings ?? 0}` });
    this.summaryEl.createEl("li", { text: `Pending embeddings: ${status?.pendingEmbeddings ?? 0}` });
  }

  private async refreshSummary(): Promise<void> {
    try {
      this.updateSummary(await this.plugin.getSetupStatus());
    } catch {
      // Keep the previous summary; the visible status/error text will explain the issue.
    }
  }

  private updateProgress(progress: QmdProgress): void {
    if (this.statusEl) this.statusEl.setText(progress.message);
    if (this.progressEl) this.progressEl.removeClass("is-hidden");

    if (this.progressFillEl) {
      if (progress.percent === null) {
        this.progressFillEl.addClass("is-indeterminate");
        this.progressFillEl.style.width = "35%";
      } else {
        this.progressFillEl.removeClass("is-indeterminate");
        this.progressFillEl.style.width = `${Math.max(0, Math.min(100, progress.percent))}%`;
      }
    }

    if (this.progressTextEl) {
      const percentText = progress.percent === null ? "working…" : `${Math.round(progress.percent)}%`;
      this.progressTextEl.setText(progress.detail ? `${percentText} — ${progress.detail}` : percentText);
    }
  }

  private openSearchAndClose(): void {
    this.close();
    void this.plugin.openSearch();
  }

  private cancel(): void {
    if (!this.running || this.cancelling) return;
    this.cancelling = true;
    this.updateProgress({ message: "Cancelling QMD…", percent: null, detail: "Partial progress is kept; you can resume later." });
    if (this.startButton) {
      this.startButton.disabled = true;
      this.startButton.textContent = "Cancelling…";
    }
    this.plugin.cancelActiveTask();
  }

  private async start(): Promise<void> {
    if (this.running) {
      this.cancel();
      return;
    }

    this.running = true;
    this.cancelling = false;
    if (this.startButton) {
      this.startButton.disabled = false;
      this.startButton.textContent = "Cancel";
    }
    if (this.closeButton) this.closeButton.disabled = true;

    try {
      await this.plugin.prepareVaultForSearch(async (progress) => {
        this.updateProgress(progress);
        await this.refreshSummary();
      });
      await this.refreshSummary();
      this.updateProgress({ message: "Semantic search is ready. Press Ctrl/Cmd+Shift+S or click Open search.", percent: 100 });
      this.prepared = true;
      if (this.startButton) {
        this.startButton.disabled = false;
        this.startButton.textContent = "Open search";
      }
      if (this.closeButton) {
        this.closeButton.disabled = false;
        this.closeButton.textContent = "Close";
      }
      new Notice("Semantic search is ready.");
    } catch (error) {
      const message = errorMessage(error);
      const wasCancelled = this.cancelling || message.toLowerCase().includes("cancelled");
      this.updateProgress({
        message: wasCancelled ? "Preparation cancelled." : message,
        percent: null,
        detail: wasCancelled ? "Partial indexing/embeddings are kept. Click Resume when convenient." : undefined
      });
      if (this.startButton) {
        this.startButton.disabled = false;
        this.startButton.textContent = wasCancelled ? "Resume preparation" : "Prepare search";
      }
      if (this.closeButton) {
        this.closeButton.disabled = false;
        this.closeButton.textContent = "Close";
      }
      if (wasCancelled) new Notice("QMD preparation cancelled. You can resume later.");
      else new Notice(message, 10_000);
    } finally {
      this.running = false;
      this.cancelling = false;
    }
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LocalQmdSemanticSearchPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Local QMD Semantic Search" });
    containerEl.createEl("p", {
      text: "Requirement: install QMD locally first, e.g. `bun install -g @tobilu/qmd` or `npm install -g @tobilu/qmd`. This plugin only starts the local qmd executable. It does not use HTTP APIs or send vault contents anywhere. Embeddings are created by QMD, not by this plugin. Open search with Ctrl/Cmd+Shift+S, the ribbon icon, the status bar item, or the command palette."
    });

    new Setting(containerEl).setName("Status").setHeading();
    const statusContainer = containerEl.createDiv({ cls: "lqmd-settings-status" });
    this.plugin.renderSettingsStatus(statusContainer);

    new Setting(containerEl).setName("Configuration").setHeading();

    new Setting(containerEl)
      .setName("QMD executable")
      .setDesc("Use qmd if it is on PATH, otherwise use an absolute path.")
      .addText((text) => text
        .setPlaceholder("qmd")
        .setValue(this.plugin.settings.qmdPath)
        .onChange(async (value) => {
          this.plugin.settings.qmdPath = value.trim() || "qmd";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Collection name")
      .setDesc("Leave empty to derive it from the vault name.")
      .addText((text) => text
        .setPlaceholder(slugify(this.app.vault.getName()))
        .setValue(this.plugin.settings.collectionName)
        .onChange(async (value) => {
          this.plugin.settings.collectionName = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Index name")
      .setDesc("Optional QMD index override.")
      .addText((text) => text
        .setPlaceholder("default")
        .setValue(this.plugin.settings.indexName)
        .onChange(async (value) => {
          this.plugin.settings.indexName = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("File mask")
      .setDesc("Files QMD should add to the collection.")
      .addText((text) => text
        .setPlaceholder("**/*.md")
        .setValue(this.plugin.settings.fileMask)
        .onChange(async (value) => {
          this.plugin.settings.fileMask = value.trim() || "**/*.md";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Maximum results")
      .addSlider((slider) => slider
        .setLimits(5, 50, 5)
        .setValue(this.plugin.settings.maxResults)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxResults = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName("Actions").setHeading();

    new Setting(containerEl)
      .setName("Prepare vault")
      .setDesc("Create the collection, update the index, and generate embeddings in one guided local run.")
      .addButton((button) => button.setButtonText("Prepare").setCta().onClick(() => this.plugin.showSetupModal()));

    new Setting(containerEl)
      .setName("Test QMD")
      .setDesc("Runs qmd status.")
      .addButton((button) => button.setButtonText("Test").onClick(() => this.plugin.runUiTask(button.buttonEl, "Test", () => this.plugin.testQmd())));

    new Setting(containerEl)
      .setName("Create collection")
      .setDesc("Creates this vault's QMD collection if it does not exist.")
      .addButton((button) => button.setButtonText("Create").onClick(() => this.plugin.runUiTask(button.buttonEl, "Create", () => this.plugin.ensureCollection())));

    new Setting(containerEl)
      .setName("Refresh semantic index")
      .setDesc("Update changed markdown files and generate missing embeddings.")
      .addButton((button) => button.setButtonText("Refresh").onClick(() => this.plugin.runUiTask(button.buttonEl, "Refresh", () => this.plugin.refreshSemanticIndex())));

    new Setting(containerEl)
      .setName("Update index only")
      .setDesc("Indexes changed markdown files without generating embeddings.")
      .addButton((button) => button.setButtonText("Update").onClick(() => this.plugin.runUiTask(button.buttonEl, "Update", () => this.plugin.updateIndex())));

    new Setting(containerEl)
      .setName("Generate embeddings")
      .setDesc("Runs qmd embed locally. QMD may need to download its embedding model the first time.")
      .addButton((button) => button.setButtonText("Embed").onClick(() => this.plugin.runUiTask(button.buttonEl, "Embed", () => this.plugin.generateEmbeddings(false))));

    new Setting(containerEl)
      .setName("Force rebuild embeddings")
      .setDesc("Deletes/rebuilds QMD embeddings via qmd embed -f.")
      .addButton((button) => button
        .setWarning()
        .setButtonText("Rebuild")
        .onClick(() => this.plugin.runUiTask(button.buttonEl, "Rebuild", () => this.plugin.generateEmbeddings(true))));
  }
}

export default class LocalQmdSemanticSearchPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  private statusBarEl: HTMLElement | null = null;
  private activeTaskClient: QmdClient | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    if (!this.getVaultPath()) {
      new Notice("Local QMD Semantic Search is desktop-only.");
      return;
    }

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("lqmd-statusbar");
    this.statusBarEl.setText("QMD: checking…");
    this.statusBarEl.addEventListener("click", () => this.openSearch());

    this.addCommand({
      id: "semantic-search",
      name: "Semantic search",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "s" }],
      callback: () => this.openSearch()
    });

    this.addCommand({ id: "prepare-search", name: "Prepare semantic search", callback: () => this.showSetupModal() });
    this.addCommand({ id: "test-qmd", name: "Test QMD", callback: () => this.testQmd() });
    this.addCommand({ id: "create-collection", name: "Create collection", callback: () => this.ensureCollection() });
    this.addCommand({ id: "refresh-semantic-index", name: "Refresh semantic index now", callback: () => this.refreshSemanticIndex() });
    this.addCommand({ id: "update-index", name: "Update index only", callback: () => this.updateIndex() });
    this.addCommand({ id: "generate-embeddings", name: "Generate embeddings", callback: () => this.generateEmbeddings(false) });
    this.addCommand({ id: "force-rebuild-embeddings", name: "Force rebuild embeddings", callback: () => this.generateEmbeddings(true) });

    this.addRibbonIcon("search", "Semantic search", () => this.openSearch());
    this.addSettingTab(new SettingsTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => this.offerSetupIfNeeded(), 0);
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  createClient(): QmdClient {
    const vaultPath = this.getVaultPath();
    if (!vaultPath) throw new Error("Vault path is unavailable");
    this.ensureQmdStorageDirs();
    return new QmdClient(resolveQmdCommand(this.settings.qmdPath), vaultPath, this.collectionName(), this.settings.indexName, this.qmdEnvironment());
  }

  collectionName(): string {
    return this.settings.collectionName || slugify(this.app.vault.getName());
  }

  getVaultPath(): string | null {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
  }

  qmdDisplayName(): string {
    return resolveQmdCommand(this.settings.qmdPath).displayName;
  }

  qmdStorageDir(): string {
    const vaultPath = this.getVaultPath();
    if (!vaultPath) throw new Error("Vault path is unavailable");
    return path.join(vaultPath, this.app.vault.configDir, "plugins", this.manifest.id, "qmd");
  }

  qmdIndexPath(): string {
    return path.join(this.qmdStorageDir(), "index.sqlite");
  }

  qmdConfigDir(): string {
    return path.join(this.qmdStorageDir(), "config");
  }

  qmdConfigPath(): string {
    return path.join(this.qmdConfigDir(), `${this.settings.indexName || "index"}.yml`);
  }

  hasLocalQmdFiles(): boolean {
    return existsSync(this.qmdIndexPath()) && existsSync(this.qmdConfigPath());
  }

  ensureQmdStorageDirs(): void {
    mkdirSync(this.qmdStorageDir(), { recursive: true });
    mkdirSync(this.qmdConfigDir(), { recursive: true });
  }

  qmdEnvironment(): Record<string, string> {
    return {
      INDEX_PATH: this.qmdIndexPath(),
      QMD_CONFIG_DIR: this.qmdConfigDir()
    };
  }

  private setStatusBar(text: string, title = "Click to open QMD search/setup"): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.setText(text);
    this.statusBarEl.setAttr("title", title);
  }

  async refreshStatusBar(): Promise<void> {
    this.setStatusBar("QMD: checking…");
    try {
      const status = await this.createClient().setupStatus();
      if (status.hasCollection && status.hasEmbeddings) {
        this.setStatusBar(`QMD: ready (${status.embeddings} vectors)`, "Semantic search is ready. Click to search.");
      } else {
        this.setStatusBar("QMD: setup needed", "Click to create the local QMD index and embeddings.");
      }
    } catch (error) {
      this.setStatusBar("QMD: error", errorMessage(error));
    }
  }

  renderSettingsStatus(containerEl: HTMLElement): void {
    containerEl.empty();
    const box = containerEl.createDiv({ cls: "lqmd-status-box", text: "Checking QMD status…" });

    const renderRow = (parent: HTMLElement, label: string, value: string): void => {
      const row = parent.createDiv({ cls: "lqmd-status-row" });
      row.createSpan({ cls: "lqmd-status-label", text: label });
      row.createSpan({ cls: "lqmd-status-value", text: value });
    };

    this.createClient().setupStatus()
      .then((status) => {
        box.empty();
        renderRow(box, "QMD runner", this.qmdDisplayName());
        renderRow(box, "Database", this.qmdIndexPath());
        renderRow(box, "Config", this.qmdConfigPath());
        renderRow(box, "Vault", this.app.vault.getName());
        renderRow(box, "Collection", `${this.collectionName()} (${status.hasCollection ? "exists" : "missing"})`);
        renderRow(box, "Indexed files", String(status.indexedFiles));
        renderRow(box, "Embeddings", String(status.embeddings));
        renderRow(box, "Pending embeddings", String(status.pendingEmbeddings));
        renderRow(box, "Search", status.hasCollection && status.hasEmbeddings ? "ready" : "setup needed");
        this.renderStatusButtons(box, containerEl);
      })
      .catch((error) => {
        box.empty();
        renderRow(box, "QMD runner", this.qmdDisplayName());
        renderRow(box, "Database", this.qmdIndexPath());
        renderRow(box, "Config", this.qmdConfigPath());
        renderRow(box, "Vault", this.app.vault.getName());
        renderRow(box, "Status", "error");
        box.createDiv({ cls: "lqmd-error", text: errorMessage(error) });
        this.renderStatusButtons(box, containerEl);
      });
  }

  private renderStatusButtons(box: HTMLElement, root: HTMLElement): void {
    const buttons = box.createDiv({ cls: "lqmd-setup-buttons" });

    const refresh = buttons.createEl("button", { text: "Refresh" });
    refresh.addEventListener("click", () => this.renderSettingsStatus(root));

    const prepare = buttons.createEl("button", { text: "Prepare search" });
    prepare.addClass("mod-cta");
    prepare.addEventListener("click", () => this.showSetupModal());

    const search = buttons.createEl("button", { text: "Open search" });
    search.addEventListener("click", () => this.openSearch());
  }

  toSearchResult(item: QmdJsonResult): SearchResult {
    const vaultPath = this.getVaultPath() ?? "";
    const resultPath = this.cleanResultPath(item.file ?? item.path ?? "", vaultPath);
    const file = this.findFile(resultPath, item.title);
    const title = item.title || file?.basename || path.basename(resultPath, ".md") || resultPath;
    const rawSnippet = item.snippet ?? "";
    const snippetHeaderLine = Number(rawSnippet.match(/@@ -(\d+),\d+ @@/)?.[1] ?? Number.NaN);

    return {
      path: resultPath,
      title,
      snippet: rawSnippet.replace(/@@ -\d+,\d+ @@\s*\(\d+ before, \d+ after\)\s*/g, "").trim(),
      score: typeof item.score === "number" ? item.score : Number.NaN,
      line: typeof item.line === "number" && Number.isFinite(item.line)
        ? item.line
        : Number.isFinite(snippetHeaderLine) ? snippetHeaderLine : null,
      file
    };
  }

  cleanResultPath(rawPath: string, vaultPath: string): string {
    let cleaned = rawPath.trim();

    if (cleaned.startsWith("qmd://")) {
      const withoutScheme = cleaned.slice("qmd://".length);
      const slash = withoutScheme.indexOf("/");
      cleaned = slash >= 0 ? withoutScheme.slice(slash + 1) : withoutScheme;
    }

    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // Keep the original text if it is not URL-encoded.
    }

    cleaned = cleaned.replace(/\\/g, "/");

    if (path.isAbsolute(cleaned) && vaultPath) {
      const relative = path.relative(vaultPath, cleaned).replace(/\\/g, "/");
      if (!relative.startsWith("..")) cleaned = relative;
    }

    return normalizePath(cleaned).replace(/^\/+/, "");
  }

  async resolveResultLine(result: SearchResult, query: string): Promise<number | null> {
    if (!result.file) return result.line;

    const inferred = await this.inferLineFromContent(result.file, result.snippet, query, result.line).catch(() => null);
    if (inferred !== null) return inferred;

    return result.line;
  }

  private async inferLineFromContent(file: TFile, snippet: string, query: string, qmdLine: number | null): Promise<number | null> {
    const content = await this.app.vault.cachedRead(file);
    const lines = content.split(/\r?\n/);
    const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

    const normalizedQuery = normalize(query);
    const terms = Array.from(new Set(normalizedQuery.split(/\s+/).filter((term) => term.length >= 2)));
    const snippetLines = snippet
      .split(/\r?\n/)
      .map((line) => normalize(line.replace(/^\s*`+|`+\s*$/g, "")))
      .filter((line) => line.length >= 4);

    if (terms.length === 0 && snippetLines.length === 0) return qmdLine;

    let bestLine = -1;
    let bestScore = 0;

    for (let i = 0; i < lines.length; i++) {
      const fileLine = normalize(lines[i]);
      if (!fileLine) continue;

      let score = 0;

      // Strongest signal: exact normalized query phrase in the line. This catches
      // cases like query "ssh config" and note text "%USERPROFILE%\\.ssh\\config",
      // while avoiding weaker reversed wording like "config the ssh".
      if (normalizedQuery.length >= 4 && fileLine.includes(normalizedQuery)) score += 30;

      for (const term of terms) if (fileLine.includes(term)) score += 3;

      for (const snippetLine of snippetLines) {
        if (fileLine.includes(snippetLine) || snippetLine.includes(fileLine)) score += 8;
        for (const term of snippetLine.split(/\s+/).filter((part) => part.length >= 3)) {
          if (fileLine.includes(term)) score += 1;
        }
      }

      // QMD's line is useful but should not dominate exact phrase matches.
      if (qmdLine !== null && i + 1 === qmdLine) score += 4;

      if (score > bestScore) {
        bestScore = score;
        bestLine = i;
      }
    }

    return bestScore > 0 ? bestLine + 1 : qmdLine;
  }

  findFile(resultPath: string, title?: string): TFile | null {
    const direct = this.app.vault.getAbstractFileByPath(resultPath);
    if (direct instanceof TFile) return direct;

    const withMd = resultPath.endsWith(".md") ? resultPath : `${resultPath}.md`;
    const mdFile = this.app.vault.getAbstractFileByPath(withMd);
    if (mdFile instanceof TFile) return mdFile;

    const files = this.app.vault.getMarkdownFiles();
    const normalized = normalizePath(withMd).toLowerCase();
    const exact = files.find((file) => file.path.toLowerCase() === normalized || file.path.toLowerCase().endsWith(`/${normalized}`));
    if (exact) return exact;

    // QMD may return handelized/sluggified display paths such as
    // "00-create-python-project-etc.md" for an Obsidian file named
    // "00 Create Python Project etc.md". Fall back to slug matching.
    const wantedBaseSlug = slugify(path.basename(resultPath, ".md"));
    const wantedTitleSlug = title ? slugify(title) : "";
    const wantedPathSlug = slugify(resultPath.replace(/\.md$/i, ""));

    return files.find((file) => {
      const fileBaseSlug = slugify(file.basename);
      const filePathSlug = slugify(file.path.replace(/\.md$/i, ""));
      return fileBaseSlug === wantedBaseSlug
        || (wantedTitleSlug !== "" && fileBaseSlug === wantedTitleSlug)
        || filePathSlug === wantedPathSlug
        || filePathSlug.endsWith(`-${wantedBaseSlug}`);
    }) ?? null;
  }

  async openSearch(): Promise<void> {
    // Keep opening search instant. Do not run `qmd status` here; spawning Bun/QMD
    // can take seconds and makes the UI feel broken. Actual QMD work starts only
    // after the user types a query.
    new SearchModal(this.app, this, this.createClient()).open();
  }

  async offerSetupIfNeeded(): Promise<void> {
    try {
      // Fresh install/vault: avoid waiting for Bun/QMD startup just to discover
      // that the vault-local index/config do not exist yet.
      if (!this.hasLocalQmdFiles()) {
        this.setStatusBar("QMD: setup needed", "Click to create the local QMD index and embeddings.");
        new SetupModal(this.app, this, null).open();
        return;
      }

      const status = await this.createClient().setupStatus();
      if (!status.hasCollection || !status.hasEmbeddings) {
        this.setStatusBar("QMD: setup needed", "Click to create the local QMD index and embeddings.");
        new SetupModal(this.app, this, status).open();
      } else {
        this.setStatusBar(`QMD: ready (${status.embeddings} vectors)`, "Semantic search is ready. Click to search.");
      }
    } catch (error) {
      this.setStatusBar("QMD: error", errorMessage(error));
      new SetupModal(this.app, this, null, errorMessage(error)).open();
    }
  }

  async showSetupModal(): Promise<void> {
    try {
      new SetupModal(this.app, this, await this.createClient().setupStatus()).open();
    } catch (error) {
      new SetupModal(this.app, this, null, errorMessage(error)).open();
    }
  }

  async getSetupStatus(): Promise<QmdSetupStatus> {
    return this.createClient().setupStatus();
  }

  cancelActiveTask(): void {
    this.activeTaskClient?.cancelAll();
  }

  async prepareVaultForSearch(progress: (progress: QmdProgress) => void | Promise<void> = () => undefined): Promise<void> {
    const client = this.createClient();
    client.resetCancellation();
    this.activeTaskClient = client;

    try {
    await progress({ message: "Creating QMD collection if needed…", percent: 5 });
    await client.ensureCollection(this.settings.fileMask);

    await progress({ message: "Indexing markdown files…", percent: 15 });
    await client.updateIndex();

    const afterIndex = await client.setupStatus().catch(() => null);
    await progress({
      message: "Generating local embeddings… this can take a while.",
      percent: afterIndex?.pendingEmbeddings ? 20 : null,
      detail: afterIndex ? `${afterIndex.indexedFiles} files indexed, ${afterIndex.pendingEmbeddings} pending embeddings` : undefined
    });
    await client.generateEmbeddings(false, (embedProgress) => {
      void progress({
        ...embedProgress,
        percent: embedProgress.percent === null ? null : 20 + Math.round(embedProgress.percent * 0.8)
      });
    });

    const finalStatus = await client.setupStatus();
    await progress({
      message: "Finished checking QMD status…",
      percent: 100,
      detail: `${finalStatus.indexedFiles} files indexed, ${finalStatus.embeddings} embeddings, ${finalStatus.pendingEmbeddings} pending`
    });

    if (finalStatus.indexedFiles === 0) {
      throw new Error("QMD finished, but indexed 0 files. Check that this vault contains markdown files and that the file mask is **/*.md.");
    }

    if (finalStatus.embeddings === 0) {
      throw new Error("QMD finished, but created 0 embeddings. The embedding step may have failed or there may be no non-empty markdown content to embed.");
    }

    await this.refreshStatusBar();
    } finally {
      if (this.activeTaskClient === client) this.activeTaskClient = null;
    }
  }

  async testQmd(): Promise<void> {
    try {
      const status = await this.createClient().status();
      new Notice(status.trim() || "QMD responded.", 10_000);
    } catch (error) {
      new Notice(errorMessage(error), 10_000);
    }
  }

  async ensureCollection(): Promise<void> {
    try {
      await this.createClient().ensureCollection(this.settings.fileMask);
      await this.refreshStatusBar();
      new Notice(`QMD collection is ready: ${this.collectionName()}`);
    } catch (error) {
      new Notice(errorMessage(error), 10_000);
    }
  }

  async updateIndex(): Promise<void> {
    try {
      await this.createClient().updateIndex();
      await this.refreshStatusBar();
      new Notice("QMD index updated.");
    } catch (error) {
      new Notice(errorMessage(error), 10_000);
    }
  }

  async refreshSemanticIndex(): Promise<void> {
    try {
      this.setStatusBar("QMD: refreshing…", "Updating local QMD index and embeddings.");
      const client = this.createClient();
      await client.ensureCollection(this.settings.fileMask);
      await client.updateIndex();
      await client.generateEmbeddings(false);
      await this.refreshStatusBar();
      new Notice("QMD semantic index refreshed.");
    } catch (error) {
      await this.refreshStatusBar();
      new Notice(errorMessage(error), 10_000);
    }
  }

  async generateEmbeddings(force: boolean): Promise<void> {
    try {
      new Notice(force ? "Rebuilding embeddings locally..." : "Generating embeddings locally...");
      await this.createClient().generateEmbeddings(force);
      await this.refreshStatusBar();
      new Notice("QMD embeddings are ready.");
    } catch (error) {
      new Notice(errorMessage(error), 10_000);
    }
  }

  async runUiTask(buttonEl: HTMLButtonElement, _label: string, task: () => Promise<void>): Promise<void> {
    const previous = buttonEl.textContent ?? "Run";
    buttonEl.textContent = "Working...";
    buttonEl.disabled = true;
    try {
      await task();
    } finally {
      buttonEl.textContent = previous;
      buttonEl.disabled = false;
    }
  }
}
