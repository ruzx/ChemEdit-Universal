import { ChemEditor } from "../src/editor/editor";
import * as chem from "../src/chem/index";
(window as any).ChemEditor = ChemEditor;
(window as any).chem = chem;
const host = document.getElementById("host")!;
(window as any).ed = new ChemEditor(host, { initial: (window as any).INITIAL, resolveName: async (n: string) => (n.toLowerCase() === "aspirin" ? "CC(=O)Oc1ccccc1C(=O)O" : null) });
