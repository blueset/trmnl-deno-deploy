import type { GoogleFontsMetadata } from "../../src/google-fonts/types.ts";

/** A small but representative metadata document used across the unit tests. */
export function makeMetadata(): GoogleFontsMetadata {
  return {
    fonts: [
      {
        name: "Alpha Sans",
        primary_language: "en_Latn",
        primary_script: "Latn",
        subsets: ["latin", "latin-ext"],
        date_added: "2020-01-01",
        qualities: [{ type: "Quality", quality: "Display" }],
        axes: [],
      },
      {
        name: "Beta Pixel",
        primary_language: "en_Latn",
        primary_script: "Latn",
        subsets: ["latin", "menu"],
        date_added: "2021-06-15",
        qualities: [{ type: "Style", quality: "Pixel" }],
      },
      {
        name: "Gamma Cyrillic",
        primary_language: "ru_Cyrl",
        primary_script: "Cyrl",
        subsets: ["cyrillic", "cyrillic-ext", "latin"],
        date_added: "2022-03-09",
        axes: [{ tag: "wght", min_value: 100, max_value: 900 }],
      },
      {
        name: "Delta Japanese",
        primary_language: "ja_Jpan",
        primary_script: "Jpan",
        subsets: ["japanese"],
        date_added: "2024-11-02",
        sample_text: [{ styles: "愛のあるユニークで豊かな書体" }],
        axes: [{ tag: "slnt", min_value: -10, max_value: 0 }],
      },
      {
        name: "Epsilon Unknown",
        primary_language: "xx_Zzzz",
        primary_script: "Zzzz",
        subsets: ["latin"],
        date_added: "2019-05-20",
      },
    ],
    sample_texts: {
      en_Latn: { sample_text: [{ styles: "The quick brown fox", tester: "Pack my box" }] },
      ru_Cyrl: {
        sample_text: [{ styles: "Съешь ещё этих мягких", tester: "Широкая электрификация" }],
      },
      ja_Jpan: { sample_text: [{ styles: "いろはにほへと", tester: "とりなくこゑ" }] },
    },
    scripts: {
      Latn: { name: "Latin" },
      Cyrl: { name: "Cyrillic" },
      Jpan: { name: "Japanese" },
    },
    axes: {
      wght: { display_name: "Weight" },
      slnt: { display_name: "Slant" },
    },
  };
}

export function metadataJson(): string {
  return JSON.stringify(makeMetadata());
}
