import { readFileSync } from "node:fs";
import { parse } from "yaml";
export const loadPriceBook = (file) => parse(readFileSync(file, "utf8"));
// "1.25x" -> 1.25 * base; a plain number is already $/1M. Missing -> fallback multiplier.
function resolve(v, base, fallback) {
    const x = v ?? fallback;
    if (x === undefined)
        return base;
    if (typeof x === "number")
        return x;
    const m = /^([\d.]+)x$/.exec(x.trim());
    return m ? Number(m[1]) * base : Number(x);
}
export function findEntry(book, model) {
    if (book.pricing[model])
        return [model, book.pricing[model]];
    const key = Object.keys(book.pricing).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return key ? [key, book.pricing[key]] : undefined;
}
export function priceFor(book, model, speed) {
    const found = findEntry(book, model);
    if (!found)
        return undefined;
    const e = found[1];
    const d = book.defaults?.[e.provider] ?? {};
    const base = speed === "fast" && e.fast ? e.fast : e;
    // explicit $ cache prices are for standard speed; under fast mode fall back to the multipliers
    const own = (v) => (speed === "fast" && typeof v === "number" ? undefined : v);
    return {
        input: base.input,
        output: base.output,
        cacheRead: resolve(own(e.cache_read), base.input, d.cache_read),
        cacheWrite5m: resolve(own(e.cache_write_5m), base.input, d.cache_write_5m),
        cacheWrite1h: resolve(own(e.cache_write_1h), base.input, d.cache_write_1h ?? d.cache_write_5m),
    };
}
export function costOf(p, t) {
    return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite5m * p.cacheWrite5m + t.cacheWrite1h * p.cacheWrite1h) / 1e6;
}
