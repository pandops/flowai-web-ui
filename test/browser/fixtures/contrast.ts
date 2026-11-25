import type { Locator } from "@playwright/test";

// WCAG relative luminance, applied to browser-computed flat sRGB colors:
// https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
// Transparent layers are composed before measuring; unsupported visual effects
// fail explicitly instead of silently treating an unknown background as white.
export async function contrast(
  locator: Locator,
  paint: "color" | "borderTopColor" = "color",
) {
  return locator.evaluate((element, paint) => {
    type RGB = [number, number, number];
    type RGBA = [number, number, number, number];
    const parse = (value: string): RGBA => {
      const match = /^rgba?\(([^)]+)\)$/.exec(value);
      if (!match) throw new Error(`Contrast oracle cannot resolve ${value}`);
      const values = match[1]
        .split(/[,\s/]+/)
        .filter(Boolean)
        .map(Number);
      if (
        ![3, 4].includes(values.length) ||
        values.some((value) => !Number.isFinite(value))
      )
        throw new Error(`Invalid computed color ${value}`);
      return [values[0], values[1], values[2], values[3] ?? 1];
    };
    const blend = (top: RGBA, bottom: RGB): RGB =>
      bottom.map(
        (value, index) => top[index] * top[3] + value * (1 - top[3]),
      ) as RGB;
    const background = (start: Element | null): RGB => {
      const layers: RGBA[] = [];
      let covered = false;
      for (let node = start; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (
          Number(style.opacity) !== 1 ||
          style.filter !== "none" ||
          style.mixBlendMode !== "normal" ||
          (!covered && style.backgroundImage !== "none")
        )
          throw new Error(
            "Contrast oracle requires flat backgrounds without opacity or filters",
          );
        if (!covered) {
          const color = parse(style.backgroundColor);
          layers.push(color);
          covered = color[3] === 1;
        }
      }
      return layers
        .reverse()
        .reduce((base, layer) => blend(layer, base), [255, 255, 255] as RGB);
    };
    const luminance = (color: RGB) =>
      color
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    const ratio = (foreground: RGB, background: RGB) => {
      const a = luminance(foreground),
        b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const style = getComputedStyle(element),
      inside = background(element);
    const foreground = parse(style[paint]);
    if (paint !== "color" && foreground[3] !== 1)
      throw new Error("Contrast oracle requires opaque border paints");
    const internal = ratio(blend(foreground, inside), inside);
    const outside = background(element.parentElement);
    return {
      ratio:
        paint === "color"
          ? internal
          : // A boundary can be identified against either adjacent surface.
            Math.max(internal, ratio(blend(foreground, outside), outside)),
      foreground: style[paint],
      fontSize: parseFloat(style.fontSize),
      fontWeight: Number(style.fontWeight),
      background: inside,
      outside,
      borderStyle: style.borderTopStyle,
      borderWidth: parseFloat(style.borderTopWidth),
    };
  }, paint);
}
