import { Notice } from "obsidian";
import type PDFArtAnnotatorPlugin from "./main";
import { Tool } from "./leaf-state";

const TOOL_COMMANDS: Array<{ id: Tool; name: string }> = [
  { id: "select", name: "切换到选择" },
  { id: "pen", name: "切换到画笔" },
  { id: "highlighter", name: "切换到荧光笔" },
  { id: "eraser", name: "切换到橡皮" },
  { id: "text", name: "切换到文字" },
  { id: "guide", name: "切换到构图辅助线" },
];

export function registerPDFArtCommands(plugin: PDFArtAnnotatorPlugin) {
  plugin.addCommand({
    id: "open-pdf-art-tool-view",
    name: "打开 PDF Art 工具面板",
    callback: () => {
      void plugin.activateToolView();
    },
  });

  plugin.addCommand({
    id: "toggle-pdf-art-annotator",
    name: "切换当前 PDF 的 PDF Art 标注模式",
    checkCallback: (checking: boolean) => {
      if (!plugin.hasActivePDF()) return false;
      if (!checking) {
        void plugin.nativeOverlay.toggleActiveLeaf().then(() => plugin.refreshToolViews());
      }
      return true;
    },
  });

  plugin.addCommand({
    id: "toggle-pdf-art-rendering",
    name: "切换当前 PDF 的 PDF Art 标注显示",
    checkCallback: (checking: boolean) => {
      if (!plugin.hasActivePDF()) return false;
      if (!checking) {
        void plugin.nativeOverlay.toggleActiveLeafRendering().then(() => plugin.refreshToolViews());
      }
      return true;
    },
  });

  for (const tool of TOOL_COMMANDS) {
    plugin.addCommand({
      id: `pdf-art-tool-${tool.id}`,
      name: tool.name,
      checkCallback: (checking: boolean) => {
        if (!plugin.hasActivePDF()) return false;
        if (!checking) void setActiveTool(plugin, tool.id);
        return true;
      },
    });
  }

  plugin.addCommand({
    id: "pdf-art-clear-current-page",
    name: "清除当前 PDF 页的 PDF Art 标注",
    checkCallback: (checking: boolean) => {
      if (!plugin.hasActivePDF()) return false;
      if (!checking) {
        void plugin.nativeOverlay.getActiveState().then(async (state) => {
          if (!state) {
            new Notice("请先打开一个 PDF 文件");
            return;
          }
          state.clearCurrentPage();
          await plugin.refreshToolViews();
        });
      }
      return true;
    },
  });
}

async function setActiveTool(plugin: PDFArtAnnotatorPlugin, tool: Tool) {
  const state = await plugin.nativeOverlay.getActiveState();
  if (!state) {
    new Notice("请先打开一个 PDF 文件");
    return;
  }
  state.setTool(tool);
  await plugin.activateToolView(false);
  await plugin.refreshToolViews();
}
