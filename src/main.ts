import {
	App, Plugin, PluginSettingTab, Setting,
	TFile,
	Menu, TAbstractFile,
	WorkspaceLeaf,
} from "obsidian";
import { AnnotationStore } from "./storage";
import { PDFArtSettings, DEFAULT_SETTINGS } from "./types";
import { NativePDFArtOverlayManager } from "./native-overlay";
import { registerPDFArtCommands } from "./commands";
import { PDFArtToolView, VIEW_TYPE_PDF_ART_TOOLS } from "./tool-view";

export default class PDFArtAnnotatorPlugin extends Plugin {
	pluginSettings!: PDFArtSettings;
	store!: AnnotationStore;
	nativeOverlay!: NativePDFArtOverlayManager;

	async onload() {
		console.log("Loading PDF Art Annotator plugin");

		await this.loadPluginSettings();
		this.store = new AnnotationStore(this.app.vault);
		this.nativeOverlay = new NativePDFArtOverlayManager(this, this.store, () => this.pluginSettings, () => void this.refreshToolViews());
		this.registerView(VIEW_TYPE_PDF_ART_TOOLS, (leaf) => new PDFArtToolView(leaf, this));

		this.addRibbonIcon("pen-tool", "PDF Art Annotator", () => {
			void this.activateToolView();
		});


		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file && file.extension.toLowerCase() === "pdf") {
					void this.nativeOverlay.syncActiveLeaf();
					void this.refreshToolViews();
				}
			})
		);
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			void this.nativeOverlay.syncActiveLeaf();
			if (!this.isToolViewLeaf(this.app.workspace.activeLeaf)) {
				void this.refreshToolViews();
			}
		}));
		this.registerEvent(this.app.workspace.on("layout-change", () => {
			void this.nativeOverlay.syncActiveLeaf();
			void this.refreshToolViews();
		}));
		registerPDFArtCommands(this);

		// Settings tab
		this.addSettingTab(new PDFArtSettingTab(this.app, this));
	}

	async onunload() {
		console.log("Unloading PDF Art Annotator plugin");
		this.nativeOverlay?.destroy();
	}

	async loadPluginSettings() {
		this.pluginSettings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async savePluginSettings() {
		await this.saveData(this.pluginSettings);
	}

	async openPDFInViewer(file: TFile) {
		await this.app.workspace.openLinkText(file.path, "", false);
		await this.nativeOverlay.syncActiveLeaf();
		await this.activateToolView(false);
	}

	hasActivePDF() {
		const activeFile = this.app.workspace.getActiveFile();
		return activeFile?.extension.toLowerCase() === "pdf";
	}

	async activateToolView(reveal = true) {
		let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ART_TOOLS)[0] ?? null;
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE_PDF_ART_TOOLS, active: true });
		}
		if (reveal) this.app.workspace.revealLeaf(leaf);
		await this.refreshToolViews();
	}

	async refreshToolViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ART_TOOLS)) {
			if (leaf.view instanceof PDFArtToolView) {
				await leaf.view.render();
			}
		}
	}

	private isToolViewLeaf(leaf: WorkspaceLeaf | null) {
		return leaf?.view instanceof PDFArtToolView;
	}
}

class PDFArtSettingTab extends PluginSettingTab {
	plugin: PDFArtAnnotatorPlugin;

	constructor(app: App, plugin: PDFArtAnnotatorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "PDF Art Annotator 设置" });

		new Setting(containerEl)
			.setName("默认画笔颜色")
			.setDesc("新建批注的默认颜色")
			.addColorPicker((cb) =>
				cb.setValue(this.plugin.pluginSettings.defaultPenColor).onChange(async (v) => {
					this.plugin.pluginSettings.defaultPenColor = v;
					await this.plugin.savePluginSettings();
				})
			);

		new Setting(containerEl)
			.setName("默认画笔粗细")
			.addSlider((s) =>
				s.setLimits(1, 20, 1).setValue(this.plugin.pluginSettings.defaultPenWidth).setDynamicTooltip().onChange(async (v) => {
					this.plugin.pluginSettings.defaultPenWidth = v;
					await this.plugin.savePluginSettings();
				})
			);

		new Setting(containerEl).setName("默认荧光笔颜色").addColorPicker((cb) =>
			cb.setValue(this.plugin.pluginSettings.defaultHighlighterColor).onChange(async (v) => {
				this.plugin.pluginSettings.defaultHighlighterColor = v;
				await this.plugin.savePluginSettings();
			})
		);

		new Setting(containerEl)
			.setName("默认荧光笔粗细")
			.addSlider((s) =>
				s.setLimits(5, 30, 1).setValue(this.plugin.pluginSettings.defaultHighlighterWidth).setDynamicTooltip().onChange(async (v) => {
					this.plugin.pluginSettings.defaultHighlighterWidth = v;
					await this.plugin.savePluginSettings();
				})
			);

		new Setting(containerEl)
			.setName("橡皮范围")
			.addSlider((s) =>
				s.setLimits(4, 30, 1).setValue(this.plugin.pluginSettings.eraserWidth).setDynamicTooltip().onChange(async (v) => {
					this.plugin.pluginSettings.eraserWidth = v;
					await this.plugin.savePluginSettings();
				})
			);

		new Setting(containerEl).setName("默认文字颜色").addColorPicker((cb) =>
			cb.setValue(this.plugin.pluginSettings.defaultTextColor).onChange(async (v) => {
				this.plugin.pluginSettings.defaultTextColor = v;
				await this.plugin.savePluginSettings();
			})
		);

		new Setting(containerEl)
			.setName("默认文字字号")
			.addSlider((s) =>
				s.setLimits(8, 72, 1).setValue(this.plugin.pluginSettings.defaultFontSize).setDynamicTooltip().onChange(async (v) => {
					this.plugin.pluginSettings.defaultFontSize = v;
					await this.plugin.savePluginSettings();
				})
			);

		new Setting(containerEl)
			.setName("自动连接 PDF Art 标注层")
			.setDesc("打开 PDF 时，自动在 Obsidian 原生 PDF 页面上准备 PDF Art 标注层")
			.addToggle((t) =>
				t.setValue(this.plugin.pluginSettings.autoOpenPDF).onChange(async (v) => {
					this.plugin.pluginSettings.autoOpenPDF = v;
					await this.plugin.savePluginSettings();
				})
			);

		containerEl.createEl("p", {
			text: "批注数据以普通 JSON 文件形式统一保存在 vault 根目录的 PDF Art Annotations 文件夹中，文件名由原 PDF 文件名和源路径短哈希组成，便于同步、备份和辨认。",
			cls: "setting-item-description",
		});
	}
}
