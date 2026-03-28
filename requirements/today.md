## Today's Build — 2026-03-28

### Picking Screen
1. **Budget slider + chips** — add range slider back alongside the multi-select $ chips so users have both controls
2. **Advanced filters separation** — add clear divider/section header between advanced filters block and item list so they're visually distinct

### Results Screen
3. **Complete the Look exposed** — pull out of Refined Search, show as its own visible section on Results by default
4. **Refined Search → AI chat** — replace the button with a text input where user types natural language ("cheaper options", "more casual") that feeds back into search context
5. **Kill Try Alternate Search** — remove the button, fold fallback logic into the new AI chat refine input
6. **Share auto-public** — when user taps Share or Share Card, auto-set scan visibility to public + show toast "Link is now public"
7. **Share card fix** — ensure Share Card generates the branded 1080x1920 PNG and triggers native share correctly

### For You / Following Pages
8. **2x2 grid layout** — replace single large image Instagram-style feed with 2x2 smaller cards so users see multiple posts at once

### Saved Page
9. **Wishlist instant refresh** — when user creates a new wishlist from the "Add to Wishlist" flow, the Saved page should immediately reflect the new wishlist without needing to navigate away