import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type PDFArtAnnotatorPlugin from "./main";
import { MAX_FONT_SIZE, MAX_STROKE_WIDTH, MIN_FONT_SIZE, MIN_STROKE_WIDTH, Tool } from "./leaf-state";
import { GuideType } from "./guides";

export const VIEW_TYPE_PDF_ART_TOOLS = "pdf-art-annotator-tools";

const TOOL_OPTIONS: Array<{ id: Tool; label: string; icon: string }> = [
  { id: "select", label: "选择", icon: "mouse-pointer-2" },
  { id: "pen", label: "画笔", icon: "pen-line" },
  { id: "highlighter", label: "荧光", icon: "highlighter" },
  { id: "eraser", label: "橡皮", icon: "eraser" },
  { id: "text", label: "文字", icon: "type" },
  { id: "guide", label: "构图", icon: "layout-grid" },
];

const GUIDE_OPTIONS: Array<{ id: GuideType; label: string }> = [
  { id: "grid-9", label: "9宫格" },
  { id: "grid-16", label: "16宫格" },
  { id: "golden-ratio", label: "黄金分割" },
  { id: "golden-spiral", label: "黄金螺旋" },
];

export class PDFArtToolView extends ItemView {
  private renderVersion = 0;

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
    void this.render();
    this.registerEvent(this.app.workspace.on("layout-change", () => void this.render()));
  }

  async onClose() {}

  async render() {
    try {
      const version = ++this.renderVersion;
      const state = await this.plugin.nativeOverlay.getActiveState();
      if (version !== this.renderVersion) return;
      const selection = state?.getSelection() ?? [];
      const selectionCount = selection.length;
      const selectionIsTextOnly = selectionCount > 0 && selection.every((item) => item.type === "text");

      const { contentEl } = this;
      contentEl.empty();
      contentEl.addClass("pdf-art-tool-view");
      const header = contentEl.createDiv({ cls: "pdf-art-tool-view-header" });
      header.createDiv({ text: "PDF Art", cls: "pdf-art-tool-view-title" });
      header.createDiv({
        text: state
          ? `${state.getRendered() ? "标注层已显示" : "标注层已隐藏"} · ${state.getEnabled() ? "标注模式开启" : "浏览模式"}`
          : "打开 PDF 后可用",
        cls: "pdf-art-tool-view-status",
      });

      const pdfGroup = this.createGroup(contentEl, "当前 PDF", "分别控制标注层显示和页面输入模式");
      const renderToggle = this.createButton(pdfGroup, state?.getRendered() ? "隐藏标注层" : "显示标注层", state?.getRendered() ? "eye-off" : "eye", async () => {
        await this.withState((activeState) => activeState.toggleRendered());
      });
      renderToggle.addClass("pdf-art-tool-view-toggle");
      renderToggle.toggleClass("is-active", Boolean(state?.getRendered()));
      renderToggle.disabled = !state;

      const toggle = this.createButton(pdfGroup, state?.getEnabled() ? "关闭标注模式" : "开启标注模式", "power", async () => {
        await this.withState((activeState) => activeState.toggleEnabled());
      });
      toggle.addClass("pdf-art-tool-view-toggle");
      toggle.toggleClass("is-active", Boolean(state?.getEnabled()));
      toggle.disabled = !state;

      const toolGroup = this.createGroup(contentEl, "操作模式", "决定鼠标或触控笔接下来在 PDF 页面上做什么");
      const toolGrid = toolGroup.createDiv({ cls: "pdf-art-tool-grid" });
      for (const tool of TOOL_OPTIONS) {
        const button = this.createButton(toolGrid, tool.label, tool.icon, async () => {
          await this.withState((activeState) => activeState.setTool(tool.id));
        });
        button.toggleClass("is-active", state?.getTool() === tool.id);
        button.disabled = !state;
      }

      if (state?.getTool() === "guide") {
        const guideGroup = this.createGroup(contentEl, "构图类型", "选择下一次点击页面时要创建的辅助线");
        const guideGrid = guideGroup.createDiv({ cls: "pdf-art-tool-grid" });
        for (const guide of GUIDE_OPTIONS) {
          const button = this.createButton(guideGrid, guide.label, "layout-grid", async () => {
            await this.withState((activeState) => activeState.setGuideType(guide.id));
          });
          button.toggleClass("is-active", state?.getTool() === "guide" && state.getGuideType() === guide.id);
          button.disabled = !state;
        }
      }

      const appearanceGroup = this.createGroup(contentEl, "外观", "调整选中对象，或设置下一次创建对象的默认外观");
      appearanceGroup.createDiv({
        text: selectionCount > 0 ? `作用于已选中对象（${selectionCount}）` : "作用于下一次创建的对象",
        cls: "pdf-art-tool-help",
      });
      const colorRow = appearanceGroup.createDiv({ cls: "pdf-art-tool-field" });
      colorRow.createEl("label", { text: "颜色" });
      const color = colorRow.createEl("input", { type: "color", cls: "pdf-art-tool-color" });
      color.value = state?.getColor() ?? this.plugin.pluginSettings.defaultPenColor;
      color.disabled = !state || state.getTool() === "eraser";
      color.addEventListener("input", () => {
        void this.withState((activeState) => activeState.setColor(color.value), false);
      });
      color.addEventListener("change", () => {
        void this.withState((activeState) => activeState.setColor(color.value));
      });

      const widthRow = appearanceGroup.createDiv({ cls: "pdf-art-tool-field" });
      const isTextSizing = state?.getTool() === "text" || selectionIsTextOnly;
      widthRow.createEl("label", { text: state?.getTool() === "eraser" ? "范围" : isTextSizing ? "字号" : "粗细" });
      const width = widthRow.createEl("input", { type: "range", cls: "pdf-art-tool-range" });
      width.min = String(isTextSizing ? MIN_FONT_SIZE : MIN_STROKE_WIDTH);
      width.max = String(isTextSizing ? MAX_FONT_SIZE : MAX_STROKE_WIDTH);
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

      const actionGroup = this.createGroup(contentEl, "页面操作", "删除选中对象，或清除当前 PDF 页面的批注数据");
      const actionGrid = actionGroup.createDiv({ cls: "pdf-art-tool-grid" });
      const deleteSelected = this.createButton(actionGrid, "删除选中", "trash", async () => {
        await this.withState(async (activeState) => { await activeState.deleteSelection(); });
      });
      deleteSelected.disabled = !state || selectionCount === 0;
      const clear = this.createButton(actionGrid, "清除当前页", "trash-2", async () => {
        await this.withState((activeState) => activeState.clearCurrentPage());
      });
      clear.disabled = !state;
    } catch (e) {
      console.error("PDF Art: render error", e);
    }
  }

  private createGroup(container: HTMLElement, label: string, description: string) {
    const group = container.createDiv({ cls: "pdf-art-tool-group" });
    group.createDiv({ text: label, cls: "pdf-art-tool-section" });
    group.createDiv({ text: description, cls: "pdf-art-tool-group-description" });
    return group;
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
