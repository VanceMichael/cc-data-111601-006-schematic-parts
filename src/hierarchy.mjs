import { parseSchematic } from './reader.mjs';

export const DEFAULT_LIMITS = { maxPages: 256, maxDepth: 32 };

/** Sheet files are relative to the design, never host paths or URLs. */
export function normalizeSheetFile(value) {
  if (typeof value !== 'string' || !value) return null;
  let file = value.replace(/\\/g, '/');
  while (file.startsWith('./')) file = file.slice(2);
  file = file.replace(/^\/+/, '');
  if (!file) return null;
  const segments = file.split('/');
  if (segments.some(segment => segment === '..' || segment === '')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(file)) return null;
  return file;
}

/** KiCad's full instance path: root UUID followed by the sheet UUID chain. */
function instancePath(rootUuid, chain) {
  return `/${[rootUuid ?? '', ...chain].filter(Boolean).join('/')}`;
}

function samePath(left, right) {
  const normalize = value => typeof value === 'string'
    ? value.replace(/\/+$/, '') || '/' : value;
  return normalize(left) === normalize(right);
}

function resolvedUnit(placement, instance, definition) {
  const declared = definition?.units ?? [];
  const numbered = declared.filter(unit => unit.unit !== 0);
  const requested = instance?.unit ?? placement.unit;
  if (requested !== null && requested !== undefined && requested !== '') {
    const number = Number(requested);
    if (!Number.isInteger(number) || number < 0) return { number: null, reason: 'unit_invalid' };
    // Unit 0 means "not assigned"; fall through to the unambiguous cases.
    if (number !== 0) return { number, reason: null };
  }
  if (numbered.length === 1) return { number: numbered[0].unit, reason: null };
  if (!numbered.length && declared.length) return { number: 0, reason: null };
  return { number: null, reason: numbered.length ? 'unit_missing' : 'library_units_missing' };
}

/**
 * Select the drawn unit body plus unit-0 declarations that apply to every
 * unit. Body style 1 is KiCad's "De Morgan" variant; the base body (0) is
 * preferred when both are declared for a unit.
 */
function unitsFor(librarySymbol, number, requestedBodyStyle = null) {
  const common = librarySymbol.units.filter(unit => unit.unit === 0);
  const numbered = librarySymbol.units.filter(unit => unit.unit !== 0);
  if (!numbered.length) return common.length ? common : null;
  const matching = librarySymbol.units.filter(unit => unit.unit === number);
  if (!matching.length) return null;
  const available = matching.map(unit => unit.bodyStyle ?? 0);
  const requested = requestedBodyStyle === null || requestedBodyStyle === undefined
    || requestedBodyStyle === '' ? null : Number(requestedBodyStyle);
  if (requested !== null && !available.includes(requested)) return null;
  const bodyStyle = requested !== null ? requested : Math.min(...available);
  return [...common, ...matching.filter(unit => (unit.bodyStyle ?? 0) === bodyStyle)];
}

function pinsFor(librarySymbol, number, context) {
  const units = unitsFor(librarySymbol, number, context.bodyStyle);
  if (!units) return null;
  return units.flatMap(unit => unit.pins.map(pin => ({
    number: pin.number,
    name: pin.name,
    type: pin.type,
    shape: pin.shape,
    unit: unit.unit === 0 ? number : unit.unit,
    unitDeclaration: unit.unit,
    bodyStyle: unit.bodyStyle,
    path: context.path,
    symbolUuid: context.symbolUuid,
    reference: context.reference,
    attributes: context.attributes,
    library: librarySymbol.name
  })));
}

/** A reference containing `?` is an unannotated placeholder, not an identity. */
export function isAnnotatedReference(reference) {
  return typeof reference === 'string' && reference.length > 0 && !reference.includes('?');
}

/**
 * Resolve the hierarchy reachable from an entry page.
 *
 * Layers stay distinct on purpose:
 * - `pages` are schematic files, each physical file fetched once.
 * - `libraries` are library-symbol definitions found on those pages.
 * - `placements` are placed-symbol occurrences keyed by full instance path.
 *   The same child file reached through two sheet UUIDs is two placements and
 *   is never merged or deduplicated.
 * - `devices` are procurement parts. Units that carry the same instance-scoped
 *   reference are one chip even when drawn on different pages.
 *
 * Unresolved data is reported, never filled from another page: a missing
 * sheet, missing library definition or unit, missing instance path, missing
 * reference, and sheet cycles all produce an `unresolved` entry carrying the
 * path that could not complete.
 */
export async function resolveHierarchy({ entry, fetchPage, project = null,
  entryFile = null, isDeclared = null, limits = {} } = {}) {
  const { maxPages, maxDepth } = { ...DEFAULT_LIMITS, ...limits };
  const entryKey = normalizeSheetFile(entryFile ?? entry);
  const pages = new Map();
  const pageList = [];
  const libraries = [];
  const placements = [];
  const unresolved = [];
  let fetchCount = 0;
  let rootUuid = null;

  const loadPage = async key => {
    if (!key) return { error: 'sheet_file_missing' };
    if (pages.has(key)) return pages.get(key);
    if (fetchCount >= maxPages) {
      const result = { error: `page_limit_${maxPages}` };
      pages.set(key, result);
      return result;
    }
    fetchCount += 1;
    let loaded;
    try {
      loaded = await fetchPage(key);
    } catch (error) {
      loaded = { error: error?.message ?? 'page_unavailable' };
    }
    if (!loaded || loaded.error) {
      const result = { error: loaded?.error ?? 'page_unavailable' };
      pages.set(key, result);
      return result;
    }
    let page;
    try {
      page = parseSchematic(loaded.bytes);
    } catch (error) {
      const result = { error: `page_invalid_${error?.message ?? 'parse'}` };
      pages.set(key, result);
      return result;
    }
    const result = { page, file: key };
    pages.set(key, result);
    pageList.push({ file: key, uuid: page.uuid, digest: loaded.digest ?? null,
      source: loaded.source ?? null });
    for (const symbol of page.librarySymbols) {
      libraries.push({
        file: key,
        name: symbol.name,
        properties: symbol.propertyMap,
        attributes: symbol.attributes,
        units: symbol.units.map(unit => ({ unit: unit.unit, bodyStyle: unit.bodyStyle,
          pins: unit.pins }))
      });
    }
    return result;
  };

  const walk = async ({ page, file, chain, depth, ancestry }) => {
    const path = instancePath(rootUuid, chain);

    for (const [index, placed] of page.symbols.entries()) {
      const symbolUuid = placed.uuid ?? null;
      const libraryName = placed.library ?? null;
      const base = { kind: 'placement', path, file, symbolUuid, library: libraryName };

      // Instance data is scoped to this exact sheet path and project. Falling
      // back to a sibling path or another project would mix instances, so
      // absence is reported instead.
      const candidates = placed.instances.filter(item => samePath(item.path, path));
      const instance = project === null
        ? candidates[0] ?? null
        : candidates.find(item => item.project === project) ?? null;
      const reference = instance?.reference || placed.propertyMap?.Reference || null;
      const referenceSource = instance?.reference ? 'instances' : 'property';
      // The library definition is looked up on the page that owns the
      // placement only. A same-named symbol from another page is never used.
      const definition = libraryName
        ? page.librarySymbols.find(symbol => symbol.name === libraryName) ?? null : null;
      const unit = resolvedUnit(placed, instance, definition);

      const placement = {
        path,
        file,
        // A page-local sequence disambiguates declarations that lack the UUID
        // which would otherwise be their only identity.
        sequence: index,
        symbolUuid,
        library: libraryName,
        reference,
        referenceSource,
        project: instance?.project ?? project ?? null,
        attributes: placed.attributes,
        properties: placed.propertyMap,
        instance: instance ? { project: instance.project, path: instance.path,
          reference: instance.reference, unit: instance.unit } : null,
        unit: { declared: instance?.unit ?? placed.unit ?? null, resolved: unit.number },
        libraryStatus: 'resolved',
        libraryDefinitionFile: file,
        pins: []
      };
      const libraryUnresolved = reason => {
        placement.libraryStatus = 'unresolved';
        placement.libraryReason = reason;
        unresolved.push({ ...base, reason });
        placements.push(placement);
      };

      if (!symbolUuid) unresolved.push({ ...base, reason: 'symbol_uuid_missing' });
      if (placed.instances.length && !instance) {
        unresolved.push({ ...base, reason: candidates.length
          ? 'instance_project_missing' : 'instance_path_missing',
        declaredPaths: placed.instances.map(item => item.path),
        declaredProjects: [...new Set(placed.instances.map(item => item.project))] });
      }
      if (!reference) unresolved.push({ ...base, reason: 'reference_missing' });
      else if (!isAnnotatedReference(reference)) {
        unresolved.push({ ...base, reason: 'reference_unannotated', reference });
      }

      if (!libraryName) { libraryUnresolved('library_id_missing'); continue; }
      if (!definition) { libraryUnresolved('library_symbol_missing'); continue; }
      if (unit.reason) { libraryUnresolved(unit.reason); continue; }
      const pins = pinsFor(definition, unit.number, {
        path, symbolUuid, reference, attributes: placed.attributes,
        bodyStyle: placed.bodyStyle ?? null
      });
      if (!pins) {
        const requested = placed.bodyStyle;
        libraryUnresolved(requested === null || requested === undefined
          ? 'library_unit_missing' : 'library_body_style_missing');
        continue;
      }
      placement.pins = pins;
      placements.push(placement);
    }

    for (const sheet of page.sheets) {
      const sheetUuid = sheet.uuid ?? null;
      const rawFile = typeof sheet.file === 'string' ? sheet.file : null;
      const sheetFile = normalizeSheetFile(rawFile);
      const sheetPath = instancePath(rootUuid, [...chain, sheetUuid ?? '']);
      const base = { kind: 'sheet', path: sheetPath, parentFile: file, sheetUuid,
        sheetName: sheet.name ?? null, sheetFile: sheetFile ?? rawFile };

      if (!sheetUuid) { unresolved.push({ ...base, reason: 'sheet_uuid_missing' }); continue; }
      if (!rawFile) { unresolved.push({ ...base, reason: 'sheet_file_missing' }); continue; }
      if (!sheetFile) { unresolved.push({ ...base, reason: 'sheet_file_invalid' }); continue; }
      if (isDeclared && !isDeclared(sheetFile)) {
        // Never fetch a file the source catalog did not declare.
        unresolved.push({ ...base, reason: 'sheet_not_declared' });
        continue;
      }
      if (depth + 1 > maxDepth) {
        unresolved.push({ ...base, reason: `sheet_depth_limit_${maxDepth}` });
        continue;
      }
      // Only a page repeating within its own ancestry is a cycle. The same
      // file reached through a different sheet path is a valid second instance.
      if (ancestry.includes(sheetFile)) {
        unresolved.push({ ...base, reason: 'sheet_cycle' });
        continue;
      }
      const loaded = await loadPage(sheetFile);
      if (loaded.error) { unresolved.push({ ...base, reason: loaded.error }); continue; }
      await walk({ page: loaded.page, file: sheetFile, chain: [...chain, sheetUuid],
        depth: depth + 1, ancestry: [...ancestry, sheetFile] });
    }
  };

  if (!entryKey) {
    unresolved.push({ kind: 'page', path: '/', file: entryKey, reason: 'entry_missing' });
    return { project, entry: entryKey, pages: [], libraries: [], placements: [],
      devices: [], unresolved };
  }
  const root = await loadPage(entryKey);
  if (root.error) {
    unresolved.push({ kind: 'page', path: '/', file: entryKey, reason: root.error });
    return { project, entry: entryKey, pages: [], libraries: [], placements: [],
      devices: [], unresolved };
  }
  rootUuid = root.page.uuid;
  await walk({ page: root.page, file: entryKey, chain: [], depth: 0, ancestry: [entryKey] });

  return {
    project,
    entry: entryKey,
    pages: pageList,
    libraries,
    placements,
    devices: groupDevices(placements),
    unresolved
  };
}

function groupingKey(placement) {
  const project = placement.project ?? '';
  if (!isAnnotatedReference(placement.reference)) {
    // Never merge on a placeholder or missing reference.
    return `placement:${project}:${placement.path}:${placement.file}:${placement.sequence ?? ''}:${placement.symbolUuid ?? ''}`;
  }
  // Only an instance-scoped reference is safe to merge across sheet paths.
  // A bare property reference may repeat in every instantiation of a reused
  // child sheet, so it groups units drawn on that same path only.
  return placement.referenceSource === 'instances'
    ? `reference:${project}:${placement.reference}`
    : `reference@${project}:${placement.path}:${placement.reference}`;
}

/**
 * Aggregate placements into procurement devices.
 *
 * A multi-unit chip whose units sit on different pages shares an
 * instance-scoped reference and becomes one device. Placements with a
 * placeholder reference such as `U?` never merge across paths. When the same
 * reference is claimed by different library symbols, the placements stay
 * separate and the ambiguity is reported instead of silently collapsing them.
 */
export function groupDevices(placements) {
  const byIdentity = new Map();
  for (const placement of placements) {
    const key = groupingKey(placement);
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(placement);
  }

  const devices = [];
  for (const group of byIdentity.values()) {
    const libraries = [...new Set(group.map(item => item.library).filter(Boolean))];
    if (libraries.length <= 1) {
      devices.push(buildDevice(group, []));
      continue;
    }
    // Distinct library symbols under one reference are distinct parts; keep
    // them apart and flag the collision on each.
    for (const library of libraries) {
      const subset = group.filter(item => item.library === library);
      devices.push(buildDevice(subset, [{
        reason: 'reference_library_conflict',
        reference: subset[0].reference,
        libraries
      }]));
    }
  }
  return devices;
}

function buildDevice(placements, conflicts) {
  const first = placements[0];
  const device = {
    key: groupingKey(first),
    reference: first.reference,
    referenceAnnotated: isAnnotatedReference(first.reference),
    referenceSource: first.referenceSource,
    project: first.project ?? null,
    libraries: [],
    libraryStatus: 'resolved',
    attributes: {},
    properties: {},
    paths: [],
    placements: [],
    units: [],
    pins: [],
    unresolved: [],
    conflicts: [...conflicts]
  };
  for (const placement of placements) {
    if (!device.libraries.includes(placement.library)) device.libraries.push(placement.library);
    if (!device.paths.includes(placement.path)) device.paths.push(placement.path);
    device.placements.push({
      path: placement.path, file: placement.file, symbolUuid: placement.symbolUuid,
      sequence: placement.sequence,
      library: placement.library, reference: placement.reference, unit: placement.unit,
      libraryStatus: placement.libraryStatus, attributes: placement.attributes,
      properties: placement.properties
    });
    const unitEntry = {
      unit: placement.unit.resolved,
      declaredUnit: placement.unit.declared,
      bodyStyle: placement.pins[0]?.bodyStyle ?? null,
      symbolUuid: placement.symbolUuid,
      path: placement.path,
      file: placement.file,
      reference: placement.reference,
      attributes: placement.attributes,
      properties: placement.properties,
      libraryStatus: placement.libraryStatus,
      pins: placement.pins
    };
    device.units.push(unitEntry);
    device.pins.push(...placement.pins);

    if (placement.libraryStatus !== 'resolved') {
      device.libraryStatus = 'unresolved';
      device.unresolved.push({
        reason: placement.libraryReason ?? 'unresolved',
        kind: 'library',
        path: placement.path,
        symbolUuid: placement.symbolUuid,
        library: placement.library
      });
    }
    if (placement.referenceSource === 'property') {
      device.unresolved.push({ reason: 'reference_from_property', kind: 'reference',
        path: placement.path, symbolUuid: placement.symbolUuid, library: placement.library });
    }
    if (!isAnnotatedReference(placement.reference)) {
      device.unresolved.push({ reason: 'reference_unannotated', kind: 'reference',
        path: placement.path, symbolUuid: placement.symbolUuid, library: placement.library,
        reference: placement.reference });
    }
  }

  device.attributes = mergeDeclarations(placements.map(item => item.attributes));
  device.properties = mergeProperties(placements);

  const seen = new Set();
  for (const unit of device.units) {
    if (unit.unit === null || unit.unit === 0) continue;
    const marker = `${unit.unit}/${unit.bodyStyle ?? ''}`;
    if (seen.has(marker)) {
      device.conflicts.push({ reason: 'duplicate_unit', unit: unit.unit,
        bodyStyle: unit.bodyStyle, path: unit.path });
    }
    seen.add(marker);
  }
  return device;
}

/** Keep original declarations; differing values across units stay visible. */
function mergeDeclarations(declarations) {
  const keys = new Set(declarations.flatMap(item => Object.keys(item ?? {})));
  const result = {};
  for (const key of keys) {
    const values = declarations
      .filter(item => item && item[key] !== undefined)
      .map(item => item[key]);
    const unique = [...new Set(values.map(value => JSON.stringify(value)))];
    result[key] = unique.length === 1 ? values[0] : unique.map(value => JSON.parse(value));
  }
  return result;
}

function mergeProperties(placements) {
  const result = {};
  for (const placement of placements) {
    for (const [name, value] of Object.entries(placement.properties ?? {})) {
      if (!(name in result)) { result[name] = value; continue; }
      if (result[name] === value) continue;
      // A placeholder such as `U?` never overrides an annotated property.
      if (!isAnnotatedReference(result[name]) && isAnnotatedReference(value)) {
        result[name] = value;
        continue;
      }
      if (isAnnotatedReference(value)) {
        // Two different annotated values: keep both traceable.
        const existing = Array.isArray(result[name]) ? result[name] : [result[name]];
        if (!existing.includes(value)) result[name] = [...existing, value];
      }
    }
  }
  return result;
}

export async function collectParts(options) {
  return resolveHierarchy(options);
}
