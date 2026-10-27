const ALLOWED_ORIGIN = "https://hedlundapplianceservice.github.io";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function getText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AppliancePartsDirectory/1.0)",
      "Accept": "text/html,application/xhtml+xml"
    }
  });
  if (!response.ok) throw new Error(`Source returned ${response.status}`);
  return response.text();
}

function extractAssignedJson(html, assignment) {
  const at = html.indexOf(assignment);
  if (at < 0) throw new Error("Parts data was not present on the model page");
  const start = html.indexOf("{", at + assignment.length);
  if (start < 0) throw new Error("Parts data could not be parsed");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error("Parts data was incomplete");
}

function findModelPage(html, brand, model) {
  const wantedModel = normalize(model);
  const wantedBrand = normalize(brand);
  const links = [...html.matchAll(/href=["']([^"']*\/model\/[^"']+)["']/gi)];
  const candidates = links.map(match => {
    const path = match[1].replace(/&amp;/g, "&");
    const slug = normalize(path.split("?")[0]);
    const modelMatch = slug.includes(wantedModel);
    const brandMatch = !wantedBrand || slug.includes(wantedBrand);
    return { path, score: (modelMatch ? 4 : 0) + (brandMatch ? 1 : 0) };
  }).filter(item => item.score >= 4).sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  return new URL(candidates[0].path, "https://www.searspartsdirect.com").toString();
}

function collectRefs(value, into = new Set()) {
  if (!value || typeof value !== "object") return into;
  if (typeof value.__ref === "string" && /^Part:/.test(value.__ref)) into.add(value.__ref);
  if (Array.isArray(value)) value.forEach(item => collectRefs(item, into));
  else Object.values(value).forEach(item => collectRefs(item, into));
  return into;
}

function partRecords(cacheData) {
  const entities = cacheData?.ROOT_QUERY ? cacheData : cacheData?.data?.ROOT_QUERY ? cacheData.data : null;
  if (!entities) throw new Error("Unrecognized source data format");
  const modelEntities = Object.entries(entities).filter(([key, value]) => key.startsWith("Model:") && value && typeof value === "object");
  const partRefs = new Set();
  let totalCount = 0;
  for (const [, model] of modelEntities) {
    for (const [key, value] of Object.entries(model)) {
      if (!key.startsWith("parts")) continue;
      const foundTotal = Number(value?.totalCount || value?.items?.totalCount || value?.pageInfo?.totalCount || 0);
      totalCount = Math.max(totalCount, foundTotal);
      collectRefs(value, partRefs);
    }
  }
  const parts = [...partRefs].map(ref => {
    const source = entities[ref] || entities["data"]?.[ref];
    if (!source) return null;
    let replacement = null;
    const replacementRefs = collectRefs(source.substitutedByList);
    for (const replacementRef of replacementRefs) {
      const candidate = entities[replacementRef] || entities["data"]?.[replacementRef];
      if (candidate?.number) { replacement = candidate; break; }
    }
    const originalNumber = source.number || "";
    const currentNumber = replacement?.number || originalNumber;
    const title = source.title || source.description || "";
    if (!title || !currentNumber) return null;
    return {
      name: title.trim(),
      partNumber: String(currentNumber).trim(),
      originalPartNumber: replacement && originalNumber !== currentNumber ? String(originalNumber).trim() : "",
      diagram: String(source.contextSchematicTitle || "").trim(),
      sourceUrl: ""
    };
  }).filter(Boolean);
  return { parts, totalCount };
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await fn(items[index], index);
    }
  }));
  return output;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET for a model lookup." });

  const brand = String(req.query.brand || "").trim();
  const model = String(req.query.model || "").trim();
  const appliance = String(req.query.appliance || "").trim();
  if (brand.length < 2 || model.length < 2 || model.length > 48) {
    return res.status(400).json({ error: "Enter a brand and a valid model number." });
  }

  const key = `${normalize(brand)}|${normalize(model)}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return res.status(200).json(cached.value);

  try {
    const searchUrl = `https://www.searspartsdirect.com/search?q=${encodeURIComponent(`${brand} ${model}`)}&tab=model`;
    const searchHtml = await getText(searchUrl);
    const modelUrl = findModelPage(searchHtml, brand, model);
    if (!modelUrl) return res.status(404).json({ error: `No exact Sears model page found for ${brand} ${model}.` });

    const firstHtml = await getText(modelUrl);
    const firstData = extractAssignedJson(firstHtml, "window.CATALOG_API_RESPONSE");
    const first = partRecords(firstData);
    const pages = Math.min(30, Math.max(1, Math.ceil(first.totalCount / Math.max(1, first.parts.length || 10))));
    const pageUrls = Array.from({ length: pages - 1 }, (_, index) => {
      const url = new URL(modelUrl);
      url.searchParams.set("page", String(index + 2));
      return url.toString();
    });
    const rest = await mapLimit(pageUrls, 3, async url => {
      const html = await getText(url);
      return partRecords(extractAssignedJson(html, "window.CATALOG_API_RESPONSE")).parts;
    });
    const byPart = new Map();
    for (const part of [ ...first.parts, ...rest.flat() ]) {
      const id = `${normalize(part.name)}|${normalize(part.partNumber)}`;
      if (!byPart.has(id)) byPart.set(id, { ...part, sourceUrl: modelUrl });
    }
    const parts = [...byPart.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const result = {
      brand,
      model,
      appliance,
      modelUrl,
      source: "Sears PartsDirect",
      partCount: parts.length,
      parts
    };
    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value: result });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(502).json({ error: "Could not read the model parts list right now.", detail: error.message });
  }
};
