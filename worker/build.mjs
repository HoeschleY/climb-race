// Builds worker.js (one file to paste into Cloudflare) from src.js + the site's rating code
import { readFileSync, writeFileSync } from "node:fs";
const rating = readFileSync(new URL("../scripts/rating.mjs", import.meta.url), "utf8").replace(/^export /gm, "");
const src = readFileSync(new URL("./src.js", import.meta.url), "utf8").replace("/*RATING*/", "// ---- lobby rating (copied from scripts/rating.mjs) ----\n" + rating + "// ---- end of rating ----");
writeFileSync(new URL("./worker.js", import.meta.url), "// GENERATED from worker/src.js by worker/build.mjs: edit src.js, then run `node worker/build.mjs`\n" + src);
