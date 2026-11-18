import { acquire } from './transport.mjs';
import { normalizeSheetFile, resolveHierarchy } from './hierarchy.mjs';
import { inspect } from './reader.mjs';

/**
 * Read the source catalog. It is the only declaration of which design files
 * may be fetched: sheet filenames are never turned into guessed URLs.
 */
export async function readCatalog(source) {
  const result = await acquire(source, '/catalog');
  let catalog;
  try {
    catalog = JSON.parse(result.bytes.toString('utf8'));
  } catch {
    throw new Error('catalog_invalid');
  }
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('catalog_invalid');
  }
  const files = new Map();
  if (catalog.files && typeof catalog.files === 'object' && !Array.isArray(catalog.files)) {
    for (const [name, url] of Object.entries(catalog.files)) {
      if (typeof url !== 'string' || !url) continue;
      const key = normalizeSheetFile(name);
      if (key) files.set(key, url);
    }
  }
  return {
    entry: typeof catalog.entry === 'string' ? catalog.entry : null,
    project: typeof catalog.project === 'string' ? catalog.project : null,
    files
  };
}

function fileNameFor(sourcePath) {
  try {
    const url = new URL(sourcePath, 'http://source.invalid');
    return normalizeSheetFile(decodeURIComponent(url.pathname));
  } catch {
    return normalizeSheetFile(sourcePath);
  }
}

/**
 * Claim the parts of one hierarchy.
 *
 * `path` selects the entry resource (default: the catalog entry). Child pages
 * are resolved only through `catalog.files`. Every fetched page is handed to
 * `store` so its exact bytes stay queryable; a page that cannot be fetched is
 * reported as an unresolved item instead of aborting or substituting another
 * page. The same physical child file reached through several sheet paths is
 * fetched once but resolved once per path.
 */
export async function claimParts({ source, store = null, path = null, catalog = null,
  limits = {} } = {}) {
  const declaration = catalog ?? await readCatalog(source);
  const entryPath = path ?? declaration.entry;
  if (!entryPath) throw new Error('catalog_entry_missing');
  const entryFile = fileNameFor(entryPath);
  if (!entryFile) throw new Error('entry_path_invalid');

  const fetched = new Map();
  const fetchPage = async file => {
    if (fetched.has(file)) return fetched.get(file);
    const declared = declaration.files instanceof Map
      ? declaration.files.get(file) : declaration.files?.[file];
    const resourcePath = declared ?? (file === entryFile ? entryPath : null);
    if (!resourcePath) {
      const result = { error: 'sheet_not_declared' };
      fetched.set(file, result);
      return result;
    }
    let acquired;
    try {
      acquired = await acquire(source, resourcePath);
    } catch (error) {
      const result = { error: error?.message ?? 'page_unavailable', source: resourcePath };
      fetched.set(file, result);
      return result;
    }
    const result = {
      bytes: acquired.bytes,
      source: new URL(resourcePath, source).href,
      headers: acquired.headers
    };
    fetched.set(file, result);
    return result;
  };

  const resolved = await resolveHierarchy({
    entryFile,
    fetchPage,
    project: declaration.project,
    isDeclared: file => declaration.files instanceof Map
      ? declaration.files.has(file) : Boolean(declaration.files?.[file]),
    limits
  });

  for (const page of resolved.pages) {
    const loaded = fetched.get(page.file);
    if (!loaded?.bytes) continue;
    let parsed = null;
    try { parsed = inspect(loaded.bytes); } catch { /* reported by the resolver */ }
    page.source = loaded.source;
    if (!store) continue;
    const record = await store.accept(loaded.bytes, loaded.source, parsed);
    page.digest = record.digest;
    page.recordId = record.id;
  }

  return { ...resolved, entrySource: new URL(entryPath, source).href };
}
