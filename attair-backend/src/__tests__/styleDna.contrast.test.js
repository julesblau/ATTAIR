/**
 * Style DNA — Light-mode contrast override assertions
 *
 * The .sdna-overlay always has a #000 background. In light mode, CSS custom
 * properties like --text-primary flip to dark values (#1A1A1A), which would
 * be invisible on black. This test ensures the [data-theme='light'] .sdna-overlay
 * rule forces white text values so nothing disappears.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let css;

beforeAll(() => {
  const cssPath = resolve(__dirname, "../../../attair-app/src/App.css");
  css = readFileSync(cssPath, "utf-8");
});

describe("Style DNA light-mode contrast overrides", () => {
  it("contains [data-theme='light'] .sdna-overlay selector", () => {
    expect(css).toContain("[data-theme='light'] .sdna-overlay");
  });

  it("overrides --text-primary to white (#FFFFFF)", () => {
    // Extract the light-mode sdna-overlay rule block
    const ruleMatch = css.match(
      /\[data-theme='light'\]\s*\.sdna-overlay\s*\{([^}]+)\}/
    );
    expect(ruleMatch).not.toBeNull();
    const block = ruleMatch[1];
    expect(block).toContain("--text-primary: #FFFFFF");
  });

  it("overrides --text-secondary to white with opacity", () => {
    const ruleMatch = css.match(
      /\[data-theme='light'\]\s*\.sdna-overlay\s*\{([^}]+)\}/
    );
    const block = ruleMatch[1];
    expect(block).toContain("--text-secondary: rgba(255,255,255,0.6)");
  });

  it("overrides --text-tertiary to white with opacity", () => {
    const ruleMatch = css.match(
      /\[data-theme='light'\]\s*\.sdna-overlay\s*\{([^}]+)\}/
    );
    const block = ruleMatch[1];
    expect(block).toContain("--text-tertiary: rgba(255,255,255,0.4)");
  });

  it("overrides --text-inverse to black (#000000)", () => {
    const ruleMatch = css.match(
      /\[data-theme='light'\]\s*\.sdna-overlay\s*\{([^}]+)\}/
    );
    const block = ruleMatch[1];
    expect(block).toContain("--text-inverse: #000000");
  });

  it("overrides --border to white with opacity", () => {
    const ruleMatch = css.match(
      /\[data-theme='light'\]\s*\.sdna-overlay\s*\{([^}]+)\}/
    );
    const block = ruleMatch[1];
    expect(block).toContain("--border: rgba(255,255,255,0.08)");
  });

  it(".sdna-overlay has a black background (#000)", () => {
    // The base .sdna-overlay must have background: #000
    const baseMatch = css.match(/\.sdna-overlay\s*\{([^}]+)\}/);
    expect(baseMatch).not.toBeNull();
    expect(baseMatch[1]).toContain("background: #000");
  });
});
