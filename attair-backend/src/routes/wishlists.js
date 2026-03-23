import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

// ─── GET /api/wishlists — list all wishlists for user ───────
router.get("/", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("wishlists")
    .select("id, name, created_at")
    .eq("user_id", req.userId)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: "Failed to fetch wishlists" });
  return res.json({ wishlists: data || [] });
});

// ─── POST /api/wishlists — create a wishlist ─────────────────
router.post("/", requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const { data, error } = await supabase
    .from("wishlists")
    .insert({ user_id: req.userId, name: name.trim() })
    .select("id, name, created_at")
    .single();

  if (error) return res.status(500).json({ error: "Failed to create wishlist" });
  return res.json(data);
});

// ─── DELETE /api/wishlists/:id — delete a wishlist ───────────
router.delete("/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  // Remove all saved_items from this wishlist first
  await supabase
    .from("saved_items")
    .update({ wishlist_id: null })
    .eq("user_id", req.userId)
    .eq("wishlist_id", id);

  const { error } = await supabase
    .from("wishlists")
    .delete()
    .eq("id", id)
    .eq("user_id", req.userId);

  if (error) return res.status(500).json({ error: "Failed to delete wishlist" });
  return res.json({ message: "Deleted" });
});

// ─── PATCH /api/wishlists/:id — rename a wishlist ────────────
router.patch("/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });

  const { data, error } = await supabase
    .from("wishlists")
    .update({ name: name.trim() })
    .eq("id", id)
    .eq("user_id", req.userId)
    .select("id, name")
    .single();

  if (error) return res.status(500).json({ error: "Failed to rename wishlist" });
  return res.json(data);
});

// ─── POST /api/wishlists/:id/items — move saved item into list ─
router.post("/:id/items", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { saved_item_id } = req.body;
  if (!saved_item_id) return res.status(400).json({ error: "saved_item_id required" });

  // Verify wishlist belongs to user
  const { data: wl } = await supabase
    .from("wishlists")
    .select("id")
    .eq("id", id)
    .eq("user_id", req.userId)
    .single();

  if (!wl) return res.status(404).json({ error: "Wishlist not found" });

  const { error } = await supabase
    .from("saved_items")
    .update({ wishlist_id: id })
    .eq("id", saved_item_id)
    .eq("user_id", req.userId);

  if (error) return res.status(500).json({ error: "Failed to move item" });
  return res.json({ message: "Moved" });
});

// ─── DELETE /api/wishlists/:id/items/:itemId — remove from list ─
router.delete("/:id/items/:itemId", requireAuth, async (req, res) => {
  const { itemId } = req.params;

  const { error } = await supabase
    .from("saved_items")
    .update({ wishlist_id: null })
    .eq("id", itemId)
    .eq("user_id", req.userId);

  if (error) return res.status(500).json({ error: "Failed to remove item from list" });
  return res.json({ message: "Removed" });
});

export default router;
