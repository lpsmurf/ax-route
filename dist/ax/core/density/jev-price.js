// The one place the Jev classifier price is read. It lives in config/models.yaml next to the other API list prices
// (entry `jev-latest`, with its source); density, savings and Dream all take it from here.
import { priceFor } from "../usage/pricing.js";
export const JEV_MODEL = "jev-latest";
// Used only when the price book has no jev-latest entry (a minimal book in a test, a config from before the entry).
const FALLBACK_USD_PER_MTOK = 0.042;
export const jevPricePerMTok = (book) => (book ? priceFor(book, JEV_MODEL)?.input : undefined) ?? FALLBACK_USD_PER_MTOK;
