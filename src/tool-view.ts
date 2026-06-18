import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type PDFArtAnnotatorPlugin from "./main";
import { GuideType } from "./guides";
import { MAX_FONT_SIZE, MAX_STROKE_WIDTH, MIN_FONT_SIZE, Tool } from "./leaf-state";

export const VIEW_TYPE_PDF_ART_TOOLS = "pdf-art-annotator-tools";

const TOOL_OPTIONS: Array<{ id: Tool; label: string; icon: string }> = [
  { id: "pen", label: "画笔", icon: "pen-line" },
  { id: "highlighter", label: "荧光", icon: "highlighter" },
  { id: "eraser", label: "橡皮", icon: "eraser" },
  { id: "text", label: "文字", icon: "type" },
];

const GUIDE_OPTIONS: Array<{ id: GuideType; label: string }> = [
  { id: "grid-9", label: "9格" },
  { id: "grid-12", label: "12格" },
  { id: "golden-ratio", label: "黄金线" },
  { id: "golden-spiral", label: "螺旋" },
  { id: "diagonals", label: "对角十字" },
];

export class PDFArtToolView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly plugin: PDFArtAnnotatorPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_PDF_ART_TOOLS;
  }

  getDisplayText() {
    return "PDF Art tools";
  }

  getIcon() {
    return "pen-tool";
  }

  async onOpen() {
    this.render();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.render()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.render()));
  }

  async onClose() {}

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pdf-art-tool-view");

    const state = await this.plugin.nativeOverlay.getActiveState();
    const header = contentEl.createDiv({ cls: "pdf-art-tool-view-header" });
    header.createDiv({ text: "PDF Art", cls: "pdf-art-tool-view-title" });
    header.createDiv({
      text: state ? (state.getEnabled() ? "当前 PDF 已启用" : "当前 PDF 未启用") : "打开 PDF 后可用",
      cls: "pdf-art-tool-view-status",
    });

    const toggle = this.createButton(contentEl, state?.getEnabled() ? "关闭当前 PDF 标注" : "开启当前 PDF 标注", "power", async () => {
      await this.withState((activeState) => activeState.toggleEnabled());
    });
    toggle.addClass("pdf-art-tool-view-toggle");
    toggle.toggleClass("is-active", Boolean(state?.getEnabled()));
    toggle.disabled = !state;

    this.createSection(contentEl, "工具");
    const toolGrid = contentEl.createDiv({ cls: "pdf-art-tool-grid" });
    for (const tool of TOOL_OPTIONS) {
      const button = this.createButton(toolGrid, tool.label, tool.icon, async () => {
        await this.withState((activeState) => activeState.setTool(tool.id));
      });
      button.toggleClass("is-active", state?.getTool() === tool.id);
      button.disabled = !state;
    }

    this.createSection(contentEl, "构图辅助线");
    const guideGrid = contentEl.createDiv({ cls: "pdf-art-tool-grid" });
    for (const guide of GUIDE_OPTIONS) {
      const button = this.createButton(guideGrid, guide.label, "layout-grid", async () => {
        await this.withState((activeState) => activeState.setGuideType(guide.id));
      });
      button.toggleClass("is-active", state?.getTool() === "guide" && state.getGuideType() === guide.id);
      button.disabled = !state;
    }

    this.createSection(contentEl, "样式");
    const colorRow = contentEl.createDiv({ cls: "pdf-art-tool-field" });
    colorRow.createEl("label", { text: "颜色" });
    const color = colorRow.createEl("input", { type: "color", cls: "pdf-art-tool-color" });
    color.value = state?.getColor() ?? this.plugin.pluginSettings.defaultPenColor;
    color.disabled = !state;
    color.addEventListener("input", () => {
      void this.withState((activeState) => activeState.setColor(color.value), false);
    });
    color.addEventListener("change", () => {
      void this.withState((activeState) => activeState.setColor(color.value));
    });

    const widthRow = contentEl.createDiv({ cls: "pdf-art-tool-field" });
    widthRow.createEl("label", { text: state?.getTool() === "text" || state?.getSelectedText() ? "字号" : "粗细" });
    const width = widthRow.createEl("input", { type: "range", cls: "pdf-art-tool-range" });
    const textSizing = state?.getTool() === "text" || Boolean(state?.getSelectedText());
    width.min = textSizing ? String(MIN_FONT_SIZE) : "1";
    width.max = textSizing ? String(MAX_FONT_SIZE) : String(MAX_STROKE_WIDTH);
    width.step = "1";
    width.value = String(state?.getWidth() ?? this.plugin.pluginSettings.defaultPenWidth);
    width.disabled = !state;
    const widthValue = widthRow.createSpan({ text: width.value, cls: "pdf-art-tool-range-value" });
    width.addEventListener("input", () => {
      widthValue.setText(width.value);
      void this.withState((activeState) => activeState.setWidth(Number(width.value)), false);
    });
    width.addEventListener("change", () => {
      void this.withState((activeState) => activeState.setWidth(Number(width.value)));
    });

    this.createSection(contentEl, "操作");
    const actionGrid = contentEl.createDiv({ cls: "pdf-art-tool-grid" });
    const clear = this.createButton(actionGrid, "清除当前页", "trash-2", async () => {
      await this.withState((activeState) => activeState.clearCurrentPage());
    });
    clear.disabled = !state;
  }

  private createSection(container: HTMLElement, label: string) {
    container.createDiv({ text: label, cls: "pdf-art-tool-section" });
  }

  private createButton(container: HTMLElement, label: string, icon: string, onClick: () => Promise<void>) {
    const button = container.createEl("button", { cls: "pdf-art-tool-button" });
    const iconEl = button.createSpan({ cls: "pdf-art-tool-button-icon" });
    setIcon(iconEl, icon);
    button.createSpan({ text: label });
    button.addEventListener("click", () => {
      void onClick();
    });
    return button;
  }

  private async withState(action: (state: NonNullable<Awaited<ReturnType<PDFArtAnnotatorPlugin["nativeOverlay"]["getActiveState"]>>>) => void | Promise<void>, refresh = true) {
    const state = await this.plugin.nativeOverlay.getActiveState();
    if (!state) {
      new Notice("请先打开一个 PDF 文件");
      await this.render();
      return;
    }
    await action(state);
    if (refresh) await this.render();
  }
}
