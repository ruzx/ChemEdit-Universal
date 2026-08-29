import { App, Modal, Plugin, MarkdownView, Notice, Platform, PluginSettingTab, Setting, Editor, TFile, requestUrl, Menu } from 'obsidian';
import * as OCL from 'openchemlib';
import SmiDrawer from 'smiles-drawer';

// Import exactly from the shared files
import { SharedElnRenderer, ElnMetaEditorModal, ElnGalleryRenderer, createNewElnExperiment, CreateExperimentModal, getCompoundLibrary, CompoundSuggestModal, AddToLibraryModal, addCompoundToLibrary } from './SharedEln';
import { takeStandardPhoto, saveMediaFile, TlcModal } from './SharedMedia';

interface ChemEditUniversalSettings {
    width: number;
    height: number;
    smartPaste: boolean;
    mediaSavePath: string;
    renderingEngine: 'smilesdrawer' | 'openchemlib';
    lightTheme: string;
    darkTheme: string;
    useSvgSmiles: boolean;
    showMediaRibbonIcons: boolean;
    showElnRibbonIcon: boolean;
    defaultElnDirectory: string;
    defaultExpPrefix: string;
    analyticalSections: string;
    libraryFilePath: string;
    contextUrl1Name: string; contextUrl1: string;
    contextUrl2Name: string; contextUrl2: string;
    contextUrl3Name: string; contextUrl3: string;
    contextUrl4Name: string; contextUrl4: string;
}

const DEFAULT_SETTINGS: ChemEditUniversalSettings = {
    width: 300, height: 300, smartPaste: false, mediaSavePath: "Assets/",
    renderingEngine: 'smilesdrawer', lightTheme: 'light', darkTheme: 'dark',
    useSvgSmiles: false, showMediaRibbonIcons: false, showElnRibbonIcon: true,
    defaultElnDirectory: "", defaultExpPrefix: "EXP", analyticalSections: "TLC, LCMS, NMR",
    libraryFilePath: "",
    contextUrl1Name: "Search PubChem", contextUrl1: "https://pubchem.ncbi.nlm.nih.gov/#query={{smiles}}",
    contextUrl2Name: "Search MolPort", contextUrl2: "https://www.molport.com/shop/search-results?smiles={{smiles}}",
    contextUrl3Name: "Predict NMR (NMRium)", contextUrl3: "https://app.nmrium.com/predict?smiles={{smiles}}",
    contextUrl4Name: "Search ChemSpider", contextUrl4: "https://www.chemspider.com/Search.aspx?q={{smiles}}"
}

export default class ChemEditUniversalPlugin extends Plugin {
    settings: ChemEditUniversalSettings;
    
    cameraRibbonEl: HTMLElement | null = null;
    tlcRibbonEl: HTMLElement | null = null;
    elnRibbonEl: HTMLElement | null = null;

    fixSvgDarkMode(svg: string): string {
        return svg
            .replace(/="#000000"/gi, '="currentColor"')
            .replace(/="#000"/gi, '="currentColor"')
            .replace(/rgb\(0,\s*0,\s*0\)/gi, 'currentColor')
            .replace(/stroke="none"/gi, 'stroke="transparent"');
    }

    renderWithSmilesDrawer(smiles: string, container: HTMLElement, w: number, h: number) {
        // @ts-ignore
        const Smi: any = SmiDrawer; 
        const theme = document.body.hasClass("theme-dark") ? this.settings.darkTheme : this.settings.lightTheme;
        const drawerOptions = { width: w * 2, height: h * 2 };

        requestAnimationFrame(() => {
            try {
                container.innerHTML = ''; 
                if (smiles.includes('>')) {
                    const rxnContainer = document.createElement("span");
                    rxnContainer.style.display = "inline-flex"; rxnContainer.style.alignItems = "center";
                    container.appendChild(rxnContainer);
                    
                    Smi.parseReaction(smiles, (tree: any) => {
                        if (this.settings.useSvgSmiles) {
                            new Smi.ReactionDrawer({width: w, height: h}, {width: w, height: h}).draw(tree, rxnContainer, theme);
                        } else {
                            new Smi.ReactionDrawer(drawerOptions, drawerOptions).draw(tree, rxnContainer, theme);
                            rxnContainer.querySelectorAll('canvas').forEach(c => {
                                c.style.width = `${c.width / 2}px`; c.style.height = `${c.height / 2}px`;
                            });
                        }
                    }, (err: any) => { container.innerHTML = `<span class="color-red">Reaction Error</span>`; });
                } else {
                    if (this.settings.useSvgSmiles) {
                        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                        svg.style.width = `${w}px`; svg.style.height = `${h}px`;
                        container.appendChild(svg);
                        Smi.parse(smiles, (tree: any) => new Smi.SvgDrawer({width: w, height: h}).draw(tree, svg, theme));
                    } else {
                        const canvas = document.createElement("canvas");
                        canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
                        container.appendChild(canvas);
                        Smi.parse(smiles, (tree: any) => new Smi.Drawer(drawerOptions).draw(tree, canvas, theme));
                    }
                }
            } catch (err: any) { container.innerHTML = `<span style="color:var(--text-error); font-size:12px;">Draw Error</span>`; }
        });
    }

    // --- CONTEXT MENU HELPER ---
    showChemicalContextMenu(e: MouseEvent, smiles: string) {
        e.preventDefault();
        const menu = new Menu();
        
        menu.addItem((item) => {
            item.setTitle("Add to Compound Library").setIcon("bookmark").onClick(() => {
                new AddToLibraryModal(this.app, smiles, (name: string, sm: string) => { 
                    addCompoundToLibrary(this, name, sm); 
                }).open();
            });
        });

        menu.addSeparator();

        menu.addItem((item) => {
            item.setTitle("Copy SMILES").setIcon("copy").onClick(async () => {
                await navigator.clipboard.writeText(smiles); 
                new Notice("SMILES copied to clipboard!");
            });
        });

        menu.addItem((item) => {
            item.setTitle("Copy MOL Block (Offline)").setIcon("file-text").onClick(async () => {
                try {
                    const mol = OCL.Molecule.fromSmiles(smiles);
                    const molBlock = mol.toMolfile();
                    if (molBlock) {
                        await navigator.clipboard.writeText(molBlock);
                        new Notice("MOL Block copied to clipboard!");
                    }
                } catch(err) { new Notice("Error generating MOL Block."); }
            });
        });

        menu.addItem((item) => {
            item.setTitle("Copy IUPAC Name (Web)").setIcon("whole-word").onClick(async () => {
                try {
                    new Notice("Fetching IUPAC name...");
                    const res = await requestUrl(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/${encodeURIComponent(smiles)}/property/IUPACName/JSON`);
                    if (res.status === 200) { 
                        const name = res.json?.PropertyTable?.Properties?.[0]?.IUPACName;
                        if (name) { await navigator.clipboard.writeText(name); new Notice("IUPAC Name copied!"); } 
                        else { new Notice("IUPAC Name not found."); }
                    } else { new Notice("Failed to fetch IUPAC Name."); }
                } catch(err) { new Notice("Error fetching IUPAC Name."); }
            });
        });

        menu.addItem((item) => {
            item.setTitle("Copy MW & Formula (Web)").setIcon("info").onClick(async () => {
                try {
                    const res = await requestUrl(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/${encodeURIComponent(smiles)}/property/MolecularWeight,MolecularFormula/JSON`);
                    if (res.status === 200) { 
                        const p = res.json?.PropertyTable?.Properties?.[0];
                        if (p && p.MolecularFormula && p.MolecularWeight) {
                            await navigator.clipboard.writeText(`Formula: ${p.MolecularFormula}, MW: ${p.MolecularWeight}`); 
                            new Notice("Properties copied!"); 
                        } else { new Notice("Properties not found."); }
                    }
                } catch(err) { new Notice("Error fetching properties."); }
            });
        });

        menu.addItem((item) => {
            item.setTitle("Copy CAS Number (Web)").setIcon("hash").onClick(async () => {
                try {
                    new Notice("Fetching CAS Number...");
                    const res = await requestUrl(`https://cactus.nci.nih.gov/chemical/structure/${encodeURIComponent(smiles)}/cas`);
                    if (res.status === 200) { 
                        const cas = res.text.split('\n')[0].trim();
                        if (cas && !cas.includes("<h1>")) { await navigator.clipboard.writeText(cas); new Notice(`CAS Number copied: ${cas}`); }
                        else { new Notice("CAS Number not found for this structure."); }
                    } else { new Notice("Failed to fetch CAS Number."); }
                } catch(err) { new Notice("Error fetching CAS Number."); }
            });
        });

        menu.addSeparator();

        // Dynamically add custom URL links
        const addCustomLink = (name: string, urlTemplate: string, icon: string) => {
            if (!name || !urlTemplate) return;
            menu.addItem((item) => {
                item.setTitle(`${name} (Web)`).setIcon(icon).onClick(() => {
                    const url = urlTemplate.replace(/\{\{smiles\}\}/gi, encodeURIComponent(smiles));
                    window.open(url, '_blank');
                });
            });
        };

        addCustomLink(this.settings.contextUrl1Name, this.settings.contextUrl1, "search");
        addCustomLink(this.settings.contextUrl2Name, this.settings.contextUrl2, "shopping-cart");
        addCustomLink(this.settings.contextUrl3Name, this.settings.contextUrl3, "activity");
        addCustomLink(this.settings.contextUrl4Name, this.settings.contextUrl4, "link");

        menu.showAtMouseEvent(e);
    }

    // --- ALIAS FOR ELN BRIDGE ---
    public openKetcherModal(initialData: string, format: string, onSave: (data: string) => void) {
        new OCLEditorModal(this, initialData, format, onSave).open();
    }

    public api = {
        openEditor: (initialData: string, format: string, onSave: (data: string) => void) => {
            this.openKetcherModal(initialData, format, onSave);
        },
        renderStructure: async (data: string, width: number, height: number): Promise<HTMLElement | null> => {
            try {
                const wrapper = document.createElement("div");
                wrapper.className = "chem-svg-wrapper";

                if (this.settings.renderingEngine === 'smilesdrawer') {
                    this.renderWithSmilesDrawer(data, wrapper, width, height);
                } else {
                    let mol;
                    try { mol = OCL.Molecule.fromSmiles(data); } catch {
                        try { mol = OCL.Molecule.fromIDCode(data); } catch {
                            mol = OCL.Molecule.fromMolfile(data);
                        }
                    }
                    wrapper.style.color = "var(--text-normal)";
                    wrapper.innerHTML = this.fixSvgDarkMode(mol.toSVG(width, height));
                }
                return wrapper;
            } catch {
                return null;
            }
        }
    };

    async onload() {
        console.log("ChemEdit Universal loaded - Modular Architecture");
        await this.loadSettings();
        this.addSettingTab(new ChemEditUniversalSettingTab(this.app, this));

        this.addRibbonIcon('hexagon', 'Draw New Molecule', () => {
            const editor = this.app.workspace.activeEditor?.editor;
            if (!editor) { new Notice("Please place your cursor in an active Markdown file first."); return; }
            this.openKetcherModal("", "smiles", (newData) => {
                this.insertAtCursor(editor, newData, "smiles");
            });
        });

        this.refreshRibbonIcons();

        this.addCommand({
            id: 'insert-smiles-molecule',
            name: 'Draw new molecule (SMILES)',
            editorCallback: (editor: Editor) => {
                this.openKetcherModal("", "smiles", (newData) => {
                    this.insertAtCursor(editor, newData, "smiles");
                });
            }
        });

        this.addCommand({
            id: 'insert-from-library',
            name: 'Insert SMILES from Library',
            editorCallback: async (editor: Editor) => {
                const lib = await getCompoundLibrary(this);
                new CompoundSuggestModal(this.app, lib, (selected) => {
                    editor.replaceSelection(selected.smiles);
                }).open();
            }
        });

        this.addCommand({
            id: 'calculate-properties',
            name: 'Calculate Properties (SMILES/IDCode)',
            editorCallback: (editor: Editor) => {
                const sel = editor.getSelection().trim();
                const processAndInsert = (input: string) => {
                    const cleanInput = input.trim();
                    if (!cleanInput) return;
                    try {
                        let mol; let errs = [];
                        try { mol = OCL.Molecule.fromSmiles(cleanInput); } 
                        catch (e1: any) { errs.push(`SMILES: ${e1.message}`); try { mol = OCL.Molecule.fromIDCode(cleanInput); } catch (e2: any) { throw new Error(errs.join(" | ")); } }
                        const formula = mol.getMolecularFormula();
                        const props = new OCL.MoleculeProperties(mol);
                        const formStr = (formula as any).formula || 'Unknown';
                        const mw = Number((formula as any).relativeWeight || 0).toFixed(4); 
                        const exactMass = Number((formula as any).absoluteWeight || 0).toFixed(4);
                        const logp = typeof (props as any).logP === 'number' ? (props as any).logP.toFixed(2) : "0.00";
                        const logs = typeof (props as any).logS === 'number' ? (props as any).logS.toFixed(2) : "0.00";
                        const psa = typeof (props as any).polarSurfaceArea === 'number' ? (props as any).polarSurfaceArea.toFixed(1) : "0.0";
                        const textToInsert = `\n> 🧪 **Formula:** ${formStr} | **MW:** ${mw} | **Exact Mass:** ${exactMass} | **LogP:** ${logp} | **LogS:** ${logs} | **PSA:** ${psa} Å² \n`;
                        editor.replaceSelection(textToInsert);
                        new Notice("Properties calculated!");
                    } catch (e: any) { new Notice("Parse Error - " + e.message, 5000); }
                };
                if (!sel) new PropertyPromptModal(this.app, "", processAndInsert).open();
                else processAndInsert(sel);
            }
        });

        this.registerEvent(
            this.app.workspace.on('editor-paste', (evt: ClipboardEvent, editor: Editor) => {
                if (!this.settings.smartPaste) return;
                const text = evt.clipboardData?.getData('text/plain');
                if (!text) return;
                const cleanText = text.trim();
                if (cleanText.includes('V2000') || cleanText.includes('V3000')) {
                    evt.preventDefault(); this.insertAtCursor(editor, cleanText, "mol"); return;
                }
                const smilesRegex = /^([BCNOPSFIcbcnops@+\-\[\]\(\)\\\/=#%0-9]{4,})$/;
                if (smilesRegex.test(cleanText) && /[CNOcno]/.test(cleanText)) {
                    evt.preventDefault(); this.insertAtCursor(editor, cleanText, "smiles");
                }
            })
        );

        const formats = ["smiles", "mol", "sdf", "idcode"];
        formats.forEach(fmt => {
            this.registerMarkdownCodeBlockProcessor(fmt, (source, el, ctx) => {
                const cleanSource = source.trim();
                const lines = cleanSource.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0);

                if ((fmt === 'smiles' || fmt === 'idcode') && lines.length > 1) {
                    const grid = el.createDiv();
                    grid.style.display = "grid";
                    grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(140px, 1fr))`;
                    grid.style.gap = "10px";
                    grid.style.margin = "10px 0";

                    for (const line of lines) {
                        const cell = grid.createDiv();
                        this.renderChemicalToElement(line, fmt, cell, ctx, true, 140, 140);
                    }
                } else {
                    this.renderChemicalToElement(cleanSource, fmt, el, ctx, false, this.settings.width, this.settings.height);
                }
            });
        });

        this.registerMarkdownCodeBlockProcessor("chemprops", (source, el, ctx) => {
            this.renderChemicalProperties(source, el);
        });

        // Use ElnGalleryRenderer from SharedEln.ts
        this.registerMarkdownCodeBlockProcessor("chem-gallery", async (source, el, ctx) => {
            const galleryRenderer = new ElnGalleryRenderer(this);
            await galleryRenderer.renderChemGallery(source, el, ctx);
        });

        this.registerMarkdownCodeBlockProcessor("eln-gallery", async (source, el, ctx) => {
            const galleryRenderer = new ElnGalleryRenderer(this); 
            await galleryRenderer.renderGalleryBlock(source, el, ctx);
        });

        this.registerMarkdownCodeBlockProcessor("eln", async (source, el, ctx) => {
            const container = document.createElement("div");
            el.appendChild(container);

            const elnRenderer = new SharedElnRenderer(this);
            await elnRenderer.renderElnBlock(source, container, ctx);
            
            // @ts-ignore
            const Smi = SmiDrawer;
            const theme = document.body.hasClass("theme-dark") ? this.settings.darkTheme : this.settings.lightTheme;
        
            container.querySelectorAll('.eln-structure').forEach((node: HTMLElement) => {
                const smiles = node.getAttribute('data-smiles');
                const cssSize = node.classList.contains('scheme-size') ? 110 : 90;
                
                if (smiles) {
                    if (this.settings.renderingEngine === 'smilesdrawer') {
                        this.renderWithSmilesDrawer(smiles, node, cssSize, cssSize);
                    } else {
                        try {
                            const mol = OCL.Molecule.fromSmiles(smiles);
                            node.style.color = "var(--text-normal)";
                            node.innerHTML = this.fixSvgDarkMode(mol.toSVG(cssSize, cssSize));
                        } catch(e) {
                            node.innerHTML = `<span style="color:var(--text-error); padding:10px;">Invalid</span>`;
                        }
                    }
                }
                
                node.addEventListener("contextmenu", (e) => {
                    if (smiles) this.showChemicalContextMenu(e, smiles);
                });

                node.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    const type = node.getAttribute('data-type');
                    const index = parseInt(node.getAttribute('data-index') || '0', 10);
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    const info = ctx.getSectionInfo(el.parentElement || el);
                    
                    this.openKetcherModal(smiles || "", "smiles", (newData) => {
                        if (info && view) {
                            const { parseYaml, stringifyYaml } = require('obsidian');
                            const blockText = view.editor.getRange({line: info.lineStart + 1, ch: 0}, {line: info.lineEnd, ch: 0});
                            try {
                                const yamlObj = parseYaml(blockText);
                                yamlObj[type!][index].smiles = newData;
                                const newYaml = stringifyYaml(yamlObj);
                                view.editor.replaceRange(newYaml, {line: info.lineStart + 1, ch: 0}, {line: info.lineEnd, ch: 0});
                            } catch (err) { new Notice("Failed to parse YAML block."); }
                        }
                    });
                });
            });
        });
    }

    refreshRibbonIcons() {
        if (this.settings.showElnRibbonIcon) {
            if (!this.elnRibbonEl) {
                this.elnRibbonEl = this.addRibbonIcon('flask-round', 'New ELN Experiment', () => {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    let targetFolder = this.settings.defaultElnDirectory;
                    if (!targetFolder && view && view.file && view.file.parent) {
                        targetFolder = view.file.parent.path;
                        if (targetFolder === "/") targetFolder = "";
                    }

                    let i = 1;
                    let suggestedCode = this.settings.defaultExpPrefix + "-001";
                    while (true) {
                        suggestedCode = `${this.settings.defaultExpPrefix}-${i.toString().padStart(3, '0')}`;
                        let testPath = targetFolder ? `${targetFolder}/${suggestedCode}.md` : `${suggestedCode}.md`;
                        if (!this.app.vault.getAbstractFileByPath(testPath)) break;
                        i++;
                    }

                    new CreateExperimentModal(this.app, suggestedCode, (code) => {
                        createNewElnExperiment(this.app, code, targetFolder, this.settings.analyticalSections);
                    }).open();
                });
            } else { this.elnRibbonEl.style.display = ''; }
        } else {
            if (this.elnRibbonEl) this.elnRibbonEl.style.display = 'none';
        }

        if (this.settings.showMediaRibbonIcons) {
            if (!this.cameraRibbonEl) {
                this.cameraRibbonEl = this.addRibbonIcon('camera', 'Take Lab Photo', () => {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (!view) { new Notice("Place cursor in a Markdown file first."); return; }
                    takeStandardPhoto(async (buffer, ext) => {
                        const link = await saveMediaFile(this.app, buffer, this.settings.mediaSavePath, `Photo_${window.moment().format("YYYYMMDD_HHmmss")}.${ext}`);
                        view.editor.replaceSelection(`\n![[${link}]]\n`);
                    });
                });
            } else { this.cameraRibbonEl.style.display = ''; }
            
            if (!this.tlcRibbonEl) {
                this.tlcRibbonEl = this.addRibbonIcon('image-file', 'Add TLC Plate', () => {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (!view) { new Notice("Place cursor in a Markdown file first."); return; }
                    new TlcModal(this.app, async (pngData, rfData) => {
                        const link = await saveMediaFile(this.app, pngData, this.settings.mediaSavePath, `TLC_${window.moment().format("YYYYMMDD_HHmmss")}.png`);
                        let md = `\n![[${link}]]\n\n| Spot | $R_f$ |\n|---|---|\n`;
                        rfData.forEach((s, i) => md += `| ${i+1} | **${s.rf.toFixed(2)}** |\n`);
                        view.editor.replaceSelection(md);
                    }).open();
                });
            } else { this.tlcRibbonEl.style.display = ''; }
        } else {
            if (this.cameraRibbonEl) this.cameraRibbonEl.style.display = 'none';
            if (this.tlcRibbonEl) this.tlcRibbonEl.style.display = 'none';
        }
    }

    insertAtCursor(editor: Editor, data: string, format: string) {
        const textToInsert = `\n\`\`\`${format}\n${data}\n\`\`\`\n`;
        editor.replaceSelection(textToInsert);
    }

    async renderChemicalToElement(cleanSource: string, format: string, el: HTMLElement, ctx: any, isGridItem: boolean, w: number, h: number) {
        const wrapper = document.createElement("div");
        wrapper.className = "chem-svg-wrapper";
        wrapper.style.cursor = "pointer";
        wrapper.style.textAlign = "center";
        wrapper.style.padding = "10px";
        wrapper.style.margin = isGridItem ? "0" : "10px 0";
        wrapper.style.backgroundColor = "var(--background-primary)";
        wrapper.style.border = "1px solid var(--background-modifier-border)";
        wrapper.style.borderRadius = "8px";
        el.appendChild(wrapper);

        let actualData = cleanSource;
        let isFile = false;
        let targetFile: TFile | null = null;

        const bracketMatch = cleanSource.match(/\[\[(.*?)\]\]/);
        let filenameToSearch = "";
        if (bracketMatch && bracketMatch[1]) filenameToSearch = bracketMatch[1].trim();
        else if (cleanSource.endsWith('.mol') || cleanSource.endsWith('.sdf')) filenameToSearch = cleanSource.trim();

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
            wrapper.innerHTML = `<span class="color-text-muted">Empty. Double-tap to draw.</span>`;
        } else {
            if (this.settings.renderingEngine === 'smilesdrawer') {
                let smilesToDraw = actualData;
                if (format !== "smiles" || !actualData.includes('>')) {
                    try {
                        let mol;
                        if (format === "smiles") mol = OCL.Molecule.fromSmiles(actualData);
                        else if (format === "idcode") mol = OCL.Molecule.fromIDCode(actualData);
                        else mol = OCL.Molecule.fromMolfile(actualData);
                        smilesToDraw = mol.toSmiles();
                    } catch(e) { }
                }
                this.renderWithSmilesDrawer(smilesToDraw, wrapper, w, h);
                wrapper.addEventListener("contextmenu", (e) => this.showChemicalContextMenu(e, smilesToDraw));
            } else {
                try {
                    let molecule;
                    if (format === "smiles") molecule = OCL.Molecule.fromSmiles(actualData);
                    else if (format === "idcode") molecule = OCL.Molecule.fromIDCode(actualData);
                    else molecule = OCL.Molecule.fromMolfile(actualData);
                    wrapper.style.color = "var(--text-normal)";
                    wrapper.innerHTML = this.fixSvgDarkMode(molecule.toSVG(w, h));
                    wrapper.addEventListener("contextmenu", (e) => this.showChemicalContextMenu(e, molecule.toSmiles()));
                } catch (err: any) {
                    wrapper.innerHTML = `<span style="color: var(--text-error);">Rendering Error: ${err.message}</span>`;
                }
            }
        }

        wrapper.addEventListener("dblclick", async (e) => {
            e.stopPropagation();
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view) return;
            
            if (isFile && targetFile) actualData = await this.app.vault.read(targetFile);
            
            if (isGridItem && !isFile) {
                new Notice("Cannot inline-edit structures inside a Grid yet. Please edit the codeblock manually.");
                return;
            }

            const info = ctx.getSectionInfo(el.parentElement || el);
            this.openKetcherModal(actualData, format, async (newData) => {
                if (isFile && targetFile) {
                    await this.app.vault.modify(targetFile, newData);
                    new Notice(`Updated ${targetFile.name}`);
                } else if (info) {
                    const editor = view.editor;
                    editor.replaceRange(`\`\`\`${format}\n${newData}\n\`\`\``, 
                        { line: info.lineStart, ch: 0 }, 
                        { line: info.lineEnd, ch: editor.getLine(info.lineEnd).length });
                }
            });
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
            try { mol = OCL.Molecule.fromSmiles(cleanSource); } catch { mol = OCL.Molecule.fromIDCode(cleanSource); }
            
            const svgEl = wrapper.createDiv();
            svgEl.className = "chem-svg-wrapper"; 
            svgEl.style.flexShrink = "0";
            
            if (this.settings.renderingEngine === 'smilesdrawer') {
                this.renderWithSmilesDrawer(mol.toSmiles(), svgEl, 120, 120);
            } else {
                svgEl.style.color = "var(--text-normal)";
                svgEl.innerHTML = this.fixSvgDarkMode(mol.toSVG(120, 120));
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

class PropertyPromptModal extends Modal {
    initialValue: string; onSubmit: (input: string) => void;
    constructor(app: App, initialValue: string, onSubmit: (input: string) => void) {
        super(app); this.initialValue = initialValue; this.onSubmit = onSubmit;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Calculate Properties" });
        contentEl.createEl("p", { text: "Enter a valid SMILES or IDCode:", cls: "color-text-muted", attr: { style: "font-size: 0.9em;" } });

        const input = contentEl.createEl("input", { type: "text", value: this.initialValue });
        input.style.width = "100%"; input.style.marginBottom = "15px";

        const btn = contentEl.createEl("button", { text: "Calculate", cls: "mod-cta" });
        btn.onclick = () => { if (input.value) { this.onSubmit(input.value.trim()); this.close(); } };
        input.addEventListener("keypress", (e) => { if (e.key === "Enter" && input.value) { this.onSubmit(input.value.trim()); this.close(); } });
        setTimeout(() => input.focus(), 50);
    }
    onClose() { this.contentEl.empty(); }
}

class ChemEditUniversalSettingTab extends PluginSettingTab {
    plugin: ChemEditUniversalPlugin;
    constructor(app: App, plugin: ChemEditUniversalPlugin) { super(app, plugin); this.plugin = plugin; }

    display(): void {
        const {containerEl} = this; containerEl.empty();
        containerEl.createEl('h2', {text: 'ChemEdit Universal Settings'});

        const statusEl = containerEl.createEl('div', { cls: 'setting-item-description' });
        statusEl.innerHTML = `<span style="color:var(--text-success); font-size:1.1em">✅ <b>OpenChemLib Backend Active</b></span>`;
        containerEl.createEl('br');

        containerEl.createEl('h3', { text: '📚 Compound Library' });
        new Setting(containerEl)
            .setName('Compound Library File Path')
            .setDesc('Optional: Point to a .md file (e.g. Meta/Compounds.md) that contains markdown tables or lists of your common chemicals. Used for auto-filling the ELN and the Library command.')
            .addText(text => text
                .setPlaceholder('Meta/Compounds.md')
                .setValue(this.plugin.settings.libraryFilePath)
                .onChange(async (v) => {
                    this.plugin.settings.libraryFilePath = v;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: '🔬 Fume Hood & ELN Utilities' });

        new Setting(containerEl)
            .setName('Show Media Ribbon Icons')
            .setDesc('Turn this on to display the "Take Photo" and "TLC Plate" icons in your left sidebar ribbon.')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.showMediaRibbonIcons).onChange(async (v) => { this.plugin.settings.showMediaRibbonIcons = v; await this.plugin.saveSettings(); this.plugin.refreshRibbonIcons(); }));

        new Setting(containerEl)
            .setName('Media Images Save Path')
            .setDesc('Folder where camera/TLC pictures will be stored (e.g. Assets/)')
            .addText(text => text.setPlaceholder('Assets/').setValue(this.plugin.settings.mediaSavePath).onChange(async (v) => { this.plugin.settings.mediaSavePath = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Show Blank ELN Icon')
            .setDesc('Display the Flask icon in the sidebar to generate blank experiments.')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.showElnRibbonIcon).onChange(async (v) => { this.plugin.settings.showElnRibbonIcon = v; await this.plugin.saveSettings(); this.plugin.refreshRibbonIcons(); }));

        new Setting(containerEl)
            .setName('Default ELN Directory')
            .setDesc('Folder where new ELN experiments will be saved by default (e.g. Experiments/). Leave blank to save in the current active folder.')
            .addText(text => text.setPlaceholder('Experiments/').setValue(this.plugin.settings.defaultElnDirectory).onChange(async (v) => { this.plugin.settings.defaultElnDirectory = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Default Experiment Prefix')
            .setDesc('Prefix for new ELN files (e.g., EXP, JH, CHEM).')
            .addText(text => text.setPlaceholder('EXP').setValue(this.plugin.settings.defaultExpPrefix).onChange(async (v) => { this.plugin.settings.defaultExpPrefix = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Analytical Sections')
            .setDesc('Comma-separated list of sections to auto-generate inside new experiments.')
            .addText(text => text.setPlaceholder('TLC, LCMS, NMR').setValue(this.plugin.settings.analyticalSections).onChange(async (v) => { this.plugin.settings.analyticalSections = v; await this.plugin.saveSettings(); }));

        containerEl.createEl('h3', { text: '🖱️ Context Menu (Right-Click)' });
        containerEl.createEl('div', { cls: 'setting-item-description', text: 'Customize the links in the right-click menu for SMILES blocks. Use {{smiles}} to inject the structure.' }).style.marginBottom = "10px";
        
        new Setting(containerEl).setName('Custom Link 1 Name').addText(text => text.setValue(this.plugin.settings.contextUrl1Name).onChange(async (v) => { this.plugin.settings.contextUrl1Name = v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Custom Link 1 URL').addText(text => text.setValue(this.plugin.settings.contextUrl1).onChange(async (v) => { this.plugin.settings.contextUrl1 = v; await this.plugin.saveSettings(); }));
        
        new Setting(containerEl).setName('Custom Link 2 Name').addText(text => text.setValue(this.plugin.settings.contextUrl2Name).onChange(async (v) => { this.plugin.settings.contextUrl2Name = v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Custom Link 2 URL').addText(text => text.setValue(this.plugin.settings.contextUrl2).onChange(async (v) => { this.plugin.settings.contextUrl2 = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl).setName('Custom Link 3 Name').addText(text => text.setValue(this.plugin.settings.contextUrl3Name).onChange(async (v) => { this.plugin.settings.contextUrl3Name = v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Custom Link 3 URL').addText(text => text.setValue(this.plugin.settings.contextUrl3).onChange(async (v) => { this.plugin.settings.contextUrl3 = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl).setName('Custom Link 4 Name').addText(text => text.setValue(this.plugin.settings.contextUrl4Name).onChange(async (v) => { this.plugin.settings.contextUrl4Name = v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Custom Link 4 URL').addText(text => text.setValue(this.plugin.settings.contextUrl4).onChange(async (v) => { this.plugin.settings.contextUrl4 = v; await this.plugin.saveSettings(); }));


        containerEl.createEl('br');
        containerEl.createEl('h3', { text: 'Rendering Options' });

        new Setting(containerEl)
            .setName('SMILES Rendering Engine')
            .setDesc('Choose which engine draws SMILES blocks and ELN tables. SmilesDrawer is prettier and handles themes, OpenChemLib matches the mobile drawing editor.')
            .addDropdown(drop => drop
                .addOption('smilesdrawer', 'SmilesDrawer (Beautiful)')
                .addOption('openchemlib', 'OpenChemLib (Native)')
                .setValue(this.plugin.settings.renderingEngine)
                .onChange(async (v) => { this.plugin.settings.renderingEngine = v as any; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Image Width')
            .addText(text => text.setPlaceholder('300').setValue(this.plugin.settings.width.toString())
                .onChange(async (v) => { this.plugin.settings.width = parseInt(v) || 300; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Image Height')
            .addText(text => text.setPlaceholder('300').setValue(this.plugin.settings.height.toString())
                .onChange(async (v) => { this.plugin.settings.height = parseInt(v) || 300; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Smart Paste')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.smartPaste).onChange(async (v) => { this.plugin.settings.smartPaste = v; await this.plugin.saveSettings(); }));

        containerEl.createEl('h3', { text: 'SmilesDrawer Theme Options' });
        
        new Setting(containerEl)
            .setName('Render as SVG (Experimental)')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.useSvgSmiles).onChange(async (v) => { this.plugin.settings.useSvgSmiles = v; await this.plugin.saveSettings(); }));

        const themeOptions = { 'light': 'Light', 'dark': 'Dark', 'oldschool': 'Oldschool (B&W)', 'solarized': 'Solarized Light', 'solarized-dark': 'Solarized Dark', 'matrix': 'Matrix', 'cyberpunk': 'Cyberpunk' };

        new Setting(containerEl)
            .setName('Light Theme')
            .addDropdown(drop => drop.addOptions(themeOptions).setValue(this.plugin.settings.lightTheme).onChange(async (v) => { this.plugin.settings.lightTheme = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Dark Theme')
            .addDropdown(drop => drop.addOptions(themeOptions).setValue(this.plugin.settings.darkTheme).onChange(async (v) => { this.plugin.settings.darkTheme = v; await this.plugin.saveSettings(); }));
    }
}

class OCLEditorModal extends Modal {
    plugin: any; initialData: string; format: string; onSave: (data: string) => void; editor: any = null;
    constructor(plugin: any, initialData: string, format: string, onSave: (data: string) => void) {
        super(plugin.app); this.plugin = plugin; this.initialData = initialData; this.format = format || "smiles"; this.onSave = onSave;
    }
    onOpen() {
        const { contentEl, modalEl } = this; contentEl.empty();
        if (Platform.isMobile) { modalEl.style.width = "100vw"; modalEl.style.height = "100vh"; modalEl.style.padding = "0"; modalEl.style.margin = "0"; contentEl.style.padding = "0"; document.body.style.overflow = "hidden"; } 
        else { modalEl.style.width = "85vw"; modalEl.style.height = "85vh"; }
        
        contentEl.style.height = "100%"; contentEl.style.display = "flex"; contentEl.style.flexDirection = "column";

        const editorContainer = contentEl.createDiv();
        editorContainer.className = "chem-editor-container";
        editorContainer.style.flex = "1 1 auto"; editorContainer.style.width = "100%"; editorContainer.style.height = "100%"; editorContainer.style.minHeight = "400px"; editorContainer.style.touchAction = "none"; editorContainer.style.backgroundColor = "white"; 

        const btnContainer = contentEl.createDiv();
        btnContainer.style.display = "flex"; btnContainer.style.justifyContent = "flex-end"; btnContainer.style.gap = "10px"; btnContainer.style.padding = "10px"; btnContainer.style.backgroundColor = "var(--background-secondary)";

        const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
        const saveBtn = btnContainer.createEl("button", { text: `Save (${this.format.toUpperCase()})`, cls: "mod-cta" });

        setTimeout(() => {
            try {
                this.editor = new OCL.CanvasEditor(editorContainer, {});
                if (this.initialData) {
                    let mol;
                    if (this.format === "smiles") mol = OCL.Molecule.fromSmiles(this.initialData);
                    else if (this.format === "idcode") mol = OCL.Molecule.fromIDCode(this.initialData);
                    else mol = OCL.Molecule.fromMolfile(this.initialData);
                    if (mol) this.editor.setMolecule(mol);
                }
            } catch (e: any) { new Notice("Failed to load editor: " + e.message); }
        }, 100);

        saveBtn.onclick = () => {
            if (this.editor) {
                try {
                    const mol = this.editor.getMolecule();
                    let outputData = "";
                    if (this.format === "smiles") outputData = mol.toSmiles();
                    else if (this.format === "idcode") outputData = mol.getIDCode();
                    else outputData = mol.toMolfile();
                    this.onSave(outputData); this.close();
                } catch (e: any) { new Notice("Failed to generate structure: " + e.message); }
            }
        };
        cancelBtn.onclick = () => this.close();
    }
    onClose() { if (Platform.isMobile) document.body.style.overflow = ""; this.contentEl.empty(); this.editor = null; }
}