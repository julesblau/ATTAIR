/**
 * aiContentLibrary.js — Expanded curated outfit content for 20 AI style accounts.
 *
 * Each account has 6-8 outfit templates for weeks of varied content.
 * Item format matches ATTAIR scan output: { category, subcategory, brand, color, material, confidence }
 */

function item(category, subcategory, brand, color, material, confidence = 0.88) {
  return { category, subcategory, brand: brand || "Unidentified", color, material, confidence };
}

export const CONTENT_LIBRARY = {
  "Street Style Daily": [
    {
      summary: "Downtown NYC layered look — oversized blazer over a graphic tee with wide-leg jeans and chunky sneakers",
      detected_gender: "women",
      items: [
        item("Outerwear", "Oversized Blazer", "Zara", "charcoal", "wool blend", 0.92),
        item("Top", "Graphic Tee", null, "white", "cotton", 0.88),
        item("Bottom", "Wide-Leg Jeans", "Agolde", "light wash", "denim", 0.85),
        item("Shoes", "Chunky Sneakers", "New Balance", "cream", "leather/mesh", 0.90),
      ],
    },
    {
      summary: "London street style — trench coat, turtleneck, pleated skirt, and knee-high boots",
      detected_gender: "women",
      items: [
        item("Outerwear", "Trench Coat", "Burberry", "beige", "gabardine", 0.94),
        item("Top", "Turtleneck Sweater", "COS", "black", "merino wool", 0.87),
        item("Bottom", "Pleated Midi Skirt", null, "navy", "polyester", 0.83),
        item("Shoes", "Knee-High Boots", "Stuart Weitzman", "black", "leather", 0.91),
      ],
    },
    {
      summary: "Tokyo street style — oversized denim jacket, cropped hoodie, cargo pants, and platform sneakers",
      detected_gender: "women",
      items: [
        item("Outerwear", "Denim Jacket", "Levi's", "medium wash", "denim", 0.89),
        item("Top", "Cropped Hoodie", "Nike", "sage green", "cotton blend", 0.86),
        item("Bottom", "Cargo Pants", null, "khaki", "cotton", 0.84),
        item("Shoes", "Platform Sneakers", "Converse", "white", "canvas", 0.92),
      ],
    },
    {
      summary: "Berlin minimal streetwear — leather jacket, white tank, straight-leg trousers, and loafers",
      detected_gender: "women",
      items: [
        item("Outerwear", "Leather Jacket", "AllSaints", "black", "leather", 0.93),
        item("Top", "Tank Top", null, "white", "cotton", 0.85),
        item("Bottom", "Straight-Leg Trousers", "COS", "black", "wool blend", 0.87),
        item("Shoes", "Loafers", "G.H. Bass", "burgundy", "leather", 0.90),
      ],
    },
    {
      summary: "Brooklyn brunch — oversized cardigan, slip dress, and lug sole boots",
      detected_gender: "women",
      items: [
        item("Top", "Oversized Cardigan", "Free People", "oatmeal", "knit", 0.86),
        item("Dress", "Slip Dress", "Realisation Par", "black", "silk", 0.89),
        item("Shoes", "Lug Sole Boots", "Bottega Veneta", "brown", "leather", 0.91),
      ],
    },
    {
      summary: "SoHo afternoon — cropped hoodie, biker shorts, oversized sunglasses, and colorblock sneakers",
      detected_gender: "women",
      items: [
        item("Top", "Cropped Hoodie", "Nike", "black", "cotton blend", 0.87),
        item("Bottom", "Biker Shorts", "Girlfriend Collective", "black", "recycled fabric", 0.85),
        item("Accessory", "Oversized Sunglasses", "Celine", "tortoise", "acetate", 0.88),
        item("Shoes", "Colorblock Sneakers", "Veja", "white/emerald", "organic cotton", 0.90),
      ],
    },
    {
      summary: "Rainy day gorpcore — rain jacket, fleece vest, track pants, and trail sneakers",
      detected_gender: "women",
      items: [
        item("Outerwear", "Rain Jacket", "Arc'teryx", "sage green", "gore-tex", 0.91),
        item("Outerwear", "Fleece Vest", "Patagonia", "cream", "recycled fleece", 0.88),
        item("Bottom", "Track Pants", "Adidas", "black", "polyester", 0.86),
        item("Shoes", "Trail Sneakers", "Salomon", "grey/blue", "mesh", 0.90),
      ],
    },
    {
      summary: "Fashion week street style — power shoulders, wide legs, and pointed mules",
      detected_gender: "women",
      items: [
        item("Outerwear", "Structured Blazer", "The Frankie Shop", "black", "wool", 0.92),
        item("Bottom", "Pleated Trousers", "COS", "charcoal", "wool blend", 0.88),
        item("Top", "Silk Camisole", "Vince", "ivory", "silk", 0.87),
        item("Shoes", "Pointed Mules", "By Far", "black", "leather", 0.89),
      ],
    },
  ],

  "Luxury Finds": [
    {
      summary: "Resort ready — silk wrap dress with strappy heels and a structured clutch",
      detected_gender: "women",
      items: [
        item("Dress", "Silk Wrap Dress", "Diane von Furstenberg", "emerald green", "silk", 0.95),
        item("Shoes", "Strappy Heels", "Jimmy Choo", "gold", "metallic leather", 0.91),
        item("Accessory", "Structured Clutch", "Bottega Veneta", "cream", "intrecciato leather", 0.88),
      ],
    },
    {
      summary: "Power suit moment — double-breasted blazer set with pointed-toe pumps",
      detected_gender: "women",
      items: [
        item("Outerwear", "Double-Breasted Blazer", "Saint Laurent", "black", "wool", 0.93),
        item("Bottom", "Tailored Trousers", "Saint Laurent", "black", "wool", 0.92),
        item("Shoes", "Pointed-Toe Pumps", "Manolo Blahnik", "nude", "patent leather", 0.90),
      ],
    },
    {
      summary: "Quiet luxury perfection — cashmere coat, cream sweater, tailored trousers, and leather loafers",
      detected_gender: "women",
      items: [
        item("Outerwear", "Cashmere Coat", "Max Mara", "camel", "cashmere", 0.94),
        item("Top", "Cashmere Sweater", "Loro Piana", "cream", "cashmere", 0.92),
        item("Bottom", "Tailored Trousers", "The Row", "beige", "wool", 0.90),
        item("Shoes", "Leather Loafers", "Brunello Cucinelli", "brown", "suede", 0.89),
      ],
    },
    {
      summary: "Investment pieces — classic Chanel tweed with jeans and ballet flats",
      detected_gender: "women",
      items: [
        item("Outerwear", "Tweed Jacket", "Chanel", "pink/white", "tweed", 0.95),
        item("Bottom", "Straight Leg Jeans", "Agolde", "dark wash", "denim", 0.87),
        item("Shoes", "Ballet Flats", "Chanel", "black/beige", "leather", 0.93),
        item("Accessory", "Quilted Bag", "Chanel", "black", "lambskin", 0.94),
      ],
    },
    {
      summary: "Airport luxury — blazer, wide trousers, clean sneakers, and a Celine tote",
      detected_gender: "women",
      items: [
        item("Outerwear", "Oversized Blazer", "The Row", "navy", "wool", 0.91),
        item("Bottom", "Wide Leg Trousers", "Toteme", "black", "wool blend", 0.89),
        item("Shoes", "Leather Sneakers", "Common Projects", "white", "leather", 0.92),
        item("Accessory", "Leather Tote", "Celine", "tan", "calfskin", 0.90),
      ],
    },
    {
      summary: "Date night — Saint Laurent mini dress with Amina Muaddi boots",
      detected_gender: "women",
      items: [
        item("Dress", "Bodycon Mini Dress", "Saint Laurent", "black", "jersey", 0.93),
        item("Shoes", "Stiletto Boots", "Amina Muaddi", "black", "leather", 0.91),
        item("Accessory", "Mini Bag", "Jacquemus", "white", "leather", 0.88),
      ],
    },
    {
      summary: "Garden party — floral Zimmermann midi with woven sandals and a Loewe basket bag",
      detected_gender: "women",
      items: [
        item("Dress", "Floral Midi Dress", "Zimmermann", "pink floral", "linen", 0.94),
        item("Shoes", "Woven Sandals", "Gianvito Rossi", "natural", "leather", 0.88),
        item("Accessory", "Basket Bag", "Loewe", "natural/tan", "raffia/leather", 0.90),
      ],
    },
  ],

  "Vintage Vibes": [
    {
      summary: "70s revival — flared jeans, crochet vest, platform boots, and round sunglasses",
      detected_gender: "women",
      items: [
        item("Bottom", "Flared Jeans", "Free People", "dark wash", "denim", 0.88),
        item("Top", "Crochet Vest", null, "cream", "cotton crochet", 0.82),
        item("Shoes", "Platform Boots", "Dr. Martens", "brown", "leather", 0.90),
        item("Accessory", "Round Sunglasses", "Ray-Ban", "gold/brown", "metal", 0.86),
      ],
    },
    {
      summary: "Thrift haul look — vintage band tee tucked into mom jeans with Converse and a corduroy jacket",
      detected_gender: "women",
      items: [
        item("Top", "Vintage Band Tee", null, "faded black", "cotton", 0.80),
        item("Bottom", "Mom Jeans", "Levi's", "medium wash", "denim", 0.87),
        item("Outerwear", "Corduroy Jacket", null, "camel", "corduroy", 0.84),
        item("Shoes", "High-Top Sneakers", "Converse", "off-white", "canvas", 0.91),
      ],
    },
    {
      summary: "90s grunge — flannel shirt, ripped jeans, band tee, and Doc Martens",
      detected_gender: "women",
      items: [
        item("Outerwear", "Flannel Shirt", null, "red plaid", "cotton", 0.83),
        item("Bottom", "Mom Jeans", "Levi's", "light wash", "denim", 0.87),
        item("Top", "Band Tee", null, "black", "cotton", 0.81),
        item("Shoes", "Combat Boots", "Dr. Martens", "black", "leather", 0.92),
      ],
    },
    {
      summary: "Grandma's closet but fashion — vintage silk scarf, cashmere cardigan, pleated skirt, and Mary Janes",
      detected_gender: "women",
      items: [
        item("Accessory", "Silk Scarf", "Hermes", "multi-color", "silk", 0.90),
        item("Top", "Cardigan", null, "cream", "cashmere", 0.85),
        item("Bottom", "Pleated Skirt", null, "navy", "wool", 0.83),
        item("Shoes", "Mary Janes", null, "black", "patent leather", 0.87),
      ],
    },
    {
      summary: "Mixing decades — 70s leather vest with 90s baggy jeans and platform Converse",
      detected_gender: "women",
      items: [
        item("Outerwear", "Leather Vest", null, "brown", "leather", 0.84),
        item("Bottom", "Baggy Jeans", "Levi's 501", "light wash", "denim", 0.88),
        item("Top", "Ribbed Tank", "Hanes", "white", "cotton", 0.82),
        item("Shoes", "Platform Sneakers", "Converse", "black", "canvas", 0.90),
      ],
    },
    {
      summary: "Retro 80s sportswear — vintage Adidas track suit with Reebok sneakers",
      detected_gender: "women",
      items: [
        item("Outerwear", "Track Jacket", "Adidas", "blue/white", "polyester", 0.87),
        item("Bottom", "Track Pants", "Adidas", "blue/white", "polyester", 0.86),
        item("Shoes", "Retro Sneakers", "Reebok", "white/red", "leather", 0.89),
      ],
    },
    {
      summary: "Vintage Levi's trucker jacket with a silk slip dress and cowboy boots",
      detected_gender: "women",
      items: [
        item("Outerwear", "Trucker Jacket", "Levi's", "faded blue", "denim", 0.90),
        item("Dress", "Slip Dress", null, "black", "silk", 0.86),
        item("Shoes", "Cowboy Boots", null, "brown", "leather", 0.88),
      ],
    },
  ],

  "Minimal Wardrobe": [
    {
      summary: "Capsule wardrobe perfection — cashmere crew, tailored trousers, and minimal leather sandals",
      detected_gender: "women",
      items: [
        item("Top", "Cashmere Crewneck", "Everlane", "oatmeal", "cashmere", 0.91),
        item("Bottom", "Tailored Wide-Leg Trousers", "COS", "black", "cotton blend", 0.89),
        item("Shoes", "Leather Sandals", "The Row", "tan", "leather", 0.87),
      ],
    },
    {
      summary: "10-piece capsule proof — wool coat, turtleneck, straight trousers, and leather loafers",
      detected_gender: "women",
      items: [
        item("Outerwear", "Wool Coat", "COS", "camel", "wool", 0.92),
        item("Top", "Turtleneck", "Uniqlo", "black", "merino wool", 0.89),
        item("Bottom", "Straight Trousers", "Arket", "black", "cotton blend", 0.87),
        item("Shoes", "Leather Loafers", "Everlane", "black", "leather", 0.88),
      ],
    },
    {
      summary: "The perfect white shirt — tucked into tailored shorts with leather sandals",
      detected_gender: "women",
      items: [
        item("Top", "White Oxford Shirt", "COS", "white", "cotton", 0.90),
        item("Bottom", "Tailored Shorts", "Arket", "beige", "cotton", 0.86),
        item("Shoes", "Leather Sandals", "Ancient Greek Sandals", "tan", "leather", 0.88),
      ],
    },
    {
      summary: "Scandinavian minimalism — blazer, high-waist trousers, ribbed knit, and ankle boots",
      detected_gender: "women",
      items: [
        item("Outerwear", "Oversized Blazer", "COS", "grey", "wool blend", 0.90),
        item("Bottom", "High-Waist Trousers", "Filippa K", "black", "wool blend", 0.88),
        item("Top", "Ribbed Knit", "COS", "cream", "cotton", 0.87),
        item("Shoes", "Ankle Boots", "Acne Studios", "black", "leather", 0.91),
      ],
    },
    {
      summary: "Monochrome power — all white linen head to toe",
      detected_gender: "women",
      items: [
        item("Top", "Linen Shirt", "Everlane", "white", "linen", 0.89),
        item("Bottom", "Linen Pants", "Everlane", "white", "linen", 0.88),
        item("Shoes", "Leather Slides", "Common Projects", "white", "leather", 0.90),
      ],
    },
    {
      summary: "Only 3 pieces needed — wool blazer, dark jeans, and leather loafers",
      detected_gender: "women",
      items: [
        item("Outerwear", "Wool Blazer", "Toteme", "charcoal", "wool", 0.91),
        item("Bottom", "Straight Leg Jeans", "Agolde", "dark wash", "denim", 0.88),
        item("Shoes", "Leather Loafers", "The Row", "black", "leather", 0.90),
      ],
    },
    {
      summary: "Weekend uniform — chunky knit sweater with straight jeans and suede sneakers",
      detected_gender: "women",
      items: [
        item("Top", "Chunky Knit Sweater", "Jenni Kayne", "oatmeal", "wool", 0.89),
        item("Bottom", "Straight Jeans", "Citizens of Humanity", "vintage blue", "denim", 0.87),
        item("Shoes", "Suede Sneakers", "Veja", "beige", "suede", 0.88),
      ],
    },
  ],

  "Date Night Looks": [
    {
      summary: "Dinner date — satin midi dress, strappy heels, and delicate gold jewelry",
      detected_gender: "women",
      items: [
        item("Dress", "Satin Midi Dress", "Reformation", "burgundy", "satin", 0.92),
        item("Shoes", "Strappy Heels", "Steve Madden", "black", "suede", 0.88),
        item("Accessory", "Gold Chain Necklace", "Mejuri", "gold", "14k gold", 0.85),
      ],
    },
    {
      summary: "First date confidence — fitted red dress with statement earrings",
      detected_gender: "women",
      items: [
        item("Dress", "Bodycon Midi Dress", "Reformation", "red", "ponte", 0.91),
        item("Shoes", "Strappy Heels", "Stuart Weitzman", "nude", "leather", 0.89),
        item("Accessory", "Statement Earrings", "Baublebar", "gold", "plated brass", 0.84),
      ],
    },
    {
      summary: "Cocktail bar energy — silk camisole with leather pants and pointed pumps",
      detected_gender: "women",
      items: [
        item("Top", "Silk Camisole", "Cami NYC", "black", "silk", 0.90),
        item("Bottom", "Leather Pants", "Agolde", "black", "faux leather", 0.88),
        item("Shoes", "Pointed Pumps", "Sam Edelman", "black", "suede", 0.87),
        item("Accessory", "Mini Bag", "Mansur Gavriel", "brown", "leather", 0.86),
      ],
    },
    {
      summary: "Rooftop drinks — floral wrap dress with block heels and a woven bag",
      detected_gender: "women",
      items: [
        item("Dress", "Wrap Dress", "Diane von Furstenberg", "floral print", "silk jersey", 0.91),
        item("Shoes", "Block Heels", "Marc Fisher", "tan", "leather", 0.87),
        item("Accessory", "Woven Bag", "Cult Gaia", "natural", "rattan", 0.85),
      ],
    },
    {
      summary: "Anniversary dinner — navy satin dress with gold sandals and pearls",
      detected_gender: "women",
      items: [
        item("Dress", "Satin Midi Dress", "Reformation", "navy", "satin", 0.92),
        item("Shoes", "Strappy Sandals", "Aquazzura", "gold", "metallic leather", 0.90),
        item("Accessory", "Pearl Necklace", "Mejuri", "pearl", "freshwater pearl", 0.86),
      ],
    },
    {
      summary: "Late night tapas — off-shoulder top with satin midi skirt and mule heels",
      detected_gender: "women",
      items: [
        item("Top", "Off-Shoulder Top", "Reformation", "white", "cotton", 0.87),
        item("Bottom", "Satin Midi Skirt", "Vince", "olive", "satin", 0.89),
        item("Shoes", "Mule Heels", "By Far", "black", "leather", 0.88),
        item("Accessory", "Hoop Earrings", "Mejuri", "gold", "14k gold vermeil", 0.85),
      ],
    },
  ],

  "Athleisure Edit": [
    {
      summary: "Gym to coffee run — matching set, clean sneakers, and oversized sunglasses",
      detected_gender: "women",
      items: [
        item("Top", "Sports Bra Tank", "Lululemon", "sage", "nulu fabric", 0.90),
        item("Bottom", "High-Rise Leggings", "Lululemon", "sage", "nulu fabric", 0.91),
        item("Shoes", "Running Sneakers", "On Running", "white/sand", "mesh", 0.89),
      ],
    },
    {
      summary: "Pilates princess — monochrome white set with platform sneakers and a cap",
      detected_gender: "women",
      items: [
        item("Top", "Crop Tank", "Lululemon", "white", "everlux", 0.89),
        item("Bottom", "Biker Shorts", "Lululemon", "white", "everlux", 0.88),
        item("Shoes", "Platform Sneakers", "Hoka", "white/cream", "mesh", 0.90),
        item("Accessory", "Baseball Cap", "Alo Yoga", "white", "cotton", 0.84),
      ],
    },
    {
      summary: "Hot girl walk fit — quarter zip, running shorts, and On Running sneakers",
      detected_gender: "women",
      items: [
        item("Top", "Quarter Zip", "Vuori", "grey", "performance knit", 0.88),
        item("Bottom", "Running Shorts", "Nike", "black", "dri-fit", 0.87),
        item("Shoes", "Running Sneakers", "On Running", "white/grey", "CloudTec", 0.91),
      ],
    },
    {
      summary: "Tennis core — pleated skirt, polo, and court sneakers",
      detected_gender: "women",
      items: [
        item("Bottom", "Pleated Tennis Skirt", "Alo Yoga", "white", "performance fabric", 0.88),
        item("Top", "Polo Shirt", "Lacoste", "white", "cotton pique", 0.90),
        item("Shoes", "Court Sneakers", "Nike", "white", "leather", 0.91),
        item("Accessory", "Visor", "Nike", "white", "dri-fit", 0.84),
      ],
    },
    {
      summary: "Airport athleisure — oversized hoodie, joggers, and cloud sneakers",
      detected_gender: "women",
      items: [
        item("Top", "Oversized Hoodie", "Alo Yoga", "espresso", "cotton blend", 0.89),
        item("Bottom", "Performance Joggers", "Vuori", "black", "stretch woven", 0.88),
        item("Shoes", "Cloud Sneakers", "On Running", "black/white", "CloudTec", 0.90),
      ],
    },
    {
      summary: "Hiking gorpcore — fleece jacket, cargo pants, and Salomon trail runners",
      detected_gender: "women",
      items: [
        item("Outerwear", "Fleece Jacket", "Patagonia", "cream", "recycled fleece", 0.90),
        item("Bottom", "Cargo Pants", "Gramicci", "olive", "cotton canvas", 0.87),
        item("Shoes", "Trail Runners", "Salomon", "purple/grey", "mesh/rubber", 0.91),
      ],
    },
  ],

  "Boho Chic": [
    {
      summary: "Festival ready — maxi dress with layered necklaces, ankle boots, and a fringe bag",
      detected_gender: "women",
      items: [
        item("Dress", "Floral Maxi Dress", "Free People", "rust/multi", "viscose", 0.88),
        item("Shoes", "Western Ankle Boots", "Isabel Marant", "tan", "suede", 0.86),
        item("Accessory", "Fringe Crossbody Bag", null, "brown", "leather", 0.83),
      ],
    },
    {
      summary: "Desert festival vibes — crochet dress, suede boots, and turquoise jewelry",
      detected_gender: "women",
      items: [
        item("Dress", "Crochet Maxi Dress", "Free People", "cream", "cotton crochet", 0.87),
        item("Shoes", "Suede Fringe Boots", "Isabel Marant", "tan", "suede", 0.88),
        item("Accessory", "Turquoise Necklace", null, "turquoise", "silver/turquoise", 0.83),
        item("Accessory", "Floppy Hat", "Lack of Color", "tan", "felt", 0.85),
      ],
    },
    {
      summary: "Sunday farmers market — linen midi dress with woven sandals and a straw bag",
      detected_gender: "women",
      items: [
        item("Dress", "Linen Midi Dress", "Faithfull the Brand", "terracotta", "linen", 0.89),
        item("Shoes", "Woven Sandals", "Ancient Greek Sandals", "tan", "leather", 0.87),
        item("Accessory", "Straw Bag", "Lack of Color", "natural", "straw", 0.84),
      ],
    },
    {
      summary: "Earth tones layered — knit poncho, flare jeans, suede boots, and layered gold necklaces",
      detected_gender: "women",
      items: [
        item("Outerwear", "Knit Poncho", "Free People", "rust", "wool blend", 0.85),
        item("Bottom", "Flare Jeans", "Mother", "dark wash", "denim", 0.88),
        item("Shoes", "Suede Ankle Boots", "Sam Edelman", "cognac", "suede", 0.87),
        item("Accessory", "Layered Necklaces", "Gorjana", "gold", "gold plated", 0.83),
      ],
    },
    {
      summary: "Coachella-ready — fringe vest, denim cutoffs, and cowboy boots",
      detected_gender: "women",
      items: [
        item("Outerwear", "Fringe Vest", "Free People", "brown", "suede", 0.85),
        item("Bottom", "Denim Shorts", "Agolde", "light wash", "denim", 0.87),
        item("Shoes", "Cowboy Boots", "Tecovas", "brown", "leather", 0.89),
      ],
    },
    {
      summary: "Beach bonfire — off-shoulder blouse with wide linen pants and leather sandals",
      detected_gender: "women",
      items: [
        item("Top", "Off-Shoulder Blouse", "Doen", "white", "cotton", 0.86),
        item("Bottom", "Wide Leg Linen Pants", "Faithfull the Brand", "natural", "linen", 0.88),
        item("Shoes", "Leather Thong Sandals", "Tkees", "brown", "leather", 0.87),
      ],
    },
  ],

  "Office Slay": [
    {
      summary: "Monday power move — structured blazer, silk blouse, pencil skirt, and pointed pumps",
      detected_gender: "women",
      items: [
        item("Outerwear", "Structured Blazer", "Theory", "navy", "wool blend", 0.93),
        item("Top", "Silk Blouse", "Equipment", "ivory", "silk", 0.90),
        item("Bottom", "Pencil Skirt", "Hugo Boss", "navy", "wool blend", 0.88),
        item("Shoes", "Pointed-Toe Pumps", "Stuart Weitzman", "black", "leather", 0.91),
      ],
    },
    {
      summary: "Board meeting energy — sharp navy suit with cashmere turtleneck",
      detected_gender: "women",
      items: [
        item("Outerwear", "Tailored Suit Jacket", "Theory", "navy", "wool", 0.92),
        item("Bottom", "Matching Trousers", "Theory", "navy", "wool", 0.91),
        item("Top", "Cashmere Turtleneck", "Everlane", "cream", "cashmere", 0.89),
        item("Shoes", "Pointed Pumps", "Stuart Weitzman", "black", "leather", 0.90),
      ],
    },
    {
      summary: "Friday at the office — blazer dress with white sneakers and a structured tote",
      detected_gender: "women",
      items: [
        item("Dress", "Blazer Dress", "Reiss", "camel", "wool blend", 0.89),
        item("Shoes", "White Sneakers", "Veja", "white", "organic cotton", 0.90),
        item("Accessory", "Structured Tote", "Polene", "black", "leather", 0.88),
      ],
    },
    {
      summary: "Red blazer is non-negotiable — power dressing 101",
      detected_gender: "women",
      items: [
        item("Outerwear", "Red Blazer", "Zara", "red", "polyester blend", 0.88),
        item("Bottom", "High-Waist Trousers", "Aritzia", "black", "crepe", 0.87),
        item("Top", "Silk Shell", "Vince", "white", "silk", 0.89),
        item("Shoes", "Slingback Heels", "Manolo Blahnik", "nude", "leather", 0.91),
      ],
    },
    {
      summary: "Creative office — printed blouse with checked trousers and leather loafers",
      detected_gender: "women",
      items: [
        item("Top", "Printed Blouse", "Sandro", "blue floral", "silk blend", 0.87),
        item("Bottom", "Checked Trousers", "Maje", "grey check", "wool blend", 0.86),
        item("Shoes", "Loafers", "Sam Edelman", "brown", "leather", 0.88),
        item("Accessory", "Leather Satchel", "Coach", "brown", "leather", 0.87),
      ],
    },
    {
      summary: "All-black everything — the NYC work uniform that never fails",
      detected_gender: "women",
      items: [
        item("Outerwear", "Black Blazer", "COS", "black", "wool blend", 0.90),
        item("Bottom", "Black Trousers", "Theory", "black", "wool", 0.89),
        item("Top", "Black Turtleneck", "Uniqlo", "black", "merino wool", 0.87),
        item("Shoes", "Black Ankle Boots", "Acne Studios", "black", "leather", 0.91),
      ],
    },
  ],

  "Y2K Revival": [
    {
      summary: "Early 2000s energy — low-rise cargo pants, baby tee, platform sandals, and mini bag",
      detected_gender: "women",
      items: [
        item("Bottom", "Low-Rise Cargo Pants", "Urban Outfitters", "olive", "cotton", 0.85),
        item("Top", "Baby Tee", null, "pink", "cotton", 0.83),
        item("Shoes", "Platform Sandals", "Steve Madden", "white", "synthetic", 0.87),
        item("Accessory", "Mini Shoulder Bag", null, "silver", "metallic", 0.80),
      ],
    },
    {
      summary: "Paris Hilton era — rhinestone tank, low-rise mini, and platform flip flops",
      detected_gender: "women",
      items: [
        item("Top", "Rhinestone Tank", "Juicy Couture", "pink", "cotton blend", 0.84),
        item("Bottom", "Low Rise Mini Skirt", "IAMGIA", "denim", "denim", 0.83),
        item("Shoes", "Platform Flip Flops", "Steve Madden", "clear", "PVC", 0.82),
        item("Accessory", "Micro Bag", "Juicy Couture", "pink", "terry cloth", 0.80),
      ],
    },
    {
      summary: "Velour tracksuit era — Juicy is officially back",
      detected_gender: "women",
      items: [
        item("Top", "Velour Hoodie", "Juicy Couture", "hot pink", "velour", 0.87),
        item("Bottom", "Velour Pants", "Juicy Couture", "hot pink", "velour", 0.86),
        item("Shoes", "Platform Sneakers", "Skechers", "white", "leather", 0.85),
      ],
    },
    {
      summary: "TikTok viral — baby tee and baggy JNCO jeans with platform New Balance",
      detected_gender: "women",
      items: [
        item("Top", "Baby Tee", "Brandy Melville", "white", "cotton", 0.83),
        item("Bottom", "Baggy Jeans", "JNCO", "light wash", "denim", 0.85),
        item("Shoes", "Platform Sneakers", "New Balance", "grey", "mesh/suede", 0.88),
        item("Accessory", "Tinted Sunglasses", "Le Specs", "pink", "acetate", 0.82),
      ],
    },
    {
      summary: "Mesh top and sparkle everything — Y2K going out look",
      detected_gender: "women",
      items: [
        item("Top", "Mesh Top", "IAMGIA", "black", "mesh", 0.84),
        item("Bottom", "Mini Skirt", "Miaou", "silver", "metallic", 0.83),
        item("Shoes", "Strappy Heels", "Simmi London", "silver", "metallic", 0.85),
        item("Accessory", "Mini Shoulder Bag", "Prada", "black", "nylon", 0.88),
      ],
    },
    {
      summary: "Britney circa 2001 — cropped cardigan with low-rise cargos and Buffalo platforms",
      detected_gender: "women",
      items: [
        item("Top", "Cropped Cardigan", "Urban Outfitters", "baby blue", "knit", 0.84),
        item("Bottom", "Low Rise Cargo Pants", "IAMGIA", "khaki", "cotton", 0.83),
        item("Shoes", "Platform Boots", "Buffalo London", "black", "synthetic", 0.86),
      ],
    },
  ],

  "Coastal Aesthetic": [
    {
      summary: "Quiet luxury beach-to-dinner — linen set, leather sandals, and woven tote",
      detected_gender: "women",
      items: [
        item("Top", "Linen Button-Down Shirt", "Loro Piana", "white", "linen", 0.90),
        item("Bottom", "Linen Wide-Leg Pants", "Loro Piana", "sand", "linen", 0.89),
        item("Shoes", "Flat Leather Sandals", "Ancient Greek Sandals", "natural", "leather", 0.87),
        item("Accessory", "Woven Tote Bag", "Dragon Diffusion", "tan", "woven leather", 0.85),
      ],
    },
    {
      summary: "Seaside morning — all linen everything with a straw hat",
      detected_gender: "women",
      items: [
        item("Top", "Linen Shirt", "James Perse", "white", "linen", 0.89),
        item("Bottom", "Linen Shorts", "Jenni Kayne", "natural", "linen", 0.87),
        item("Shoes", "Leather Sandals", "Tkees", "tan", "leather", 0.88),
        item("Accessory", "Straw Hat", "Janessa Leone", "natural", "straw", 0.85),
      ],
    },
    {
      summary: "Yacht club energy — navy stripes, white jeans, and espadrilles",
      detected_gender: "women",
      items: [
        item("Top", "Breton Stripe Top", "Saint James", "navy/white", "cotton jersey", 0.90),
        item("Bottom", "White Jeans", "Frame", "white", "denim", 0.88),
        item("Shoes", "Espadrilles", "Soludos", "natural", "canvas/jute", 0.87),
      ],
    },
    {
      summary: "Mediterranean vacation — effortless floral wrap dress with woven sandals",
      detected_gender: "women",
      items: [
        item("Dress", "Wrap Dress", "Faithfull the Brand", "blue floral", "linen", 0.90),
        item("Shoes", "Woven Sandals", "Ancient Greek Sandals", "gold", "leather", 0.88),
        item("Accessory", "Straw Clutch", "Cult Gaia", "natural", "rattan", 0.85),
      ],
    },
    {
      summary: "Coastal grandmother approved — cable knit cashmere with pearls and loafers",
      detected_gender: "women",
      items: [
        item("Top", "Cable Knit Sweater", "Jenni Kayne", "cream", "cashmere", 0.91),
        item("Bottom", "Wide Leg Chinos", "Nili Lotan", "khaki", "cotton", 0.87),
        item("Shoes", "Leather Loafers", "Gucci", "brown", "leather", 0.90),
        item("Accessory", "Pearl Earrings", "Mejuri", "pearl", "freshwater pearl", 0.86),
      ],
    },
    {
      summary: "Beach to dinner — throw on a linen blazer over a slip dress",
      detected_gender: "women",
      items: [
        item("Outerwear", "Linen Blazer", "Reformation", "ecru", "linen", 0.88),
        item("Dress", "Slip Dress", "Vince", "sand", "silk", 0.90),
        item("Shoes", "Flat Sandals", "The Row", "tan", "leather", 0.89),
      ],
    },
  ],

  "Drip Check": [
    {
      summary: "Heat check — Jordan 4s, oversized vintage hoodie, stacked jeans, and a fitted cap",
      detected_gender: "men",
      items: [
        item("Shoes", "Retro Sneakers", "Jordan", "military black", "leather/nubuck", 0.95),
        item("Top", "Oversized Hoodie", "Essentials", "dark oatmeal", "cotton blend", 0.90),
        item("Bottom", "Stacked Jeans", "Amiri", "washed black", "denim", 0.88),
        item("Accessory", "Fitted Cap", "New Era", "black", "wool blend", 0.86),
      ],
    },
    {
      summary: "Tech fleece fit — full Nike set with Air Max 90s and a crossbody bag",
      detected_gender: "men",
      items: [
        item("Top", "Tech Fleece Hoodie", "Nike", "dark grey heather", "tech fleece", 0.93),
        item("Bottom", "Tech Fleece Joggers", "Nike", "dark grey heather", "tech fleece", 0.92),
        item("Shoes", "Air Max 90", "Nike", "white/black", "leather/mesh", 0.94),
        item("Accessory", "Crossbody Bag", "Nike", "black", "nylon", 0.85),
      ],
    },
    {
      summary: "All white Air Force 1s — the only shoe that matters",
      detected_gender: "men",
      items: [
        item("Top", "Oversized Tee", "Essentials", "white", "cotton", 0.88),
        item("Bottom", "Baggy Jeans", "Carhartt WIP", "medium wash", "denim", 0.86),
        item("Shoes", "Air Force 1", "Nike", "white", "leather", 0.95),
        item("Accessory", "Chain Necklace", "Vitaly", "silver", "stainless steel", 0.83),
      ],
    },
    {
      summary: "Essentials fit — Fear of God monochrome head to toe",
      detected_gender: "men",
      items: [
        item("Top", "Essentials Hoodie", "Fear of God", "taupe", "cotton blend", 0.91),
        item("Bottom", "Essentials Sweatpants", "Fear of God", "taupe", "cotton blend", 0.90),
        item("Shoes", "Yeezy Slides", "Adidas", "bone", "EVA foam", 0.89),
      ],
    },
    {
      summary: "Jordan 1 outfit of the day — built around the Chicago colorway",
      detected_gender: "men",
      items: [
        item("Top", "Vintage Tee", "Nike", "black", "cotton", 0.86),
        item("Bottom", "Slim Cargo Pants", "Represent", "black", "cotton", 0.87),
        item("Shoes", "Air Jordan 1 High", "Nike", "chicago red/white/black", "leather", 0.96),
        item("Accessory", "Crossbody Bag", "Nike", "black", "nylon", 0.84),
      ],
    },
    {
      summary: "Winter layers — North Face puffer with Nike hoodie and Jordan 4s",
      detected_gender: "men",
      items: [
        item("Outerwear", "Puffer Jacket", "The North Face", "black", "nylon/down", 0.92),
        item("Top", "Hoodie", "Nike", "grey", "cotton blend", 0.89),
        item("Bottom", "Cargo Joggers", "Nike", "black", "tech fleece", 0.88),
        item("Shoes", "Air Jordan 4", "Nike", "black/red", "leather/mesh", 0.94),
      ],
    },
    {
      summary: "Japanese streetwear — BAPE camo with New Balance 550s",
      detected_gender: "men",
      items: [
        item("Top", "Camo Hoodie", "BAPE", "green camo", "cotton", 0.88),
        item("Bottom", "Black Denim", "Neighborhood", "black", "denim", 0.86),
        item("Shoes", "550 Sneakers", "New Balance", "white/green", "leather", 0.90),
        item("Accessory", "Shoulder Bag", "Porter", "black", "nylon", 0.85),
      ],
    },
    {
      summary: "Skate shop vibes — Palace tee with Dickies and Vans Old Skool",
      detected_gender: "men",
      items: [
        item("Top", "Graphic Tee", "Palace", "white", "cotton", 0.86),
        item("Bottom", "Corduroy Pants", "Dickies", "brown", "corduroy", 0.85),
        item("Shoes", "Old Skool", "Vans", "black/white", "canvas/suede", 0.91),
        item("Accessory", "Beanie", "Stussy", "black", "acrylic", 0.83),
      ],
    },
  ],

  "Classic Menswear": [
    {
      summary: "Italian-inspired — navy blazer, white OCBD, grey wool trousers, and suede loafers",
      detected_gender: "men",
      items: [
        item("Outerwear", "Navy Blazer", "Ralph Lauren", "navy", "wool", 0.94),
        item("Top", "Oxford Button-Down Shirt", "Brooks Brothers", "white", "cotton oxford", 0.91),
        item("Bottom", "Wool Trousers", "Incotex", "medium grey", "wool", 0.89),
        item("Shoes", "Suede Loafers", "Alden", "tobacco", "suede", 0.88),
      ],
    },
    {
      summary: "The perfect navy suit — timeless investment from SuitSupply",
      detected_gender: "men",
      items: [
        item("Outerwear", "Navy Suit Jacket", "SuitSupply", "navy", "super 110s wool", 0.93),
        item("Bottom", "Suit Trousers", "SuitSupply", "navy", "super 110s wool", 0.92),
        item("Top", "White Dress Shirt", "Charles Tyrwhitt", "white", "cotton", 0.90),
        item("Shoes", "Oxford Shoes", "Allen Edmonds", "brown", "calfskin", 0.91),
        item("Accessory", "Silk Tie", "Drake's", "burgundy", "silk", 0.87),
      ],
    },
    {
      summary: "Smart casual mastered — sport coat with jeans and suede loafers",
      detected_gender: "men",
      items: [
        item("Outerwear", "Sport Coat", "Todd Snyder", "grey", "wool", 0.91),
        item("Bottom", "Selvedge Denim", "A.P.C.", "indigo", "japanese denim", 0.89),
        item("Top", "OCBD Shirt", "Brooks Brothers", "light blue", "oxford cotton", 0.90),
        item("Shoes", "Suede Loafers", "Alden", "brown", "suede", 0.88),
      ],
    },
    {
      summary: "Heritage workwear — Barbour waxed jacket, flannel, chinos, and Red Wing boots",
      detected_gender: "men",
      items: [
        item("Outerwear", "Waxed Jacket", "Barbour", "olive", "waxed cotton", 0.93),
        item("Top", "Flannel Shirt", "Gitman Vintage", "red plaid", "cotton flannel", 0.88),
        item("Bottom", "Chinos", "Bills Khakis", "khaki", "cotton twill", 0.87),
        item("Shoes", "Iron Ranger Boots", "Red Wing", "amber", "leather", 0.92),
      ],
    },
    {
      summary: "Italian summer — unstructured linen suit with camp collar shirt and leather sandals",
      detected_gender: "men",
      items: [
        item("Outerwear", "Linen Suit Jacket", "Boglioli", "beige", "linen", 0.90),
        item("Bottom", "Linen Trousers", "Boglioli", "beige", "linen", 0.89),
        item("Top", "Camp Collar Shirt", "Corridor", "white", "linen", 0.87),
        item("Shoes", "Leather Sandals", "Paraboot", "brown", "leather", 0.86),
      ],
    },
    {
      summary: "Weekend gentleman — polo, chinos, white sneakers, and a leather watch",
      detected_gender: "men",
      items: [
        item("Top", "Polo Shirt", "Sunspel", "navy", "cotton pique", 0.89),
        item("Bottom", "Chinos", "Incotex", "stone", "stretch cotton", 0.88),
        item("Shoes", "White Sneakers", "Common Projects", "white", "leather", 0.92),
        item("Accessory", "Leather Watch", "Hamilton", "brown", "leather strap", 0.85),
      ],
    },
    {
      summary: "Rainy day refined — charcoal overcoat with Chelsea boots and a navy crewneck",
      detected_gender: "men",
      items: [
        item("Outerwear", "Wool Overcoat", "Mackintosh", "charcoal", "wool", 0.92),
        item("Top", "Crewneck Sweater", "John Smedley", "navy", "merino wool", 0.89),
        item("Bottom", "Tailored Trousers", "Theory", "charcoal", "wool", 0.88),
        item("Shoes", "Chelsea Boots", "R.M. Williams", "brown", "leather", 0.91),
      ],
    },
  ],

  "Athlete Style": [
    {
      summary: "Post-game tunnel fit — oversized leather jacket, designer tee, joggers, and high-top sneakers",
      detected_gender: "men",
      items: [
        item("Outerwear", "Oversized Leather Jacket", "Rick Owens", "black", "leather", 0.90),
        item("Top", "Designer T-Shirt", "Fear of God", "cream", "cotton", 0.87),
        item("Bottom", "Relaxed Joggers", "Essentials", "black", "cotton blend", 0.85),
        item("Shoes", "High-Top Sneakers", "Jordan", "chicago red/white/black", "leather", 0.94),
      ],
    },
    {
      summary: "Off-court LeBron energy — oversized hoodie with tailored shorts and designer sneakers",
      detected_gender: "men",
      items: [
        item("Top", "Oversized Hoodie", "Nike", "black", "cotton blend", 0.89),
        item("Bottom", "Tailored Shorts", "Rhude", "black", "nylon blend", 0.87),
        item("Shoes", "LeBron Sneakers", "Nike", "black/gold", "flyknit", 0.91),
      ],
    },
    {
      summary: "NFL tunnel walk — Amiri everything with Nike Dunks",
      detected_gender: "men",
      items: [
        item("Outerwear", "Leather Jacket", "Amiri", "black", "leather", 0.91),
        item("Top", "Graphic Tee", "Amiri", "white", "cotton", 0.87),
        item("Bottom", "Distressed Jeans", "Amiri", "black", "denim", 0.88),
        item("Shoes", "Dunk Low", "Nike", "black/white", "leather", 0.93),
      ],
    },
    {
      summary: "Post-game press conference — clean Fear of God set",
      detected_gender: "men",
      items: [
        item("Outerwear", "Oversized Blazer", "Fear of God", "cream", "wool", 0.89),
        item("Top", "Mock Neck Tee", "Essentials", "black", "cotton", 0.87),
        item("Bottom", "Wide Trousers", "Fear of God", "cream", "wool", 0.88),
        item("Shoes", "Slides", "Fear of God", "cream", "rubber", 0.85),
      ],
    },
    {
      summary: "Soccer player off-duty — Stone Island bomber with Adidas Sambas",
      detected_gender: "men",
      items: [
        item("Outerwear", "Bomber Jacket", "Stone Island", "navy", "nylon", 0.91),
        item("Top", "Turtleneck", "Uniqlo", "black", "merino wool", 0.87),
        item("Bottom", "Slim Chinos", "Zara", "black", "cotton stretch", 0.85),
        item("Shoes", "Samba Sneakers", "Adidas", "white/black", "leather", 0.93),
      ],
    },
    {
      summary: "Training day style — matching Nike Tech Fleece set with Air Max 90s",
      detected_gender: "men",
      items: [
        item("Top", "Tech Fleece Hoodie", "Nike", "grey", "tech fleece", 0.91),
        item("Bottom", "Tech Fleece Joggers", "Nike", "grey", "tech fleece", 0.90),
        item("Shoes", "Air Max 90", "Nike", "white/grey", "leather/mesh", 0.92),
      ],
    },
  ],

  "Essential Man": [
    {
      summary: "Everyday essentials — perfect-fit tee, slim chinos, clean sneakers, and a simple watch",
      detected_gender: "men",
      items: [
        item("Top", "Premium T-Shirt", "Reigning Champ", "heather grey", "cotton", 0.88),
        item("Bottom", "Slim Chinos", "Bonobos", "khaki", "stretch cotton", 0.87),
        item("Shoes", "Leather Sneakers", "Common Projects", "white", "leather", 0.93),
      ],
    },
    {
      summary: "The only jacket you need — navy Baracuta harrington with Breton stripe tee",
      detected_gender: "men",
      items: [
        item("Outerwear", "Harrington Jacket", "Baracuta", "navy", "cotton", 0.90),
        item("Top", "Breton Stripe Tee", "Armor Lux", "navy/white", "cotton", 0.88),
        item("Bottom", "Dark Jeans", "A.P.C.", "indigo", "japanese denim", 0.89),
        item("Shoes", "Canvas Sneakers", "Spring Court", "white", "canvas", 0.87),
      ],
    },
    {
      summary: "Monochrome confidence — black on black crewneck, jeans, and boots",
      detected_gender: "men",
      items: [
        item("Top", "Black Crewneck", "Reigning Champ", "black", "fleece cotton", 0.88),
        item("Bottom", "Black Jeans", "Acne Studios", "black", "denim", 0.89),
        item("Shoes", "Black Boots", "Blundstone", "black", "leather", 0.90),
      ],
    },
    {
      summary: "Summer capsule — linen shirt, chino shorts, and leather sandals",
      detected_gender: "men",
      items: [
        item("Top", "Linen Shirt", "Everlane", "white", "linen", 0.89),
        item("Bottom", "Chino Shorts", "Norse Projects", "beige", "cotton twill", 0.87),
        item("Shoes", "Leather Sandals", "Birkenstock", "brown", "oiled leather", 0.88),
      ],
    },
    {
      summary: "Fall uniform — Portuguese flannel, dark jeans, and suede Chelsea boots",
      detected_gender: "men",
      items: [
        item("Top", "Flannel Overshirt", "Portuguese Flannel", "red/black", "cotton flannel", 0.88),
        item("Bottom", "Slim Jeans", "Nudie Jeans", "dark wash", "organic denim", 0.87),
        item("Shoes", "Suede Chelsea Boots", "Clarks", "sand", "suede", 0.86),
      ],
    },
    {
      summary: "Quality basics — the $200 outfit that looks like $2000",
      detected_gender: "men",
      items: [
        item("Top", "Merino Sweater", "Uniqlo", "grey", "merino wool", 0.88),
        item("Bottom", "Tailored Chinos", "Dockers", "olive", "cotton twill", 0.86),
        item("Shoes", "Desert Boots", "Clarks", "beeswax", "leather", 0.89),
        item("Accessory", "Leather Belt", "Anderson's", "brown", "woven leather", 0.85),
      ],
    },
  ],

  "Rock & Roll Style": [
    {
      summary: "Rock meets refined — leather biker jacket, band tee, skinny jeans, Chelsea boots",
      detected_gender: "men",
      items: [
        item("Outerwear", "Biker Jacket", "Schott NYC", "black", "leather", 0.94),
        item("Top", "Vintage Band Tee", null, "washed black", "cotton", 0.82),
        item("Bottom", "Skinny Jeans", "Saint Laurent", "black", "denim", 0.89),
        item("Shoes", "Chelsea Boots", "Saint Laurent", "black", "leather", 0.92),
      ],
    },
    {
      summary: "Backstage cool — vintage band hoodie with slim trousers and suede boots",
      detected_gender: "men",
      items: [
        item("Top", "Vintage Band Hoodie", null, "black", "cotton", 0.83),
        item("Bottom", "Slim Trousers", "AllSaints", "black", "wool blend", 0.87),
        item("Shoes", "Suede Boots", "AllSaints", "black", "suede", 0.88),
        item("Accessory", "Silver Rings", null, "silver", "sterling silver", 0.82),
      ],
    },
    {
      summary: "Keith Richards energy — printed silk shirt with slim jeans and Cuban heel boots",
      detected_gender: "men",
      items: [
        item("Top", "Silk Shirt", "AllSaints", "printed", "silk", 0.86),
        item("Bottom", "Slim Black Jeans", "Saint Laurent", "black", "denim", 0.89),
        item("Shoes", "Cuban Heel Boots", "Story et Fall", "black", "leather", 0.88),
        item("Accessory", "Pendant Necklace", "Chrome Hearts", "silver", "sterling silver", 0.85),
      ],
    },
    {
      summary: "Indie rock aesthetic — oversized cardigan with striped tee, slim trousers, and Converse",
      detected_gender: "men",
      items: [
        item("Top", "Oversized Cardigan", "Our Legacy", "grey", "wool", 0.87),
        item("Top", "Striped Tee", null, "black/white", "cotton", 0.84),
        item("Bottom", "Slim Trousers", "COS", "black", "cotton blend", 0.86),
        item("Shoes", "High Top Sneakers", "Converse", "black", "canvas", 0.91),
      ],
    },
    {
      summary: "Stage-ready — leather vest, mesh tank, leather pants, and harness boots",
      detected_gender: "men",
      items: [
        item("Outerwear", "Leather Vest", "Schott", "black", "leather", 0.90),
        item("Top", "Mesh Tank", "Rick Owens", "black", "mesh", 0.85),
        item("Bottom", "Leather Pants", "AllSaints", "black", "leather", 0.88),
        item("Shoes", "Harness Boots", "Saint Laurent", "black", "leather", 0.91),
      ],
    },
    {
      summary: "David Bowie tribute — bold printed blazer with wide trousers and platform boots",
      detected_gender: "men",
      items: [
        item("Outerwear", "Printed Blazer", "Dries Van Noten", "floral", "jacquard", 0.88),
        item("Bottom", "Wide Trousers", "Marni", "black", "wool", 0.86),
        item("Shoes", "Platform Boots", "Rick Owens", "black", "leather", 0.89),
      ],
    },
  ],

  "Celeb Spotted": [
    {
      summary: "Airport style decoded — cashmere hoodie, tailored joggers, designer sneakers, and oversized shades",
      detected_gender: "both",
      items: [
        item("Top", "Cashmere Hoodie", "Brunello Cucinelli", "oatmeal", "cashmere", 0.88),
        item("Bottom", "Tailored Joggers", "Loro Piana", "navy", "technical wool", 0.86),
        item("Shoes", "Designer Sneakers", "Golden Goose", "white/star", "leather", 0.91),
        item("Accessory", "Oversized Sunglasses", "Celine", "black", "acetate", 0.87),
      ],
    },
    {
      summary: "Spotted: Hailey Bieber — oversized leather jacket, white tank, baggy jeans, and pointed boots",
      detected_gender: "women",
      items: [
        item("Outerwear", "Oversized Leather Jacket", "Saint Laurent", "black", "leather", 0.92),
        item("Top", "White Tank Top", "Skims", "white", "cotton", 0.86),
        item("Bottom", "Baggy Jeans", "Citizens of Humanity", "light wash", "denim", 0.88),
        item("Shoes", "Pointed Boots", "The Row", "brown", "leather", 0.90),
      ],
    },
    {
      summary: "Spotted: Zendaya at a premiere — power suit with platform heels and statement earrings",
      detected_gender: "women",
      items: [
        item("Outerwear", "Structured Suit", "Louis Vuitton", "black", "wool", 0.93),
        item("Bottom", "Matching Trousers", "Louis Vuitton", "black", "wool", 0.92),
        item("Shoes", "Platform Heels", "Louis Vuitton", "black", "leather", 0.90),
        item("Accessory", "Statement Earrings", "Bulgari", "diamond", "white gold", 0.88),
      ],
    },
    {
      summary: "Spotted: Timothee Chalamet — oversized red cardigan, vintage tee, and Bottega boots",
      detected_gender: "men",
      items: [
        item("Top", "Oversized Cardigan", "Haider Ackermann", "red", "wool", 0.87),
        item("Top", "Vintage Tee", null, "white", "cotton", 0.83),
        item("Bottom", "Slim Trousers", "Celine", "black", "wool", 0.88),
        item("Shoes", "Leather Boots", "Bottega Veneta", "black", "leather", 0.90),
      ],
    },
    {
      summary: "Spotted: Rihanna — oversized red puffer, bodysuit, wide jeans, and platform boots",
      detected_gender: "women",
      items: [
        item("Outerwear", "Oversized Puffer", "Balenciaga", "red", "nylon/down", 0.91),
        item("Top", "Bodysuit", "Savage x Fenty", "black", "stretch jersey", 0.86),
        item("Bottom", "Wide Leg Pants", "Vetements", "denim", "denim", 0.85),
        item("Shoes", "Platform Boots", "Balenciaga", "black", "leather", 0.90),
      ],
    },
    {
      summary: "Spotted: Kendall Jenner — beige trench, white tank, dark jeans, and pointed heels",
      detected_gender: "women",
      items: [
        item("Outerwear", "Trench Coat", "The Row", "beige", "cotton", 0.92),
        item("Top", "Tank Top", "Khaite", "white", "cashmere", 0.88),
        item("Bottom", "Straight Leg Jeans", "Khaite", "dark wash", "denim", 0.89),
        item("Shoes", "Pointed Heels", "The Row", "black", "leather", 0.90),
      ],
    },
    {
      summary: "Spotted: Bad Bunny — bold pink Jacquemus set with Birkenstock sandals and bucket hat",
      detected_gender: "men",
      items: [
        item("Top", "Oversized Shirt", "Jacquemus", "pink", "cotton", 0.87),
        item("Bottom", "Wide Shorts", "Jacquemus", "pink", "cotton", 0.86),
        item("Shoes", "Chunky Sandals", "Birkenstock", "brown", "leather/cork", 0.88),
        item("Accessory", "Bucket Hat", "Prada", "pink", "nylon", 0.85),
      ],
    },
  ],

  "TikTok Trending": [
    {
      summary: "The viral clean girl aesthetic — slicked bun, gold hoops, matching set, and cloud slides",
      detected_gender: "women",
      items: [
        item("Top", "Ribbed Tank Top", "Skims", "espresso", "cotton blend", 0.89),
        item("Bottom", "Wide-Leg Trousers", "Aritzia", "espresso", "crepe", 0.87),
        item("Shoes", "Cloud Slides", "UGG", "bone", "foam/shearling", 0.90),
        item("Accessory", "Gold Hoop Earrings", "Mejuri", "gold", "14k gold vermeil", 0.84),
      ],
    },
    {
      summary: "Mob wife aesthetic — faux fur coat, satin blouse, leather pants, and gold chains",
      detected_gender: "women",
      items: [
        item("Outerwear", "Faux Fur Coat", "Zara", "black", "faux fur", 0.87),
        item("Top", "Satin Blouse", "Reformation", "red", "satin", 0.88),
        item("Bottom", "Leather Pants", "Zara", "black", "faux leather", 0.86),
        item("Accessory", "Gold Chain Necklace", "Laura Lombardi", "gold", "gold plated brass", 0.85),
      ],
    },
    {
      summary: "Quiet luxury TikTok edition — The Row dupes from COS and Aritzia",
      detected_gender: "women",
      items: [
        item("Top", "Oversized Shirt", "COS", "white", "poplin cotton", 0.88),
        item("Bottom", "Wide Leg Trousers", "Aritzia", "taupe", "crepe", 0.87),
        item("Shoes", "Leather Slides", "Zara", "tan", "leather", 0.85),
        item("Accessory", "Minimal Tote", "Polene", "tan", "leather", 0.86),
      ],
    },
    {
      summary: "Coquette bow trend — ribbons, pleats, and Mary Janes",
      detected_gender: "women",
      items: [
        item("Top", "Bow Blouse", "Reformation", "pink", "cotton", 0.86),
        item("Bottom", "Pleated Mini Skirt", "Miu Miu", "pink", "wool", 0.88),
        item("Shoes", "Mary Jane Heels", "Miu Miu", "black", "patent leather", 0.90),
        item("Accessory", "Ribbon Headband", "Jennifer Behr", "black", "satin", 0.84),
      ],
    },
    {
      summary: "Coastal cowgirl is taking over — denim cutoffs, cowboy boots, and a hat",
      detected_gender: "women",
      items: [
        item("Bottom", "Denim Cutoffs", "Agolde", "light wash", "denim", 0.87),
        item("Top", "White Crop Top", "Free People", "white", "cotton", 0.85),
        item("Shoes", "Cowboy Boots", "Tecovas", "white", "leather", 0.89),
        item("Accessory", "Cowboy Hat", "Lack of Color", "tan", "felt", 0.86),
      ],
    },
    {
      summary: "Old money aesthetic for guys — Ralph Lauren cable knit with chinos and loafers",
      detected_gender: "men",
      items: [
        item("Top", "Cable Knit Sweater", "Ralph Lauren", "navy", "cotton", 0.89),
        item("Bottom", "Chinos", "Ralph Lauren", "khaki", "cotton twill", 0.87),
        item("Shoes", "Loafers", "G.H. Bass", "brown", "leather", 0.88),
        item("Accessory", "Leather Belt", "Ralph Lauren", "brown", "leather", 0.85),
      ],
    },
    {
      summary: "Gymshark coded — the gym fit that broke TikTok",
      detected_gender: "women",
      items: [
        item("Top", "Seamless Sports Bra", "Gymshark", "dusty rose", "nylon/spandex", 0.88),
        item("Bottom", "Scrunch Leggings", "Gymshark", "dusty rose", "nylon/spandex", 0.87),
        item("Shoes", "Cloud Sneakers", "On Running", "white", "mesh/rubber", 0.90),
      ],
    },
  ],

  "Sustainable Style": [
    {
      summary: "Conscious closet — organic cotton tee, recycled denim, hemp sneakers",
      detected_gender: "both",
      items: [
        item("Top", "Organic Cotton Tee", "Patagonia", "natural", "organic cotton", 0.90),
        item("Bottom", "Recycled Denim Jeans", "Nudie Jeans", "mid blue", "recycled cotton denim", 0.88),
        item("Shoes", "Sustainable Sneakers", "Allbirds", "natural white", "merino wool", 0.91),
      ],
    },
    {
      summary: "100% secondhand outfit — thrifted corduroy jacket, vintage tee, and Levi's",
      detected_gender: "women",
      items: [
        item("Outerwear", "Corduroy Jacket", null, "tan", "corduroy", 0.84),
        item("Top", "Striped Tee", null, "navy/white", "cotton", 0.82),
        item("Bottom", "Wide Leg Jeans", "Levi's", "medium wash", "denim", 0.87),
        item("Shoes", "Canvas Sneakers", "Converse", "white", "canvas", 0.89),
      ],
    },
    {
      summary: "Deadstock fabric fashion — Bode patchwork with Story MFG pants and Brother Vellies sandals",
      detected_gender: "men",
      items: [
        item("Outerwear", "Patchwork Jacket", "Bode", "multi-color", "deadstock fabrics", 0.86),
        item("Bottom", "Linen Pants", "Story MFG", "indigo", "organic linen", 0.85),
        item("Shoes", "Handmade Sandals", "Brother Vellies", "brown", "vegetable-tanned leather", 0.87),
      ],
    },
    {
      summary: "Capsule wardrobe queen — Everlane cardigan, straight jeans, and Nisolo boots",
      detected_gender: "women",
      items: [
        item("Top", "Merino Cardigan", "Everlane", "oatmeal", "merino wool", 0.89),
        item("Bottom", "Straight Leg Jeans", "Everlane", "dark wash", "organic cotton denim", 0.88),
        item("Shoes", "Leather Boots", "Nisolo", "brown", "ethically sourced leather", 0.87),
        item("Accessory", "Canvas Tote", "Baggu", "natural", "recycled canvas", 0.85),
      ],
    },
    {
      summary: "Rental fashion for the win — borrowed Reformation dress with Stella McCartney heels",
      detected_gender: "women",
      items: [
        item("Dress", "Silk Midi Dress", "Reformation", "green", "deadstock silk", 0.90),
        item("Shoes", "Strappy Heels", "Stella McCartney", "nude", "vegan leather", 0.88),
        item("Accessory", "Vintage Clutch", "Chanel", "black", "lambskin", 0.91),
      ],
    },
    {
      summary: "Plant-dyed everything — Story MFG tee with Patagonia shorts and cork Birkenstocks",
      detected_gender: "men",
      items: [
        item("Top", "Plant-Dyed Tee", "Story MFG", "sage", "organic cotton", 0.86),
        item("Bottom", "Linen Shorts", "Patagonia", "natural", "organic linen", 0.85),
        item("Shoes", "Cork Sandals", "Birkenstock", "natural", "cork/latex", 0.88),
      ],
    },
  ],

  "Budget Style Wins": [
    {
      summary: "Full outfit under $80 — H&M blazer, Uniqlo tee, Zara trousers, and Adidas sneakers",
      detected_gender: "both",
      items: [
        item("Outerwear", "Relaxed Blazer", "H&M", "beige", "polyester blend", 0.87),
        item("Top", "Supima Cotton Tee", "Uniqlo", "white", "supima cotton", 0.89),
        item("Bottom", "Wide-Leg Trousers", "Zara", "black", "viscose blend", 0.86),
        item("Shoes", "Stan Smith Sneakers", "Adidas", "white/green", "leather", 0.93),
      ],
    },
    {
      summary: "Zara, Uniqlo, and Converse — full outfit under $75",
      detected_gender: "women",
      items: [
        item("Outerwear", "Oversized Blazer", "Zara", "black", "polyester blend", 0.86),
        item("Top", "Ribbed Tank", "Uniqlo", "white", "cotton", 0.87),
        item("Bottom", "Wide Leg Jeans", "Zara", "medium wash", "denim", 0.85),
        item("Shoes", "Chuck 70", "Converse", "black", "canvas", 0.90),
      ],
    },
    {
      summary: "H&M premium trench looks designer — the $40 coat that changes everything",
      detected_gender: "women",
      items: [
        item("Outerwear", "Trench Coat", "H&M", "beige", "cotton blend", 0.85),
        item("Top", "Turtleneck", "Uniqlo", "black", "cotton", 0.87),
        item("Bottom", "Tailored Pants", "H&M", "black", "polyester blend", 0.84),
        item("Shoes", "Loafers", "H&M", "black", "faux leather", 0.83),
      ],
    },
    {
      summary: "Guys: full fit under $100 — Uniqlo is your best friend",
      detected_gender: "men",
      items: [
        item("Top", "Oxford Shirt", "Uniqlo", "light blue", "cotton", 0.88),
        item("Bottom", "Chinos", "Uniqlo", "navy", "cotton twill", 0.87),
        item("Shoes", "Canvas Sneakers", "Converse", "white", "canvas", 0.89),
        item("Accessory", "Leather Belt", "Amazon", "brown", "genuine leather", 0.82),
      ],
    },
    {
      summary: "Thrift flip challenge — turned $20 into a $200 look",
      detected_gender: "women",
      items: [
        item("Outerwear", "Vintage Blazer", null, "brown", "wool", 0.82),
        item("Top", "Band Tee", null, "black", "cotton", 0.80),
        item("Bottom", "Straight Jeans", "Levi's", "medium wash", "denim", 0.85),
        item("Shoes", "Boots", null, "brown", "leather", 0.83),
      ],
    },
    {
      summary: "ASOS under $50 — the budget streetwear set that goes hard",
      detected_gender: "men",
      items: [
        item("Top", "Oversized Hoodie", "ASOS", "grey", "cotton blend", 0.84),
        item("Bottom", "Cargo Pants", "ASOS", "black", "cotton", 0.83),
        item("Shoes", "Retro Sneakers", "ASOS", "white/navy", "synthetic", 0.82),
      ],
    },
  ],

  "Seasonal Edit": [
    {
      summary: "Spring transition — lightweight trench, striped Breton top, tailored shorts, and canvas sneakers",
      detected_gender: "both",
      items: [
        item("Outerwear", "Lightweight Trench", "Uniqlo", "khaki", "cotton blend", 0.88),
        item("Top", "Breton Stripe Top", "Saint James", "navy/white", "cotton jersey", 0.90),
        item("Bottom", "Tailored Shorts", "J.Crew", "olive", "cotton twill", 0.85),
        item("Shoes", "Canvas Sneakers", "Veja", "white", "organic canvas", 0.89),
      ],
    },
    {
      summary: "Summer whites — how to wear head-to-toe white without staining it",
      detected_gender: "women",
      items: [
        item("Dress", "Linen Dress", "Reformation", "white", "linen", 0.89),
        item("Shoes", "Woven Sandals", "Ancient Greek Sandals", "white", "leather", 0.87),
        item("Accessory", "Straw Bag", "Loewe", "natural", "raffia", 0.88),
      ],
    },
    {
      summary: "Fall color palette — burgundy, olive, and camel are everything right now",
      detected_gender: "women",
      items: [
        item("Outerwear", "Camel Coat", "COS", "camel", "wool", 0.91),
        item("Top", "Burgundy Sweater", "Sezane", "burgundy", "wool", 0.88),
        item("Bottom", "Olive Trousers", "Arket", "olive", "cotton twill", 0.86),
        item("Shoes", "Suede Boots", "Rag & Bone", "brown", "suede", 0.89),
      ],
    },
    {
      summary: "Winter layering masterclass — puffer coat, chunky scarf, cashmere turtleneck, and lug sole boots",
      detected_gender: "women",
      items: [
        item("Outerwear", "Puffer Coat", "Aritzia", "black", "nylon/down", 0.90),
        item("Accessory", "Chunky Knit Scarf", "Acne Studios", "grey", "wool", 0.87),
        item("Top", "Turtleneck Sweater", "COS", "cream", "cashmere", 0.89),
        item("Bottom", "Wool Trousers", "Theory", "charcoal", "wool", 0.88),
        item("Shoes", "Lug Sole Boots", "Ganni", "black", "leather", 0.90),
      ],
    },
    {
      summary: "Men's spring essentials — light bomber, oxford shirt, chinos, and Stan Smiths",
      detected_gender: "men",
      items: [
        item("Outerwear", "Light Bomber Jacket", "COS", "navy", "nylon", 0.88),
        item("Top", "Oxford Shirt", "J.Crew", "white", "cotton", 0.89),
        item("Bottom", "Chinos", "Norse Projects", "khaki", "cotton twill", 0.87),
        item("Shoes", "Stan Smith Sneakers", "Adidas", "white", "leather", 0.91),
      ],
    },
    {
      summary: "Resort wear guide — camp collar shirt, linen shorts, espadrilles, and a straw hat",
      detected_gender: "men",
      items: [
        item("Top", "Camp Collar Shirt", "Onia", "tropical print", "linen", 0.87),
        item("Bottom", "Linen Shorts", "Orlebar Brown", "navy", "linen", 0.88),
        item("Shoes", "Espadrilles", "Castaner", "natural", "canvas/jute", 0.86),
        item("Accessory", "Straw Hat", "Lack of Color", "natural", "straw", 0.84),
      ],
    },
    {
      summary: "Holiday party season — velvet blazer with silk camisole and gold strappy heels",
      detected_gender: "women",
      items: [
        item("Outerwear", "Velvet Blazer", "Sandro", "emerald", "velvet", 0.89),
        item("Top", "Silk Camisole", "Cami NYC", "black", "silk", 0.90),
        item("Bottom", "Tailored Trousers", "Theory", "black", "wool", 0.88),
        item("Shoes", "Strappy Heels", "Schutz", "gold", "metallic leather", 0.87),
      ],
    },
  ],
};
