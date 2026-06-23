import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { AnnotationStore } from "./storage";
import { NativePDFArtLeafState, NativeOverlaySettings, SELECTORS } from "./leaf-state";

export class NativePDFArtOverlayManager {
  private states = new Map<WorkspaceLeaf, NativePDFArtLeafState>();
  private activePDFLeaf: WorkspaceLeaf | null = null;
  private activeStateCache: NativePDFArtLeafState | null = null;
  private syncPromise: Promise<NativePDFArtLeafState | null> | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly store: AnnotationStore,
    private readonly getSettings: () => NativeOverlaySettings,
    private readonly onStateChange: () => void = () => {}
  ) {}

  async syncActiveLeaf(): Promise<NativePDFArtLeafState | null> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.doSyncActiveLeaf();
    try {
      return await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  async getActiveState() {
    return this.syncActiveLeaf();
  }

  private async doSyncActiveLeaf(): Promise<NativePDFArtLeafState | null> {
    const leaf = this.findPDFLeaf();
    if (!leaf) {
      this.destroyInactiveStates(null);
      this.activeStateCache = null;
      return null;
    }
    this.activePDFLeaf = leaf;
    this.activeStateCache = await this.syncLeaf(leaf);
    return this.activeStateCache;
  }

  private async syncLeaf(leaf: WorkspaceLeaf): Promise<NativePDFArtLeafState | null> {
    const view = leaf.view as any;
    const file = view.file instanceof TFile ? view.file : this.plugin.app.workspace.getActiveFile();
    if (!file || file.extension.toLowerCase() !== "pdf") {
      if (this.activePDFLeaf === leaf) this.activePDFLeaf = null;
      return null;
    }
    const root = view.containerEl as HTMLElement | undefined;
    if (!root?.querySelector(SELECTORS.viewerContainer)) {
      if (this.activePDFLeaf === leaf) this.activePDFLeaf = null;
      return null;
    }

    this.destroyInactiveStates(leaf);
    let state = this.states.get(leaf);
    if (!state) {
      state = new NativePDFArtLeafState(leaf, this.store, this.getSettings, this.onStateChange);
      this.states.set(leaf, state);
    }
    await state.sync();
    return state;
  }

  private findPDFLeaf(): WorkspaceLeaf | null {
    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    if (activeLeaf && this.isPDFLeaf(activeLeaf)) return activeLeaf;
    if (this.activePDFLeaf && this.isPDFLeaf(this.activePDFLeaf)) return this.activePDFLeaf;

    let found: WorkspaceLeaf | null = null;
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && this.isPDFLeaf(leaf)) found = leaf;
    });
    return found;
  }

  private isPDFLeaf(leaf: WorkspaceLeaf): boolean {
    try {
      const view = leaf.view as any;
      const file = view?.file instanceof TFile ? view.file : null;
      if (!file || file.extension.toLowerCase() !== "pdf") return false;
      const root = view?.containerEl as HTMLElement | undefined;
      return Boolean(root?.querySelector(SELECTORS.viewerContainer));
    } catch {
      return false;
    }
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

  destroy() {
    for (const state of this.states.values()) state.destroy();
    this.states.clear();
    this.activePDFLeaf = null;
  }
}
