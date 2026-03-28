import { Router } from "express";
import Stripe from "stripe";
import { requireAuth } from "../middleware/auth.js";
import supabase from "../lib/supabase.js";

const router = Router();

// SECURITY: Do not fall back to a placeholder — a missing key should be detectable.
// Stripe keys are intentionally NOT in REQUIRED_ENV (payments are optional; server still starts).
// Lazy initialisation so a missing key throws at first *use* rather than at module import time.
let _stripe = null;
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

const getSuccessUrl = () =>
  process.env.FRONTEND_URL ||
  process.env.CORS_ORIGINS?.split(",")[0]?.trim() ||
  "https://attair.vercel.app";

/**
 * POST /api/payments/create-checkout-session
 * Auth required. Creates a Stripe Checkout session.
 */
router.post("/create-checkout-session", requireAuth, async (req, res) => {
  const { plan } = req.body;
  if (!plan || !["yearly", "monthly"].includes(plan)) {
    return res.status(400).json({ error: "plan must be 'yearly' or 'monthly'" });
  }

  try {
    // Get user email from profile
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", req.userId)
      .single();

    // Get email from auth
    const { data: { user } } = await supabase.auth.admin.getUserById(req.userId);
    const email = user?.email || undefined;

    const successUrl = `${getSuccessUrl()}/upgrade-success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = getSuccessUrl();

    // Use pre-created Stripe Price IDs if configured; otherwise fall back to inline price_data.
    // This supports both hosted Stripe prices (recommended for production) and dynamic pricing.
    let lineItem;
    if (plan === "yearly" && process.env.STRIPE_PRICE_YEARLY) {
      lineItem = { price: process.env.STRIPE_PRICE_YEARLY, quantity: 1 };
    } else if (plan === "monthly" && process.env.STRIPE_PRICE_MONTHLY) {
      lineItem = { price: process.env.STRIPE_PRICE_MONTHLY, quantity: 1 };
    } else {
      const priceData = plan === "yearly"
        ? { currency: "usd", unit_amount: 3000, recurring: { interval: "year" }, product_data: { name: "ATTAIRE Pro — Yearly" } }
        : { currency: "usd", unit_amount: 500, recurring: { interval: "month" }, product_data: { name: "ATTAIRE Pro — Monthly" } };
      lineItem = { price_data: priceData, quantity: 1 };
    }

    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [lineItem],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: email,
      metadata: { user_id: req.userId },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
});

/**
 * POST /api/payments/webhook
 * NO auth — Stripe signs its own requests.
 * This route must be registered with express.raw() body parser.
 */
router.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    // SECURITY: Without the webhook secret we cannot verify the request came from Stripe.
    // Accepting the payload would let any caller fake payment events (trial→pro upgrades, etc).
    // Reject hard so the misconfiguration is visible immediately.
    console.error("[Webhook] STRIPE_WEBHOOK_SECRET is not set — rejecting all webhook calls. Set this env var.");
    return res.status(500).json({ error: "Webhook endpoint is not configured" });
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("[Webhook] Signature verification failed:", err.message);
    return res.status(400).json({ error: "Webhook signature verification failed" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.metadata?.user_id;
        if (userId) {
          await supabase
            .from("profiles")
            .update({ tier: "pro", upgrade_source: "stripe_web", stripe_customer_id: session.customer })
            .eq("id", userId);
          console.log(`[Webhook] User ${userId} upgraded to pro (customer: ${session.customer})`);
        }
        break;
      }
      case "customer.subscription.deleted":
      case "invoice.payment_failed": {
        const obj = event.data.object;
        const customerId = obj.customer;
        console.log(`[Webhook] ${event.type} for customer: ${customerId}`);
        if (customerId) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("id")
            .eq("stripe_customer_id", customerId)
            .single();
          if (profile) {
            await supabase
              .from("profiles")
              .update({ tier: "expired" })
              .eq("id", profile.id);
            console.log(`[Webhook] User ${profile.id} downgraded to expired`);
          }
        }
        break;
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[Webhook] Handler error for event ${event?.id || "unknown"} (type: ${event?.type || "unknown"}):`, err);
    return res.status(500).json({ error: "Webhook handler failed" });
  }
});

/**
 * POST /api/payments/start-trial
 * Auth required. Sets tier to 'trial' with 7-day expiry.
 * No card required — one trial per account (enforced by checking existing tier).
 */
router.post("/start-trial", requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("tier, trial_ends_at")
      .eq("id", req.userId)
      .single();

    if (!profile) return res.status(404).json({ error: "Profile not found" });

    // Only allow trial if on free tier and never trialled before
    if (profile.tier !== "free") {
      return res.status(409).json({ error: "Trial only available for free accounts" });
    }
    if (profile.trial_ends_at) {
      return res.status(409).json({ error: "You have already used your free trial" });
    }

    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await supabase
      .from("profiles")
      .update({ tier: "trial", trial_ends_at: trialEndsAt })
      .eq("id", req.userId);

    console.log(`[Trial] User ${req.userId} started 7-day trial, ends ${trialEndsAt}`);
    return res.json({ tier: "trial", trial_ends_at: trialEndsAt });
  } catch (err) {
    console.error("Start trial error:", err.message);
    return res.status(500).json({ error: "Failed to start trial" });
  }
});

export default router;
