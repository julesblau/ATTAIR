/**
 * Category-aware size formatting for product search queries.
 * Different garment categories use different sizing systems.
 */

export const SIZE_CATEGORIES = {
  // Headwear: S/M/L or fitted sizes
  hat: { type: "letter_fitted", sizes: ["S", "M", "L", "XL", "One Size", "Fitted"] },
  cap: { type: "letter_fitted", sizes: ["S/M", "M/L", "L/XL", "One Size", "Fitted"] },
  beanie: { type: "one_size", sizes: ["One Size"] },

  // Shoes: numeric sizes
  shoes: { type: "numeric", men: { min: 7, max: 14, step: 0.5 }, women: { min: 5, max: 12, step: 0.5 } },
  sneakers: { type: "numeric", men: { min: 7, max: 14, step: 0.5 }, women: { min: 5, max: 12, step: 0.5 } },
  boots: { type: "numeric", men: { min: 7, max: 14, step: 0.5 }, women: { min: 5, max: 12, step: 0.5 } },
  sandals: { type: "numeric", men: { min: 7, max: 14, step: 0.5 }, women: { min: 5, max: 12, step: 0.5 } },

  // Pants: waist/length
  pants: { type: "waist_length", waist: { min: 26, max: 44 }, length: { min: 28, max: 36 } },
  jeans: { type: "waist_length", waist: { min: 26, max: 44 }, length: { min: 28, max: 36 } },
  trousers: { type: "waist_length", waist: { min: 26, max: 44 }, length: { min: 28, max: 36 } },
  shorts: { type: "waist_or_letter", waist: { min: 26, max: 44 }, letters: ["XS", "S", "M", "L", "XL", "XXL"] },

  // Tops: letter sizes
  "t-shirt": { type: "letter", sizes: ["XS", "S", "M", "L", "XL", "XXL", "3XL"] },
  shirt: { type: "letter", sizes: ["XS", "S", "M", "L", "XL", "XXL", "3XL"] },
  hoodie: { type: "letter", sizes: ["XS", "S", "M", "L", "XL", "XXL", "3XL"] },
  sweater: { type: "letter", sizes: ["XS", "S", "M", "L", "XL", "XXL", "3XL"] },
  jacket: { type: "letter", sizes: ["XS", "S", "M", "L", "XL", "XXL", "3XL"] },
  blazer: { type: "letter_numeric", sizes: ["XS", "S", "M", "L", "XL", "XXL"], numeric: { min: 34, max: 52 } },
  coat: { type: "letter", sizes: ["XS", "S", "M", "L", "XL", "XXL", "3XL"] },

  // Dresses: numeric sizes
  dress: { type: "dress_numeric", sizes: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20] },
  skirt: { type: "dress_numeric", sizes: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20] },
};

/**
 * Format a size query string appropriate for the garment category.
 * @param {string} subcategory - e.g., "jeans", "sneakers", "hoodie"
 * @param {object} userSizes - user's saved size preferences
 * @param {string} gender - "male" or "female"
 * @returns {string} size query fragment, e.g., "size 32x30" or "size M" or ""
 */
export function formatSizeQuery(subcategory, userSizes = {}, gender = "male") {
  const cat = SIZE_CATEGORIES[subcategory?.toLowerCase()];
  if (!cat) return "";

  switch (cat.type) {
    case "numeric": {
      const sizeKey = gender === "female" ? "shoe_size_women" : "shoe_size_men";
      const size = userSizes[sizeKey] || userSizes.shoe_size;
      return size ? `size ${size}` : "";
    }
    case "waist_length": {
      const waist = userSizes.waist;
      const length = userSizes.inseam || userSizes.length;
      if (waist && length) return `size ${waist}x${length}`;
      if (waist) return `size ${waist}`;
      return "";
    }
    case "letter":
    case "letter_fitted": {
      const size = userSizes.top_size || userSizes.size;
      return size ? `size ${size}` : "";
    }
    case "dress_numeric": {
      const size = userSizes.dress_size;
      return size ? `size ${size}` : "";
    }
    case "one_size":
      return "";
    default:
      return userSizes.size ? `size ${userSizes.size}` : "";
  }
}
