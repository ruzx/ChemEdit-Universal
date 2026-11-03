# ChemEdit Universal

A lightweight chemical structure editor for Obsidian. Works on both Desktop and Obsidian Mobile (iOS/Android).

ChemEdit universal mobile demo:

<video src="https://github.com/user-attachments/assets/e810be8b-b324-4d93-9a61-4728afdf9706" controls width="800"></video>

### 🚀 What's New in ChemEdit Universal 1.0.7

+ New, more functional editor (i.e. with support for reactions on mobile devices)
+ Cleaner interface (should be more convenient on mobile devices)
+ Canvas support (optional in settings)

- Some database/ELN related features from the previous version will be added to the next version.

New editor:

<img width="1566" height="1043" alt="image" src="https://github.com/user-attachments/assets/9bba3978-1e72-4c6f-9de2-f0877989ff5f" />

  

***

## ✨ Features

- **📱 Fully Mobile Compatible:** A touch-friendly UI that works on phones and tablets.
- **🔌 Offline:** Render structures and calculate properties without an internet connection.

## 🚀 How to Use

### 1. Drawing a New Molecule

Click the **Hexagon Icon** in your left ribbon menu (or use the Command Palette: `Draw new molecule (SMILES)`). A touch-friendly editor will open. Draw your molecule, click Save, and it will be inserted into your note.

### 2. Displaying Structures (Code Blocks)

You can manually type or paste chemical data inside specific code blocks to render them as SVG images.

**SMILES:**
\`\`\`smiles
CC(=O)Oc1ccccc1C(=O)O
\`\`\`

**Files (MOL/SDF/CDXML):**
You can embed actual `.mol` files saved in your Obsidian Vault! If you double-click the image to edit it, **your `.mol` file will be updated automatically.**
\`\`\`mol
[[aspirin.mol]]
\`\`\`

<img width="903" height="195" alt="image" src="https://github.com/user-attachments/assets/707517aa-d029-4b35-b580-8d5ee38a2d01" />


## ⚙️ Settings

- **Width/Height:** Control the default size of the rendered SVG images in your notes.
- **Smart Paste:** When enabled, pasting a SMILES string like `c1ccccc1` will automatically wrap it in a \`\`\`smiles\`\`\` block. 

## 🛠 Credits

Powered by the excellent [OpenChemLib](https://github.com/Actelion/openchemlib) library (the same engine behind DataWarrior).
