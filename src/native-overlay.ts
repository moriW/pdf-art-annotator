import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { AnnotationStore } from "./storage";
import { NativePDFArtLeafState, NativeOverlaySettings, SELECTORS, SYNC_DEBOUNCE_MS } from "./leaf-state";

export class NativePDFArtOverlayManager {
  private states = new Map<WorkspaceLeaf, NativePDFArtLeafState>();
  private syncTimer: number | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly store: AnnotationStore,
    private readonly getSettings: () => NativeOverlaySettings
  ) {}

  scheduleSync() {
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      void this.syncActiveLeaf();
    }, SYNC_DEBOUNCE_MS);
  }

  async syncActiveLeaf(): Promise<NativePDFArtLeafState | null> {
    const leaf = this.plugin.app.workspace.activeLeaf;
    if (!leaf) {
      this.destroyInactiveStates(null);
      return null;
    }
    const view = leaf.view as any;
    const file = view.file instanceof TFile ? view.file : this.plugin.app.workspace.getActiveFile();
    if (!file || file.extension.toLowerCase() !== "pdf") {
      this.destroyInactiveStates(null);
      return null;
    }
    const root = view.containerEl as HTMLElement | undefined;
    if (!root?.querySelector(SELECTORS.viewerContainer)) {
      this.destroyInactiveStates(null);
      return null;
    }

    this.destroyInactiveStates(leaf);
    let state = this.states.get(leaf);
    if (!state) {
      state = new NativePDFArtLeafState(leaf, this.store, this.getSettings);
      this.states.set(leaf, state);
    }
    await state.sync();
    return state;
  }

  private destroyInactiveStates(activeLeaf: WorkspaceLeaf | null) {
    for (const [leaf, state] of Array.from(this.states.entries())) {
      if (activeLeaf && leaf === activeLeaf) continue;
      state.destroy();
      this.states.delete(leaf);
    }
  }

  async toggleActiveLeaf() {
    const state = await this.syncActiveLeaf();
    if (state) {
      state.toggleEnabled();
    } else {
      new Notice("请先打开一个 PDF 文件");
    }
  }

  async getActiveState() {
    return this.syncActiveLeaf();
  }

  destroy() {
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    for (const state of this.states.values()) state.destroy();
    this.states.clear();
  }
}
