import { App, Modal, Plugin, MarkdownView, Notice, Platform, PluginSettingTab, Setting, Editor, TFile, requestUrl } from 'obsidian';
import * as OCL from 'openchemlib';

interface ChemEditUniversalSettings {
    width: number;
    height: number;
    smartPaste: boolean;
}

const DEFAULT_SETTINGS: ChemEditUniversalSettings = {
    width: 300,
    height: 300,
    smartPaste: false
}

export default class ChemEditUniversalPlugin extends Plugin {
    settings: ChemEditUniversalSettings;
    
    async onload() {
        console.log("ChemEdit Universal loaded - OpenChemLib Engine");
        await this.loadSettings();

        this.addSettingTab(new ChemEditUniversalSettingTab(this.app, this));

        // 1. Ribbon Icon 
        this.addRibbonIcon('hexagon', 'Draw New Molecule', () => {
            const editor = this.app.workspace.activeEditor?.editor;
            if (!editor) {
                new Notice("Please place your cursor in an active Markdown file first.");
                return;
            }
            new OCLEditorModal(this.app, "", "smiles", (newData) => {
                this.insertAtCursor(editor, newData, "smiles");
            }).open();
        });

        // 2. Command: Draw Molecule
        this.addCommand({
            id: 'insert-smiles-molecule',
            name: 'Draw new molecule (SMILES)',
            editorCallback: (editor: Editor) => {
                new OCLEditorModal(this.app, "", "smiles", (newData) => {
                    this.insertAtCursor(editor, newData, "smiles");
                }).open();
            }
        });

        // 3. Command: Fetch from PubChem
        this.addCommand({
            id: 'fetch-molecule-pubchem',
            name: 'Fetch Structure by Name / CAS (Requires Internet)',
            editorCallback: (editor: Editor) => {
                new FetchMoleculeModal(this.app, async (query) => {
                    try {
                        new Notice(`Fetching ${query} from PubChem...`);
                        
                        const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(query)}/property/CanonicalSMILES/JSON`;
                        const response = await requestUrl({ url: url, method: 'GET' });
                        
                        if (response.status === 200 && response.json) {
                            const smiles = response.json.PropertyTable.Properties[0].CanonicalSMILES;
                            this.insertAtCursor(editor, smiles, "smiles");
                            new Notice("Structure successfully inserted!");
                        } else {
                            new Notice("Molecule not found in PubChem.");
                        }
                    } catch (err) {
                        new Notice(`Failed to fetch: Could not find "${query}" or no internet connection.`);
                    }
                }).open();
            }
        });

        // 4. Command: Calculate Properties 
        this.addCommand({
            id: 'calculate-properties',
            name: 'Calculate Properties (SMILES/IDCode)',
            editorCallback: (editor: Editor) => {
                const sel = editor.getSelection().trim();

                const processAndInsert = (input: string) => {
                    const cleanInput = input.trim();
                    if (!cleanInput) return;

                    try {
                        let mol;
                        let errs = [];
                        try { 
                            mol = OCL.Molecule.fromSmiles(cleanInput); 
                        } catch (e1: any) { 
                            errs.push(`SMILES: ${e1.message}`);
                            try { 
                                mol = OCL.Molecule.fromIDCode(cleanInput); 
                            } catch (e2: any) { 
                                errs.push(`IDCode: ${e2.message}`);
                                throw new Error(errs.join(" | "));
                            }
                        }

                        const formula = mol.getMolecularFormula();
                        const props = new OCL.MoleculeProperties(mol);
                        
                        const formStr = (formula as any).formula || 'Unknown';
                        
                        const mwVal = (formula as any).relativeWeight || (formula as any).molecularWeight || 0;
                        const mw = Number(mwVal).toFixed(4); 
                        const emVal = (formula as any).absoluteWeight || 0;
                        const exactMass = Number(emVal).toFixed(4);

                        const logp = typeof (props as any).logP === 'number' ? (props as any).logP.toFixed(2) : "0.00";
                        const logs = typeof (props as any).logS === 'number' ? (props as any).logS.toFixed(2) : "0.00";
                        const psa = typeof (props as any).polarSurfaceArea === 'number' ? (props as any).polarSurfaceArea.toFixed(1) : "0.0";
                        const hbd = (props as any).donorCount ?? 0;
                        const hba = (props as any).acceptorCount ?? 0;
                        const rotBonds = (props as any).rotatableBondCount ?? 0;
                        const stereo = (props as any).stereoCenterCount ?? 0;

                        const textToInsert = `\n> 🧪 **Formula:** ${formStr} | **MW:** ${mw} | **Exact Mass:** ${exactMass} | **LogP:** ${logp} | **LogS:** ${logs} | **PSA:** ${psa} Å² | **HBD:** ${hbd} | **HBA:** ${hba} | **Rot. Bonds:** ${rotBonds} | **Stereocenters:** ${stereo}\n`;

                        const cursor = editor.getCursor("to");
                        editor.replaceRange(textToInsert, cursor);
                        new Notice("Properties calculated!");
                    } catch (e: any) {
                        new Notice("Parse Error - " + e.message, 5000);
                        new PropertyPromptModal(this.app, cleanInput, processAndInsert).open();
                    }
                };

                if (!sel) {
                    new PropertyPromptModal(this.app, "", processAndInsert).open();
                } else {
                    try {
                        let mol;
                        try { mol = OCL.Molecule.fromSmiles(sel); }
                        catch { mol = OCL.Molecule.fromIDCode(sel); }
                        processAndInsert(sel);
                    } catch {
                        new Notice("Selection invalid. Please edit manually.");
                        new PropertyPromptModal(this.app, sel, processAndInsert).open();
                    }
                }
            }
        });

        // 5. Smart Paste
        this.registerEvent(
            this.app.workspace.on('editor-paste', (evt: ClipboardEvent, editor: Editor) => {
                if (!this.settings.smartPaste) return;
                
                const text = evt.clipboardData?.getData('text/plain');
                if (!text) return;

                const cleanText = text.trim();
                if (cleanText.includes('V2000') || cleanText.includes('V3000')) {
                    evt.preventDefault();
                    this.insertAtCursor(editor, cleanText, "mol");
                    return;
                }
                
                const smilesRegex = /^([BCNOPSFIcbcnops@+\-\[\]\(\)\\\/=#%0-9]{4,})$/;
                if (smilesRegex.test(cleanText) && /[CNOcno]/.test(cleanText)) {
                    evt.preventDefault();
                    this.insertAtCursor(editor, cleanText, "smiles");
                }
            })
        );

        // 6. Codeblock Processors
        const formats = ["smiles", "mol", "sdf", "idcode"];
        formats.forEach(fmt => {
            this.registerMarkdownCodeBlockProcessor(fmt, (source, el, ctx) => {
                this.renderChemicalToElement(source, fmt, el, ctx);
            });
        });

        this.registerMarkdownCodeBlockProcessor("chemprops", (source, el, ctx) => {
            this.renderChemicalProperties(source, el);
        });
    }

    insertAtCursor(editor: Editor, data: string, format: string) {
        const cursor = editor.getCursor();
        editor.replaceRange(`\`\`\`${format}\n${data}\n\`\`\`\n`, cursor);
        editor.setCursor({ line: cursor.line + 3, ch: 0 });
    }

    async renderChemicalToElement(source: string, format: string, el: HTMLElement, ctx: any) {
        const cleanSource = source.trim();
        const wrapper = document.createElement("div");
        wrapper.style.cursor = "pointer";
        wrapper.style.textAlign = "center";
        wrapper.style.padding = "10px";
        wrapper.style.margin = "10px 0";
        wrapper.style.backgroundColor = "var(--background-primary)";
        wrapper.style.border = "1px solid var(--background-modifier-border)";
        wrapper.style.borderRadius = "8px";
        el.appendChild(wrapper);

        let actualData = cleanSource;
        let isFile = false;
        let targetFile: TFile | null = null;

        const bracketMatch = cleanSource.match(/\[\[(.*?)\]\]/);
        let filenameToSearch = "";
        if (bracketMatch && bracketMatch[1]) {
            filenameToSearch = bracketMatch[1].trim();
        } else if (cleanSource.endsWith('.mol') || cleanSource.endsWith('.sdf')) {
            filenameToSearch = cleanSource.trim();
        }

        if (filenameToSearch) {
            targetFile = this.app.metadataCache.getFirstLinkpathDest(filenameToSearch, ctx.sourcePath) as TFile;
            if (targetFile) {
                actualData = await this.app.vault.read(targetFile);
                isFile = true;
            } else {
                wrapper.innerHTML = `<span style="color: var(--text-error);">File not found: ${filenameToSearch}</span>`;
                return;
            }
        }

        if (!actualData) {
            wrapper.innerHTML = `<span class="color-text-muted">Empty molecule. Double-tap to draw.</span>`;
        } else {
            try {
                let molecule;
                if (format === "smiles") molecule = OCL.Molecule.fromSmiles(actualData);
                else if (format === "idcode") molecule = OCL.Molecule.fromIDCode(actualData);
                else molecule = OCL.Molecule.fromMolfile(actualData);

                const svgString = molecule.toSVG(this.settings.width, this.settings.height);
                wrapper.innerHTML = svgString;

                if (document.body.hasClass("theme-dark")) {
                    wrapper.style.filter = "invert(1) hue-rotate(180deg)";
                }
            } catch (err: any) {
                wrapper.innerHTML = `<span style="color: var(--text-error);">Rendering Error: ${err.message}</span>`;
            }
        }

        wrapper.addEventListener("dblclick", async (e) => {
            e.stopPropagation();
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view) return;
            
            if (isFile && targetFile) {
                actualData = await this.app.vault.read(targetFile);
            }
            
            const info = ctx.getSectionInfo(el);
            new OCLEditorModal(this.app, actualData, format, async (newData) => {
                if (isFile && targetFile) {
                    await this.app.vault.modify(targetFile, newData);
                    new Notice(`Updated ${targetFile.name}`);
                } else if (info) {
                    const editor = view.editor;
                    editor.replaceRange(`\`\`\`${format}\n${newData}\n\`\`\``, 
                        { line: info.lineStart, ch: 0 }, 
                        { line: info.lineEnd, ch: editor.getLine(info.lineEnd).length });
                }
            }).open();
        });
    }

    renderChemicalProperties(source: string, el: HTMLElement) {
        const cleanSource = source.trim();
        const wrapper = el.createDiv();
        wrapper.style.padding = "15px";
        wrapper.style.backgroundColor = "var(--background-secondary)";
        wrapper.style.borderRadius = "8px";
        wrapper.style.border = "1px solid var(--background-modifier-border)";
        wrapper.style.display = "flex";
        wrapper.style.alignItems = "center";
        wrapper.style.gap = "20px";
        wrapper.style.flexWrap = "wrap";

        try {
            let mol;
            try {
                mol = OCL.Molecule.fromSmiles(cleanSource);
            } catch {
                mol = OCL.Molecule.fromIDCode(cleanSource);
            }
            
            const svgEl = wrapper.createDiv();
            svgEl.style.flexShrink = "0";
            svgEl.innerHTML = mol.toSVG(120, 120);
            if (document.body.hasClass("theme-dark")) svgEl.style.filter = "invert(1) hue-rotate(180deg)";

            const formula = mol.getMolecularFormula();
            const props = new OCL.MoleculeProperties(mol);

            const formStr = (formula as any).formula || 'Unknown';
            
            const mwVal = (formula as any).relativeWeight || (formula as any).molecularWeight || 0;
            const mw = Number(mwVal).toFixed(4); 
            const emVal = (formula as any).absoluteWeight || 0;
            const exactMass = Number(emVal).toFixed(4);

            const logp = typeof (props as any).logP === 'number' ? (props as any).logP.toFixed(2) : "0.00";
            const logs = typeof (props as any).logS === 'number' ? (props as any).logS.toFixed(2) : "0.00";
            const psa = typeof (props as any).polarSurfaceArea === 'number' ? (props as any).polarSurfaceArea.toFixed(1) : "0.0";
            const hbd = (props as any).donorCount ?? 0;
            const hba = (props as any).acceptorCount ?? 0;
            const rotBonds = (props as any).rotatableBondCount ?? 0;
            const stereo = (props as any).stereoCenterCount ?? 0;

            const statsEl = wrapper.createDiv();
            statsEl.style.fontSize = "0.9em";
            statsEl.innerHTML = `
                <div style="font-size: 1.1em; font-weight: bold; margin-bottom: 5px; color: var(--text-normal);">${formStr}</div>
                <table style="width: 100%; text-align: left; border: none; font-size: 0.9em;">
                    <tr><td style="color: var(--text-muted);">Molecular Weight:</td><td><b>${mw}</b> g/mol</td></tr>
                    <tr><td style="color: var(--text-muted);">Exact Mass:</td><td><b>${exactMass}</b> Da</td></tr>
                    <tr><td style="color: var(--text-muted);">LogP (Lipophilicity):</td><td><b>${logp}</b></td></tr>
                    <tr><td style="color: var(--text-muted);">LogS (Solubility):</td><td><b>${logs}</b></td></tr>
                    <tr><td style="color: var(--text-muted);">Polar Surface Area:</td><td><b>${psa}</b> Å²</td></tr>
                    <tr><td style="color: var(--text-muted);">H-Donors / Acceptors:</td><td><b>${hbd} / ${hba}</b></td></tr>
                    <tr><td style="color: var(--text-muted);">Rot. Bonds / Stereocenters:</td><td><b>${rotBonds} / ${stereo}</b></td></tr>
                </table>
            `;
        } catch (e: any) {
            wrapper.innerHTML = `<span style="color: var(--text-error);">Error: Could not parse string for properties. (${e.message})</span>`;
        }
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }
}

// ------------------------------------------------------------------
// FETCH MOLECULE MODAL (PUBCHEM)
// ------------------------------------------------------------------
class FetchMoleculeModal extends Modal {
    onSubmit: (query: string) => void;

    constructor(app: App, onSubmit: (query: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Fetch from PubChem" });
        contentEl.createEl("p", { text: "Enter a Chemical Name or CAS Number (e.g. Aspirin, 50-78-2):", cls: "color-text-muted", attr: { style: "font-size: 0.9em;" } });

        const input = contentEl.createEl("input", { type: "text", placeholder: "Caffeine" });
        input.style.width = "100%";
        input.style.marginBottom = "15px";

        const btn = contentEl.createEl("button", { text: "Fetch Structure", cls: "mod-cta" });
        btn.onclick = () => {
            if (input.value) {
                this.onSubmit(input.value.trim());
                this.close();
            }
        };
        input.addEventListener("keypress", (e) => {
            if (e.key === "Enter" && input.value) {
                this.onSubmit(input.value.trim());
                this.close();
            }
        });

        setTimeout(() => input.focus(), 50);
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ------------------------------------------------------------------
// PROPERTY PROMPT MODAL
// ------------------------------------------------------------------
class PropertyPromptModal extends Modal {
    initialValue: string;
    onSubmit: (input: string) => void;

    constructor(app: App, initialValue: string, onSubmit: (input: string) => void) {
        super(app);
        this.initialValue = initialValue;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Calculate Properties" });
        contentEl.createEl("p", { text: "Enter a valid SMILES or IDCode:", cls: "color-text-muted", attr: { style: "font-size: 0.9em;" } });

        const input = contentEl.createEl("input", { type: "text", value: this.initialValue });
        input.style.width = "100%";
        input.style.marginBottom = "15px";

        const btn = contentEl.createEl("button", { text: "Calculate", cls: "mod-cta" });
        btn.onclick = () => {
            if (input.value) {
                this.onSubmit(input.value.trim());
                this.close();
            }
        };
        input.addEventListener("keypress", (e) => {
            if (e.key === "Enter" && input.value) {
                this.onSubmit(input.value.trim());
                this.close();
            }
        });

        setTimeout(() => input.focus(), 50);
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ------------------------------------------------------------------
// SETTINGS TAB
// ------------------------------------------------------------------
class ChemEditUniversalSettingTab extends PluginSettingTab {
    plugin: ChemEditUniversalPlugin;

    constructor(app: App, plugin: ChemEditUniversalPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();
        containerEl.createEl('h2', {text: 'ChemEdit Universal Settings'});

        const statusEl = containerEl.createEl('div', { cls: 'setting-item-description' });
        statusEl.innerHTML = `<span style="color:var(--text-success); font-size:1.1em">✅ <b>OpenChemLib Engine Active</b></span><br>100% offline. Calculates MW, formulas, LogP, and more natively!`;
        containerEl.createEl('br');

        new Setting(containerEl)
            .setName('Image Width')
            .setDesc('Width of the rendered structure blocks (pixels)')
            .addText(text => text.setPlaceholder('300').setValue(this.plugin.settings.width.toString())
                .onChange(async (v) => { this.plugin.settings.width = parseInt(v) || 300; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Image Height')
            .setDesc('Height of the rendered structure blocks (pixels)')
            .addText(text => text.setPlaceholder('300').setValue(this.plugin.settings.height.toString())
                .onChange(async (v) => { this.plugin.settings.height = parseInt(v) || 300; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Smart Paste')
            .setDesc('Automatically format pasted SMILES or MOL strings into codeblocks.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.smartPaste)
                .onChange(async (value) => {
                    this.plugin.settings.smartPaste = value;
                    await this.plugin.saveSettings();
                }));
    }
}

// ------------------------------------------------------------------
// EDITOR MODAL
// ------------------------------------------------------------------
class OCLEditorModal extends Modal {
    initialData: string;
    format: string;
    onSave: (data: string) => void;
    editor: any = null;

    constructor(app: App, initialData: string, format: string, onSave: (data: string) => void) {
        super(app);
        this.initialData = initialData;
        this.format = format || "smiles";
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();
        
        if (Platform.isMobile) {
            modalEl.style.width = "100vw";
            modalEl.style.height = "100vh";
            modalEl.style.padding = "0";
            modalEl.style.margin = "0";
            contentEl.style.padding = "0";
            document.body.style.overflow = "hidden"; 
        } else {
            modalEl.style.width = "85vw";
            modalEl.style.height = "85vh";
        }
        
        contentEl.style.height = "100%";
        contentEl.style.display = "flex";
        contentEl.style.flexDirection = "column";

        const editorContainer = contentEl.createDiv();
        editorContainer.style.flex = "1 1 auto";
        editorContainer.style.width = "100%";
        editorContainer.style.height = "100%";
        editorContainer.style.minHeight = "400px"; 
        editorContainer.style.touchAction = "none"; 

        const btnContainer = contentEl.createDiv();
        btnContainer.style.display = "flex";
        btnContainer.style.justifyContent = "space-between";
        btnContainer.style.padding = "10px";
        btnContainer.style.backgroundColor = "var(--background-secondary)";

        const saveBtn = btnContainer.createEl("button", { text: `Save (${this.format.toUpperCase()})`, cls: "mod-cta" });
        const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });

        setTimeout(() => {
            try {
                if (!OCL.CanvasEditor) {
                    editorContainer.innerHTML = `<div style="padding:20px; color:var(--text-error);">Error: CanvasEditor is not available in the current OpenChemLib build.</div>`;
                    return;
                }

                this.editor = new OCL.CanvasEditor(editorContainer, {});
                
                if (this.initialData) {
                    let mol;
                    try {
                        if (this.format === "smiles") mol = OCL.Molecule.fromSmiles(this.initialData);
                        else if (this.format === "idcode") mol = OCL.Molecule.fromIDCode(this.initialData);
                        else mol = OCL.Molecule.fromMolfile(this.initialData);
                        
                        if (mol) this.editor.setMolecule(mol);
                    } catch (e: any) {
                        new Notice("Could not load structure into editor: " + e.message);
                    }
                }
            } catch (e: any) {
                console.error("Editor Init Error:", e);
                new Notice("Failed to load editor: " + e.message);
            }
        }, 100);

        saveBtn.onclick = () => {
            if (this.editor) {
                try {
                    const mol = this.editor.getMolecule();
                    let outputData = "";
                    
                    if (this.format === "smiles") outputData = mol.toSmiles();
                    else if (this.format === "idcode") outputData = mol.getIDCode();
                    else outputData = mol.toMolfile();
                    
                    this.onSave(outputData);
                    this.close();
                } catch (e: any) {
                    new Notice("Failed to generate structure: " + e.message);
                }
            }
        };

        cancelBtn.onclick = () => this.close();
    }

    onClose() {
        if (Platform.isMobile) document.body.style.overflow = ""; 
        this.contentEl.empty();
        this.editor = null; 
    }
}