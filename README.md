# ChemEdit Universal

A lightweight chemical structure editor for Obsidian. Works on both Desktop and Obsidian Mobile (iOS/Android).

ChemEdit universal mobile demo:

<video src="https://github.com/user-attachments/assets/e810be8b-b324-4d93-9a61-4728afdf9706" controls width="800"></video>

### 🚀 What's New in ChemEdit Universal 1.0.6

* **Compound Library** — Search, insert, and save compounds from built-in or custom Markdown libraries.
* **Chemistry Context Menu** — Right-click structures to copy SMILES/MOL, retrieve chemical properties, and open PubChem, ChemSpider, MolPort, or NMRium.
* **Advanced ELN** — Improved responsive tables, intelligent stoichiometry, experiment cloning, macros, automatic experiment numbering, and Excel export.
* **Grid & Gallery Views** — Render multiple SMILES as grids and browse reactions or molecules from folders as visual galleries.
* **Mobile & Desktop** — Universal adds offline structure rendering/calculation with OpenChemLib, plus selectable SmilesDrawer/OpenChemLib rendering engines.
* **Stability & UX** — Improved integration, mobile ELN rendering, and overall performance.
* **Offline chemistry tools** — Structure rendering, properties, and MOL generation work without an internet connection.
* **Two rendering engines** — Choose between SmilesDrawer and OpenChemLib.

1.0.5

* **Interactive ELN Editor:** Added a floating action bar to ELN blocks. You can now visually edit Reactants, Products, Equivalents, and Procedures via a clean UI without touching Markdown YAML!
* **🧪 Auto-Name Structures:** Added a smart "Auto-Name" button inside the ELN editor that automatically fetches IUPAC/Common names for your drawn structures via PubChem/CACTUS.
* **📸 Fume Hood Utilities (Media Ribbon):** Take Lab Photos or upload TLC plates directly into your notes. 

***

## ✨ Features

- **📱 Fully Mobile Compatible:** A touch-friendly UI that works on phones and tablets.
- **🔌 100% Offline:** Render structures and calculate properties without an internet connection.
- **🧪 MedChem Calculator:** Instantly calculate Molecular Weight, Exact Mass, LogP, LogS, Polar Surface Area (PSA), Hydrogen Bond Donors/Acceptors, and Stereocenter counts.
- **📋 Smart Paste:** Paste raw SMILES or MOL strings into Obsidian, and the plugin can automatically wrap them in code blocks for instant rendering.

## 🚀 How to Use

### 1. Drawing a New Molecule

Click the **Hexagon Icon** in your left ribbon menu (or use the Command Palette: `Draw new molecule (SMILES)`). A touch-friendly editor will open. Draw your molecule, click Save, and it will be inserted into your note.

### 2. Displaying Structures (Code Blocks)

You can manually type or paste chemical data inside specific code blocks to render them as SVG images.

**SMILES:**
\`\`\`smiles
CC(=O)Oc1ccccc1C(=O)O
\`\`\`

**Files (MOL/SDF):**
You can embed actual `.mol` files saved in your Obsidian Vault! If you double-click the image to edit it, **your `.mol` file will be updated automatically.**
\`\`\`mol
[[aspirin.mol]]
\`\`\`

### 3. Calculating Chemical Properties

Highlight a SMILES string in your text, open the Command Palette, and select **"Calculate Properties (SMILES/IDCode)"**. The plugin will calculate the properties and insert a beautiful summary block beneath your cursor:

> 🧪 **Formula:** C9H8O4 | **MW:** 180.1598 | **Exact Mass:** 180.0423 | **LogP:** 1.31 | **LogS:** -2.13 | **PSA:** 65.3 Å² | **HBD:** 1 | **HBA:** 4 | **Rot. Bonds:** 3 | **Stereocenters:** 0

*(You can also use the `chemprops` code block to render a permanent widget showing the molecule and its properties).*

## ⚙️ Settings

- **Width/Height:** Control the default size of the rendered SVG images in your notes.
- **Smart Paste:** When enabled, pasting a SMILES string like `c1ccccc1` will automatically wrap it in a \`\`\`smiles\`\`\` block. 

## 🛠 Credits

Powered by the excellent [OpenChemLib](https://github.com/Actelion/openchemlib) library (the same engine behind DataWarrior).
