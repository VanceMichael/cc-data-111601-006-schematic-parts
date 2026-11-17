import { createHash } from 'node:crypto';
import { inspect } from './reader.mjs';

export const HIERARCHY_KINDS = {
  MISSING_PAGE: 'missing_page',
  INVALID_PAGE: 'invalid_page',
  MISSING_LIBRARY: 'missing_library',
  CYCLE: 'cycle',
  INSTANCE_MISMATCH: 'instance_mismatch',
  UNIT_MISMATCH: 'unit_mismatch',
  DUPLICATE_SHEET_UUID: 'duplicate_sheet_uuid',
  DUPLICATE_PLACEMENT: 'duplicate_placement',
  ASSEMBLY_CONFLICT: 'assembly_conflict'
};
const {
  MISSING_PAGE, INVALID_PAGE, MISSING_LIBRARY, CYCLE,
  INSTANCE_MISMATCH, UNIT_MISMATCH, DUPLICATE_SHEET_UUID, DUPLICATE_PLACEMENT,
  ASSEMBLY_CONFLICT
} = HIERARCHY_KINDS;

const normalizeFile = file => String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
const directoryOf = file => {
  const index = normalizeFile(file).lastIndexOf('/');
  return index < 0 ? '' : normalizeFile(file).slice(0, index);
};
const joinFile = (directory, file) => {
  const output = [];
  for (const part of `${directory ? `${directory}/` : ''}${normalizeFile(file)}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') output.pop(); else output.push(part);
  }
  return output.join('/');
};
const childPath = (parent, uuid) => `${parent === '/' ? '' : parent}/${uuid}`;
const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');

function libraryBodiesFor(library, unit, bodyStyle) {
  const bodies = library?.bodies ?? [];
  // KiCad matches unit 0 (common) bodies to every unit and fully populated
  // symbols carry one body per unit and style. Do not cross-substitute a
  // different unit or a missing De Morgan style.
  return bodies.filter(body =>
    (body.unit === unit || body.unit === 0) &&
    (body.body_style === bodyStyle || body.body_style === 0));
}
function libraryHasUnit(library, unit) {
  const bodies = library?.bodies ?? [];
  if (!bodies.length) return false;
  // Symbols that only declare common (unit 0) bodies are single-unit parts;
  // their unit 1 is present even though no numbered body exists.
  if (!bodies.some(body => body.unit > 0)) return unit === 1 || unit === 0;
  return bodies.some(body => body.unit === unit);
}
function libraryUnitNumbers(library) {
  const bodies = library?.bodies ?? [];
  const numbered = [...new Set(bodies.map(body => body.unit).filter(unit => unit > 0))]
    .sort((left, right) => left - right);
  return numbered.length ? numbered : (bodies.length ? [1] : []);
}
function libraryPinsFor(library, unit, bodyStyle) {
  return libraryBodiesFor(library, unit, bodyStyle).flatMap(body => body.pins.map(pin => ({
    ...pin, body_unit: body.unit, body_style: body.body_style
  })));
}
const placeholderReference = reference =>
  typeof reference !== 'string' || reference.length === 0 || reference.includes('?');
const concreteReference = value =>
  typeof value === 'string' && value.length > 0 && !value.includes('?') ? value : null;
const propertyOf = (properties, name) => {
  const wanted = String(name).toLowerCase().replace(/[\s_-]+/g, '');
  return (properties ?? []).find(([key]) =>
    String(key).toLowerCase().replace(/[\s_-]+/g, '') === wanted)?.[1] ?? null;
};

// A placed symbol may carry several path declarations; select only the one
// belonging to the concrete instance path being expanded. KiCad writes the
// root as "/<root uuid>"; older or hand-written files may use "/".
function declarationFor(symbol, project, instancePath, rootPath) {
  const candidates = (symbol.instances ?? []).filter(instance =>
    instance.path === instancePath ||
    (instancePath === rootPath && instance.path === '/'));
  return candidates.find(instance => project === null || instance.project === null ||
    instance.project === project) ?? candidates[0] ?? null;
}

// Resolve a sheet's relative Sheetfile against the catalog's project-relative
// file map. The map is delivered by the source and is the only mapping we use;
// an unmapped sheet stays unresolved rather than being guessed from a URL.
function resolveSheetTarget(page, sheetFile, files) {
  const direct = normalizeFile(sheetFile);
  if (!direct) return null;
  const candidates = [direct];
  for (const base of [page.key, page.urlPath]) {
    if (base) candidates.push(joinFile(directoryOf(base), direct));
  }
  for (const candidate of candidates) {
    if (Object.hasOwn(files, candidate)) return { key: candidate, url: files[candidate] };
  }
  // Catalogs may key files by URL path while sheets use project-relative names.
  for (const [key, url] of Object.entries(files)) {
    if (candidates.includes(normalizeFile(url)) || candidates.includes(normalizeFile(key))) {
      return { key: normalizeFile(key), url };
    }
  }
  return null;
}

function pageFailureKind(message) {
  return ['schematic_root', 'multiple_roots', 'unbalanced_document',
    'unbalanced_close', 'atom_outside_root'].includes(message) ? INVALID_PAGE : MISSING_PAGE;
}

export async function resolveHierarchy({
  project = null, entry, files = {}, fetchPage
} = {}) {
  if (typeof fetchPage !== 'function') throw new Error('fetch_page_required');
  if (typeof entry !== 'string' || !entry) throw new Error('entry_required');

  const pending = [];
  const pages = new Map();
  const loads = new Map();
  const placements = [];
  const sheets = [];
  const devices = new Map();
  const librarySymbols = [];
  const visitedSheetPaths = new Set();
  const entryFile = normalizeFile(entry);
  let entryUuid = null;

  const loadPage = async ({ key, urlPath }) => {
    // A sheet's identity is the delivered file, so the same URL reached under
    // two catalog keys is one page, and re-entering it is a cycle.
    const canonical = normalizeFile(urlPath);
    if (loads.has(canonical)) return loads.get(canonical);
    const operation = (async () => {
      const bytes = await fetchPage({ key, path: key, urlPath, url: urlPath });
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const parsed = inspect(buffer);
      const page = {
        key: key ?? canonical, urlPath, canonical, uuid: parsed.uuid ?? null,
        digest: digestOf(buffer), parsed
      };
      pages.set(canonical, page);
      for (const library of parsed.library_symbols) {
        librarySymbols.push({
          name: library.name, extends: library.extends ?? null,
          page: page.key, source: urlPath,
          units: libraryUnitNumbers(library),
          bodies: library.bodies, pins: library.pins
        });
      }
      return page;
    })();
    loads.set(canonical, operation);
    try {
      return await operation;
    } catch (error) {
      loads.delete(canonical);
      throw error;
    }
  };

  const libraryMaps = new Map();
  const libraryMapFor = page => {
    if (libraryMaps.has(page.key)) return libraryMaps.get(page.key);
    const raw = new Map();
    for (const library of page.parsed.library_symbols) {
      if (raw.has(library.name)) {
        pending.push({
          kind: MISSING_LIBRARY, reason: 'duplicate_library_symbol',
          page: page.key, library: library.name
        });
        continue;
      }
      raw.set(library.name, library);
    }
    const resolved = new Map();
    for (const library of raw.values()) {
      // "extends" derives a symbol from another one on the same page. Resolve
      // it within that page only; never borrow a definition from another page.
      const seen = new Set([library.name]);
      let current = library;
      let inherited = null;
      while (current.extends) {
        if (seen.has(current.extends)) {
          pending.push({
            kind: MISSING_LIBRARY, reason: 'library_extends_cycle',
            page: page.key, library: library.name, extends: current.extends
          });
          break;
        }
        seen.add(current.extends);
        const parent = raw.get(current.extends);
        if (!parent) {
          pending.push({
            kind: MISSING_LIBRARY, reason: 'library_extends_absent',
            page: page.key, library: library.name, extends: current.extends
          });
          break;
        }
        current = parent;
        inherited = parent;
      }
      // KiCad derived symbols normally repeat their unit bodies; when only the
      // base carries them the derived symbol inherits them.
      const effective = library.bodies.length
        ? library : { ...library, bodies: inherited?.bodies ?? [], pins: inherited?.pins ?? [] };
      resolved.set(library.name, effective);
    }
    libraryMaps.set(page.key, resolved);
    return resolved;
  };

  const addPlacement = ({ page, symbol, instancePath, rootPath, libraryMap }) => {
    const declaration = declarationFor(symbol, project, instancePath, rootPath);
    const reference = concreteReference(declaration?.reference) ??
      concreteReference(propertyOf(symbol.properties, 'Reference'));
    const unit = declaration?.unit ?? symbol.unit_number ?? 1;
    const bodyStyle = symbol.convert_number ?? 1;
    const libraryId = symbol.lib_id ?? symbol.library ?? null;
    const library = libraryId === null ? null : libraryMap.get(libraryId) ?? null;
    const assembly = { ...symbol.assembly };
    const placement = {
      path: instancePath,
      page: page.key,
      source: page.urlPath,
      page_uuid: page.uuid,
      symbol_uuid: symbol.uuid,
      library: libraryId,
      reference,
      reference_source: concreteReference(declaration?.reference)
        ? 'instances' : (reference ? 'property' : null),
      unit,
      body_style: bodyStyle,
      properties: symbol.properties,
      assembly,
      library_units: library ? libraryUnitNumbers(library) : [],
      library_resolved: Boolean(library),
      pins: [],
      status: reference ? 'resolved' : 'unresolved'
    };

    if (!declaration) {
      const hasDeclaration = (symbol.instances ?? []).length > 0;
      if (!reference) {
        pending.push({
          kind: INSTANCE_MISMATCH, reason: 'reference_absent',
          path: instancePath, page: page.key, symbol: symbol.uuid,
          library: libraryId,
          declared_paths: (symbol.instances ?? []).map(item => item.path).filter(Boolean)
        });
      } else if (!hasDeclaration) {
        // The placed property names a device but no path declaration ties it
        // to this concrete instance. Keep it, but make that provenance explicit
        // instead of pretending the path declaration exists.
        pending.push({
          kind: INSTANCE_MISMATCH, reason: 'path_declaration_absent',
          path: instancePath, page: page.key, symbol: symbol.uuid,
          library: libraryId, reference
        });
      } else {
        pending.push({
          kind: INSTANCE_MISMATCH, reason: 'path_declaration_absent',
          path: instancePath, page: page.key, symbol: symbol.uuid,
          library: libraryId, reference,
          declared_paths: (symbol.instances ?? []).map(item => item.path).filter(Boolean)
        });
      }
    } else if (placeholderReference(declaration.reference) && !reference) {
      placement.status = 'unresolved';
      pending.push({
        kind: INSTANCE_MISMATCH, reason: 'reference_placeholder',
        path: instancePath, page: page.key, symbol: symbol.uuid,
        library: libraryId, reference: declaration.reference
      });
    } else if (placeholderReference(declaration.reference)) {
      // The path declaration is still a placeholder even though the placed
      // property names a device. Keep the concrete property label but record
      // that the path declaration itself was not usable.
      pending.push({
        kind: INSTANCE_MISMATCH, reason: 'declaration_placeholder_fallback',
        path: instancePath, page: page.key, symbol: symbol.uuid,
        library: libraryId, reference,
        declared_reference: declaration.reference
      });
    }

    if (!library) {
      pending.push({
        kind: MISSING_LIBRARY, reason: 'library_definition_absent',
        path: instancePath, page: page.key, symbol: symbol.uuid,
        library: libraryId, reference: reference ?? null
      });
      // The placed symbol's own pin nodes are still traceable declarations for
      // this instance; keep them, marked as lacking a library definition.
      placement.pins = (symbol.pins ?? [])
        .filter(pin => pin.number !== null && pin.number !== undefined)
        .map(pin => ({
          number: pin.number, name: null, electrical_type: null,
          graphic_style: null, hidden: false, unit, body_style: bodyStyle,
          alternate: pin.alternate ?? null, library_defined: false
        }));
      placement.status = 'unresolved';
      placements.push(placement);
      return placement;
    }
    if (!libraryHasUnit(library, unit)) {
      placement.status = 'unresolved';
      pending.push({
        kind: UNIT_MISMATCH, reason: 'unit_absent_from_library',
        path: instancePath, page: page.key, symbol: symbol.uuid,
        library: libraryId, reference: reference ?? null, unit,
        library_units: libraryUnitNumbers(library)
      });
    }
    const declaredPins = new Map((symbol.pins ?? []).map(pin => [pin.number, pin]));
    placement.pins = libraryPinsFor(library, unit, bodyStyle).map(pin => ({
      number: pin.number,
      name: pin.name,
      electrical_type: pin.electrical_type,
      graphic_style: pin.graphic_style,
      hidden: pin.hidden,
      unit,
      // A pin inherited from a common (unit 0) body belongs to every unit, so
      // the placement's own unit is the correct instance attribution.
      source_unit: pin.body_unit,
      body_style: pin.body_style,
      alternate: declaredPins.get(pin.number)?.alternate ?? null,
      library_defined: true
    }));
    if (!placement.pins.length) {
      // The unit exists but carries no resolved pins; fall back to the pin
      // nodes placed for this instance rather than borrowing another unit.
      placement.pins = [...declaredPins.values()]
        .filter(pin => pin.number !== null && pin.number !== undefined)
        .map(pin => ({
          number: pin.number, name: null, electrical_type: null,
          graphic_style: null, hidden: false, unit, body_style: bodyStyle,
          alternate: pin.alternate ?? null, library_defined: false
        }));
    }
    const libraryNumbers = new Set(placement.pins
      .filter(pin => pin.library_defined).map(pin => pin.number));
    if (libraryNumbers.size) {
      for (const number of declaredPins.keys()) {
        if (number !== null && !libraryNumbers.has(number)) {
          pending.push({
            kind: UNIT_MISMATCH, reason: 'pin_absent_from_library_unit',
            path: instancePath, page: page.key, symbol: symbol.uuid,
            library: libraryId, reference: reference ?? null,
            unit, pin: number
          });
        }
      }
    }
    placements.push(placement);
    return placement;
  };

  const addDevice = placement => {
    if (!placement.reference) return;
    const id = `${project ?? ''}\u0000${placement.reference}`;
    if (!devices.has(id)) {
      devices.set(id, {
        reference: placement.reference, project,
        units: new Map(), placements: [], pins: [],
        values: new Set(), footprints: new Set(),
        assembly: { dnp: new Set(), in_bom: new Set(), on_board: new Set() }
      });
    }
    const device = devices.get(id);
    const unitKey = String(placement.unit);
    device.units.set(unitKey, (device.units.get(unitKey) ?? 0) + 1);
    device.placements.push(placement);
    const value = propertyOf(placement.properties, 'Value');
    const footprint = propertyOf(placement.properties, 'Footprint');
    if (value !== null) device.values.add(value);
    if (footprint !== null) device.footprints.add(footprint);
    for (const field of ['dnp', 'in_bom', 'on_board']) {
      const declared = placement.assembly[field];
      if (declared !== null && declared !== undefined) device.assembly[field].add(declared);
    }
    for (const pin of placement.pins) {
      device.pins.push({
        reference: placement.reference,
        unit: pin.unit,
        body_style: pin.body_style,
        number: pin.number,
        name: pin.name,
        electrical_type: pin.electrical_type,
        graphic_style: pin.graphic_style,
        hidden: pin.hidden,
        alternate: pin.alternate,
        library_defined: pin.library_defined ?? true,
        path: placement.path,
        page: placement.page,
        source: placement.source,
        symbol_uuid: placement.symbol_uuid,
        library: placement.library,
        assembly: placement.assembly
      });
    }
  };

  const walk = async (page, instancePath, chain) => {
    const pageId = page.key;
    if (chain.includes(pageId)) {
      pending.push({
        kind: CYCLE, sheet_path: instancePath, page: pageId,
        chain: [...chain, pageId]
      });
      return;
    }
    const nextChain = [...chain, pageId];
    const libraryMap = libraryMapFor(page);
    const rootPath = `/${page.uuid}`;
    for (const symbol of page.parsed.symbols) {
      addDevice(addPlacement({ page, symbol, instancePath, rootPath, libraryMap }));
    }
    for (const sheet of page.parsed.sheets) {
      if (!sheet.uuid) {
        pending.push({
          kind: MISSING_PAGE, reason: 'sheet_uuid_absent', page: pageId,
          sheet_name: sheet.name, sheet_file: sheet.file
        });
        continue;
      }
      const sheetPath = childPath(instancePath, sheet.uuid);
      const target = sheet.file
        ? resolveSheetTarget(page, sheet.file, files) : null;
      sheets.push({
        uuid: sheet.uuid, name: sheet.name, file: sheet.file, page: pageId,
        parent_path: instancePath, path: sheetPath,
        source: target?.url ?? null, project_path: target?.key ?? null
      });
      if (visitedSheetPaths.has(sheetPath)) {
        pending.push({
          kind: DUPLICATE_SHEET_UUID, sheet_path: sheetPath, page: pageId,
          sheet_uuid: sheet.uuid, sheet_file: sheet.file
        });
        continue;
      }
      visitedSheetPaths.add(sheetPath);
      if (!sheet.file) {
        pending.push({
          kind: MISSING_PAGE, reason: 'sheet_file_absent', sheet_path: sheetPath,
          page: pageId, sheet_uuid: sheet.uuid, sheet_name: sheet.name
        });
        continue;
      }
      if (!target) {
        pending.push({
          kind: MISSING_PAGE, reason: 'sheet_file_unmapped', sheet_path: sheetPath,
          page: pageId, sheet_uuid: sheet.uuid, sheet_name: sheet.name,
          sheet_file: sheet.file
        });
        continue;
      }
      let child;
      try {
        child = await loadPage({ key: target.key, urlPath: target.url });
      } catch (error) {
        pending.push({
          kind: pageFailureKind(error.message), reason: error.message,
          sheet_path: sheetPath, page: pageId, sheet_uuid: sheet.uuid,
          sheet_name: sheet.name, sheet_file: sheet.file,
          source: target.url, chain: [...nextChain]
        });
        continue;
      }
      await walk(child, sheetPath, nextChain);
    }
  };

  try {
    const root = await loadPage({ key: entryFile, urlPath: entry });
    entryUuid = root.uuid;
    await walk(root, `/${entryUuid}`, []);
  } catch (error) {
    pending.push({
      kind: pageFailureKind(error.message), reason: error.message,
      page: entryFile, source: entry, sheet_path: '/'
    });
    return emptyResult({ project, entry: entryFile, pending });
  }

  const results = [...devices.values()].map(device => {
    const unitNumbers = [...device.units.keys()].map(Number).sort((left, right) => left - right);
    const libraryUnits = [...new Set(device.placements.flatMap(item => item.library_units))]
      .sort((left, right) => left - right);
    const pins = device.pins.slice().sort(comparePins);
    return {
      reference: device.reference,
      project: device.project,
      value: collapse(device.values),
      footprint: collapse(device.footprints),
      units: unitNumbers.map(unit => ({
        unit,
        placements: device.placements.filter(item => item.unit === unit).length,
        pins: pins.filter(pin => pin.unit === unit)
      })),
      library_units: libraryUnits,
      // Units the library declares that this device does not place. This is
      // informational: a delivery need not use every unit of a multi-unit part.
      unplaced_library_units: libraryUnits.filter(unit => !device.units.has(String(unit))),
      placements: device.placements,
      pins,
      assembly: {
        dnp: collapseSet(device.assembly.dnp),
        in_bom: collapseSet(device.assembly.in_bom),
        on_board: collapseSet(device.assembly.on_board)
      },
      // Whether the device should be ordered is the purchaser's decision; we
      // only report the declarations and any disagreement between placements.
      assembly_conflict: ['dnp', 'in_bom', 'on_board']
        .filter(field => device.assembly[field].size > 1)
    };
  });
  for (const device of results) {
    device.placements.sort(comparePlacements);
  }
  results.sort((left, right) => compareText(left.reference, right.reference));

  const duplicates = duplicatePins(results);
  for (const duplicate of duplicates) {
    pending.push({ kind: DUPLICATE_PLACEMENT, reason: 'unit_on_multiple_placements', ...duplicate });
  }
  for (const device of results) {
    for (const field of device.assembly_conflict) {
      pending.push({
        kind: ASSEMBLY_CONFLICT, reason: `${field}_declared_differently`,
        reference: device.reference, field, values: device.assembly[field],
        placements: device.placements.map(item => ({
          path: item.path, symbol_uuid: item.symbol_uuid, value: item.assembly[field]
        }))
      });
    }
  }
  // Finish the follow-up lead for missing library definitions once every page
  // has been read. These pages are only a pointer for investigation; a
  // definition on another page is never substituted for the missing one.
  for (const item of pending) {
    if (item.kind !== MISSING_LIBRARY || item.library === undefined) continue;
    // Pages that declare a symbol with this name anywhere in the delivered
    // hierarchy. They are investigation leads only; none were used here.
    item.declaring_pages = [...new Set(librarySymbols
      .filter(library => library.name === item.library)
      .map(library => library.page))].sort(compareText);
  }

  return {
    project,
    entry: entryFile,
    root_uuid: entryUuid,
    pages: [...pages.values()].map(page => ({
      key: page.key, source: page.urlPath, uuid: page.uuid, digest: page.digest,
      placements: page.parsed.symbols.length,
      sheets: page.parsed.sheets.length,
      library_symbols: page.parsed.library_symbols.length
    })).sort((left, right) => compareText(left.key, right.key)),
    library_symbols: librarySymbols,
    sheets: sheets.sort((left, right) => compareText(left.path, right.path)),
    placements: placements.sort(comparePlacements),
    instances: placements,
    devices: results,
    duplicates,
    unresolved: pending,
    pending
  };
}

function emptyResult({ project, entry, pending }) {
  return {
    project, entry, root_uuid: null, pages: [], library_symbols: [],
    sheets: [], placements: [], instances: [], devices: [],
    duplicates: [], unresolved: pending, pending
  };
}

function collapse(values) {
  if (!values.size) return null;
  return values.size === 1 ? [...values][0] : [...values];
}
function collapseSet(values) {
  if (!values.size) return null;
  return values.size === 1 ? [...values][0] : [...values];
}
// localeCompare applies linguistic collation that discards control characters
// and ignores case; hierarchy paths need deterministic code-unit ordering.
const compareText = (left, right) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
function comparePins(left, right) {
  return compareText(`${left.path}\u0000${String(left.unit).padStart(6, '0')}\u0000${left.number ?? ''}`,
    `${right.path}\u0000${String(right.unit).padStart(6, '0')}\u0000${right.number ?? ''}`);
}
function comparePlacements(left, right) {
  return compareText(`${left.path}\u0000${left.symbol_uuid}`,
    `${right.path}\u0000${right.symbol_uuid}`);
}
function duplicatePins(devices) {
  const found = [];
  for (const device of devices) {
    // The same unit placed twice on one concrete path declares the same
    // physical unit twice; that is a placement conflict, not a valid multi-unit
    // device. Different paths stay independent even when the file is shared.
    const map = new Map();
    for (const placement of device.placements) {
      const key = `${placement.unit}\u0000${placement.body_style}`;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(`${placement.path}\u0000${placement.symbol_uuid}`);
    }
    for (const [key, placements] of map) {
      if (placements.size < 2) continue;
      const [unit, bodyStyle] = key.split('\u0000');
      found.push({
        reference: device.reference, unit: Number(unit),
        body_style: Number(bodyStyle),
        paths: [...placements].map(value => value.split('\u0000')[0]).sort(compareText),
        placements: [...placements].map(value => {
          const [path, symbol] = value.split('\u0000');
          return { path, symbol_uuid: symbol };
        }).sort((left, right) => compareText(left.path, right.path))
      });
    }
  }
  return found;
}
export const collectHierarchy = resolveHierarchy;
export const resolveProject = resolveHierarchy;
export const inspectHierarchy = resolveHierarchy;
