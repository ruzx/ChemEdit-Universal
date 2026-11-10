// Element data: symbol, average mass, monoisotopic mass, valences, colours.

const SYMBOLS =
  "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr " +
  "Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu " +
  "Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg " +
  "Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og";

const AVG = [
  1.008, 4.0026, 6.94, 9.0122, 10.81, 12.011, 14.007, 15.999, 18.998, 20.18, 22.99, 24.305, 26.982, 28.085, 30.974,
  32.06, 35.45, 39.948, 39.098, 40.078, 44.956, 47.867, 50.942, 51.996, 54.938, 55.845, 58.933, 58.693, 63.546, 65.38,
  69.723, 72.63, 74.922, 78.971, 79.904, 83.798, 85.468, 87.62, 88.906, 91.224, 92.906, 95.95, 98, 101.07, 102.91,
  106.42, 107.87, 112.41, 114.82, 118.71, 121.76, 127.6, 126.9, 131.29, 132.91, 137.33, 138.91, 140.12, 140.91, 144.24,
  145, 150.36, 151.96, 157.25, 158.93, 162.5, 164.93, 167.26, 168.93, 173.05, 174.97, 178.49, 180.95, 183.84, 186.21,
  190.23, 192.22, 195.08, 196.97, 200.59, 204.38, 207.2, 208.98, 209, 210, 222, 223, 226, 227, 232.04, 231.04, 238.03,
  237, 244, 243, 247, 247, 251, 252, 257, 258, 259, 266, 267, 268, 269, 270, 277, 278, 281, 282, 285, 286, 289, 290,
  293, 294, 294,
];

const MONO: Record<string, number> = {
  H: 1.007825, He: 4.002603, Li: 7.016004, Be: 9.012182, B: 11.009305, C: 12, N: 14.003074, O: 15.994915,
  F: 18.998403, Ne: 19.99244, Na: 22.98977, Mg: 23.985042, Al: 26.981538, Si: 27.976927, P: 30.973762,
  S: 31.972071, Cl: 34.968853, Ar: 39.962383, K: 38.963707, Ca: 39.962591, Sc: 44.95591, Ti: 47.947947,
  V: 50.943963, Cr: 51.940512, Mn: 54.93805, Fe: 55.934942, Co: 58.9332, Ni: 57.935348, Cu: 62.929601,
  Zn: 63.929147, Ga: 68.925581, Ge: 73.921178, As: 74.921596, Se: 79.916522, Br: 78.918338, Kr: 83.911507,
  Rb: 84.911789, Sr: 87.905614, Y: 88.905848, Zr: 89.904704, Nb: 92.906378, Mo: 97.905408, Ru: 101.90435,
  Rh: 102.905504, Pd: 105.903483, Ag: 106.905093, Cd: 113.903358, In: 114.903878, Sn: 119.902197,
  Sb: 120.903818, Te: 129.906223, I: 126.904468, Xe: 131.904154, Cs: 132.905447, Ba: 137.905241,
  La: 138.906348, Ce: 139.905435, Nd: 141.907719, Sm: 151.919728, Eu: 152.921226, Gd: 157.924101,
  Yb: 173.938858, Hf: 179.946549, Ta: 180.947996, W: 183.950928, Re: 186.955751, Os: 191.961479,
  Ir: 192.962924, Pt: 194.964774, Au: 196.966552, Hg: 201.970617, Tl: 204.974412, Pb: 207.976636,
  Bi: 208.980383, U: 238.050783,
};

const ISOTOPE_MASS: Record<string, number> = {
  "2H": 2.014102, "3H": 3.016049, "13C": 13.003355, "14C": 14.003242, "15N": 15.000109,
  "17O": 16.999132, "18O": 17.99916, "18F": 18.000938, "34S": 33.967867, "37Cl": 36.965903, "81Br": 80.916291,
};

export const ELEMENTS: string[] = SYMBOLS.split(" ");
const INDEX: Record<string, number> = {};
ELEMENTS.forEach((s, i) => (INDEX[s] = i));

export function isElement(sym: string): boolean {
  return sym in INDEX;
}
export function atomicNumber(sym: string): number {
  return sym in INDEX ? INDEX[sym] + 1 : 0;
}
export function avgMass(sym: string, isotope?: number): number {
  if (isotope) return ISOTOPE_MASS[isotope + sym] ?? isotope;
  return sym in INDEX ? AVG[INDEX[sym]] : 0;
}
export function monoMass(sym: string, isotope?: number): number {
  if (isotope) return ISOTOPE_MASS[isotope + sym] ?? isotope;
  return MONO[sym] ?? avgMass(sym);
}

/** Atoms written without brackets in SMILES. */
export const ORGANIC_SUBSET = new Set(["B", "C", "N", "O", "P", "S", "F", "Cl", "Br", "I"]);

/** Normal valences used to derive implicit hydrogens (only for these elements). */
export const VALENCES: Record<string, number[]> = {
  H: [1], B: [3], C: [4], N: [3, 5], O: [2], F: [1], Si: [4], P: [3, 5], S: [2, 4, 6], Cl: [1, 3, 5, 7],
  Ge: [4], As: [3, 5], Se: [2, 4, 6], Br: [1, 3, 5], Te: [2, 4, 6], I: [1, 3, 5],
};

const GROUP: Record<string, number> = {
  H: 1, B: 13, C: 14, Si: 14, Ge: 14, N: 15, P: 15, As: 15, O: 16, S: 16, Se: 16, Te: 16, F: 17, Cl: 17, Br: 17, I: 17,
};

/**
 * Number of implicit hydrogens for an atom with given element, formal charge and
 * sum of explicit bond orders. Returns 0 for elements without a default valence.
 */
export function implicitHydrogens(el: string, charge: number, bondSum: number, radical = 0): number {
  const vals = VALENCES[el];
  if (!vals) return 0;
  const g = GROUP[el] ?? 0;
  let adjusted: number[];
  if (g === 13) adjusted = vals.map((v) => v - charge); // B- => 4
  else if (g === 14) adjusted = vals.map((v) => v - Math.abs(charge));
  else if (g === 1) adjusted = charge === 0 ? vals : [0];
  else adjusted = vals.map((v) => v + charge); // N+ => 4, O- => 1
  const used = bondSum + radical;
  for (const v of adjusted) if (v >= used) return Math.max(0, v - used);
  return 0;
}

/** Highest allowed valence (for warnings). */
export function maxValence(el: string, charge: number): number | null {
  const vals = VALENCES[el];
  if (!vals) return null;
  const g = GROUP[el] ?? 0;
  const top = vals[vals.length - 1];
  if (g === 13) return top - charge;
  if (g === 14) return top - Math.abs(charge);
  if (g === 1) return charge === 0 ? 1 : 0;
  return top + charge;
}

const COLORS: Record<string, string> = {
  N: "#2349d9", O: "#e0261b", S: "#b39200", P: "#e06c00", F: "#1f9e3a", Cl: "#1f9e3a", Br: "#a42a2a",
  I: "#8a1fa0", B: "#d16a6a", Si: "#8a6d3b", Se: "#c46d00", Li: "#8a4fd8", Na: "#8a4fd8", K: "#8a4fd8",
  Mg: "#2d8a2d", Fe: "#c0561b", Cu: "#b5651d", Zn: "#6b6bb5", Pd: "#0b6f84", Pt: "#5d6d7e",
};
export function elementColor(el: string): string | null {
  return COLORS[el] ?? null;
}

/** Periodic table layout: [symbol, row(1..10), col(1..18)] */
export function periodicLayout(): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  const place = (z: number, r: number, c: number) => out.push([ELEMENTS[z - 1], r, c]);
  place(1, 1, 1); place(2, 1, 18);
  place(3, 2, 1); place(4, 2, 2); for (let z = 5; z <= 10; z++) place(z, 2, z + 8);
  place(11, 3, 1); place(12, 3, 2); for (let z = 13; z <= 18; z++) place(z, 3, z);
  for (let z = 19; z <= 36; z++) place(z, 4, z - 18);
  for (let z = 37; z <= 54; z++) place(z, 5, z - 36);
  place(55, 6, 1); place(56, 6, 2); for (let z = 72; z <= 86; z++) place(z, 6, z - 68);
  place(87, 7, 1); place(88, 7, 2); for (let z = 104; z <= 118; z++) place(z, 7, z - 100);
  for (let z = 57; z <= 71; z++) place(z, 9, z - 54);
  for (let z = 89; z <= 103; z++) place(z, 10, z - 86);
  return out;
}
