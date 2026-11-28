import {
  compileFeatureExpression,
  extrusionBaseValue,
  extrusionColorValue,
  extrusionFloorHeightValue,
  type LayerStyle,
} from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import { isSlicedPolarGeometry, slicePoleWrappingPolygons } from "./cesium-polar-polygons";
import type { Color } from "@cesium/core";
import type { CesiumWidget, DataSource, Entity } from "@cesium/engine";

type CesiumNs = typeof import("@cesium/engine");

// --- GeoJSON entities -------------------------------------------------------
// The per-entity passes behind CesiumLayerSync.createGeoJson.

/**
 * The private property that carries a feature's index onto its entities.
 * Cesium splits multipart geometries into several entities. A private
 * property survives that split; feature ids alone do not (Cesium suffixes them).
 */
export const FEATURE_INDEX_KEY = "__geolibre_cesium_feature_index";

/**
 * A copy of `collection` without the legacy GeoJSON 2008 `crs` member.
 *
 * Layer GeoJSON is always longitude/latitude WGS 84 (the 2D engines draw it
 * as such and ignore `crs`), but files often keep the member their writer
 * added. Cesium's GeoJsonDataSource only knows three spellings of it and
 * throws "Unknown crs name" on the rest, so a layer naming
 * `urn:ogc:def:crs:OGC::CRS84` (GDAL's spelling) failed to load on the globe
 * (#3476). Dropping it makes Cesium read the coordinates as lon/lat, exactly
 * as the 2D map does.
 *
 * @param collection - The layer's FeatureCollection.
 * @returns The collection itself when it has no `crs`, else a shallow copy without it.
 */
export function withoutGeoJsonCrs(collection: FeatureCollection): FeatureCollection {
  if (!("crs" in collection)) return collection;
  const copy: FeatureCollection & { crs?: unknown } = { ...collection };
  delete copy.crs;
  return copy;
}

/**
 * A copy of `collection` whose features carry a stable id and their index
 * (under {@link FEATURE_INDEX_KEY}), so each entity maps back to its feature.
 * The legacy `crs` member is dropped (see {@link withoutGeoJsonCrs}), and a
 * polygon that goes round a pole is cut into slices Cesium can triangulate
 * (see {@link slicePoleWrappingPolygons}).
 */
export function indexedFeatureCollection(
  layerId: string,
  collection: FeatureCollection,
): FeatureCollection {
  return {
    ...withoutGeoJsonCrs(collection),
    features: collection.features.map((feature, index) => ({
      ...slicePoleWrappingPolygons(feature),
      id: JSON.stringify([layerId, index]),
      properties: { ...feature.properties, [FEATURE_INDEX_KEY]: index },
    })),
  };
}

/**
 * Turn off the outline of every polygon entity cut from a pole-wrapping
 * polygon. Each slice is its own polygon, so its outline would also trace the
 * cut meridians from the coast to the pole, lines that are not in the data.
 * (A ground-clamped polygon has no outline anyway; this matters for extruded
 * or Z-carrying layers.)
 *
 * @param viewer The globe, for reading entity properties.
 * @param dataSource The loaded data source.
 * @param loaded The collection handed to Cesium (see {@link indexedFeatureCollection}).
 */
export function hideSlicedPolygonOutlines(
  viewer: CesiumWidget,
  dataSource: DataSource,
  loaded: FeatureCollection,
): void {
  const sliced = new Set<number>();
  loaded.features.forEach((feature, index) => {
    // Only real slices: a polygon merely pulled off the pole keeps its outline.
    if (isSlicedPolarGeometry(feature.geometry)) sliced.add(index);
  });
  if (sliced.size === 0) return;
  for (const entity of dataSource.entities.values) {
    if (!entity.polygon || !sliced.has(entityFeatureIndex(viewer, entity))) continue;
    entity.polygon.outline = false as never;
  }
}

/** The feature index an entity carries (see {@link indexedFeatureCollection}). */
export function entityFeatureIndex(viewer: CesiumWidget, entity: Entity): number {
  const propIndex = entity.properties?.[FEATURE_INDEX_KEY];
  return typeof propIndex?.getValue === "function"
    ? propIndex.getValue(viewer.clock?.currentTime)
    : propIndex;
}

/** How the height passes write entity graphics properties. */
interface EntityHeightWriters {
  /** `HeightReference.RELATIVE_TO_GROUND`. */
  heightRef: number;
  /** Wraps a value in a `ConstantProperty` when Cesium provides one. */
  makeProp: (v: unknown) => unknown;
  /** Wraps a colour in a `ColorMaterialProperty` when Cesium provides one. */
  makeMat: (c: unknown) => unknown;
  /** Whether a polygon keeps each vertex's own height (see below). */
  perPositionHeight: (polygon: { perPositionHeight?: unknown }) => boolean;
}

/**
 * The property writers the extrusion and 3D-elevation passes share.
 *
 * Cesium flags a polygon whose ring carries Z as perPositionHeight and then
 * ignores height/heightReference on it (with a one-time console warning),
 * keeping each vertex's own ellipsoid height. Only flat polygons take the
 * terrain-relative references.
 */
export function entityHeightWriters(Cesium: CesiumNs, viewer: CesiumWidget): EntityHeightWriters {
  const heightRef = (Cesium.HeightReference?.RELATIVE_TO_GROUND ?? 2) as number;
  const ConstantProperty = (Cesium as { ConstantProperty?: new (v: unknown) => unknown })
    .ConstantProperty;
  const ColorMaterialProperty = (
    Cesium as {
      ColorMaterialProperty?: new (c: unknown) => unknown;
    }
  ).ColorMaterialProperty;
  const makeProp = (v: unknown) => (ConstantProperty ? new ConstantProperty(v) : v);
  const makeMat = (c: unknown) =>
    ColorMaterialProperty ? new ColorMaterialProperty(c) : { color: c };
  const perPositionHeight = (polygon: { perPositionHeight?: unknown }): boolean => {
    const prop = polygon.perPositionHeight as
      | { getValue?: (time: unknown) => unknown }
      | boolean
      | undefined;
    return Boolean(
      typeof prop === "object" && typeof prop.getValue === "function"
        ? prop.getValue(viewer.clock?.currentTime)
        : prop,
    );
  };
  return { heightRef, makeProp, makeMat, perPositionHeight };
}

/** Highest Z on a polygon feature's rings (0 when none carries a height). */
function ringTopAltitude(feature: Feature | null): number {
  const geometry = feature?.geometry;
  const polygons =
    geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  let top = Number.NEGATIVE_INFINITY;
  for (const rings of polygons)
    for (const ring of rings)
      for (const position of ring) {
        const z = position[2];
        if (typeof z === "number" && Number.isFinite(z) && z > top) top = z;
      }
  return Number.isFinite(top) ? top : 0;
}

/** Whether a serialized expression reads `["zoom"]`. */
const ZOOM_OPERAND = /\[\s*"zoom"\s*\]/;

/** A compiled per-feature extrusion expression, evaluated at a camera zoom. */
type ExtrusionEvaluator = (f: Feature, zoom: number) => unknown;

/** The compiled extrusion expressions {@link compileExtrusionEvaluators} returns. */
interface ExtrusionEvaluators {
  heightEvaluator: ExtrusionEvaluator | undefined;
  baseEvaluator: ExtrusionEvaluator | undefined;
  colorEvaluator: ExtrusionEvaluator | undefined;
  zoomDependent: boolean;
}

/**
 * Compiled evaluators keyed by the expression sources they were built from,
 * so a settle-time re-run reuses them and an in-place style edit can never be
 * served stale ones. Bounded: cleared when it grows past a handful of styles.
 */
const compiledExtrusions = new Map<string, ExtrusionEvaluators>();
const MAX_COMPILED_EXTRUSIONS = 64;

/**
 * The extrusion's optional per-feature height, base and colour expressions,
 * compiled once per distinct set of sources; each is undefined when unset or invalid.
 * `zoomDependent` is true when any compiled one reads `["zoom"]`, so the
 * extrusion has to be re-run as the camera zooms (#3346).
 */
function compileExtrusionEvaluators(
  style: LayerStyle,
  extColorVal: ReturnType<typeof extrusionColorValue>,
  baseVal: ReturnType<typeof extrusionBaseValue>,
): ExtrusionEvaluators {
  const heightSource =
    style.extrusionAdvancedStyleEnabled && style.extrusionHeightExpression
      ? style.extrusionHeightExpression
      : "";
  let colorExprStr: string | null = null;
  if (typeof extColorVal !== "string") {
    colorExprStr = JSON.stringify(extColorVal);
  } else if (style.extrusionAdvancedStyleEnabled && style.extrusionColorExpression) {
    colorExprStr = style.extrusionColorExpression;
  }
  const baseSource = Array.isArray(baseVal) ? JSON.stringify(baseVal) : "";
  const cacheKey = JSON.stringify([heightSource, colorExprStr ?? "", baseSource]);
  const cached = compiledExtrusions.get(cacheKey);
  if (cached) return cached;
  let zoomDependent = false;
  const compile = (
    source: string,
    expectedType: "number" | "color",
  ): ExtrusionEvaluator | undefined => {
    const res = compileFeatureExpression(source, { expectedType });
    if (!res.ok || !res.evaluate) return undefined;
    if (ZOOM_OPERAND.test(source)) zoomDependent = true;
    return res.evaluate;
  };

  const heightEvaluator = heightSource ? compile(heightSource, "number") : undefined;
  const colorEvaluator = colorExprStr ? compile(colorExprStr, "color") : undefined;
  const baseEvaluator = baseSource ? compile(baseSource, "number") : undefined;
  const compiled = { heightEvaluator, baseEvaluator, colorEvaluator, zoomDependent };
  if (compiledExtrusions.size >= MAX_COMPILED_EXTRUSIONS) compiledExtrusions.clear();
  compiledExtrusions.set(cacheKey, compiled);
  return compiled;
}

/** Whether a layer's Cesium extrusion reads `["zoom"]` in its height, base or colour. */
export function extrusionIsZoomDependent(style: LayerStyle): boolean {
  if (!style.extrusionEnabled) return false;
  return compileExtrusionEvaluators(style, extrusionColorValue(style), extrusionBaseValue(style))
    .zoomDependent;
}

/** The values {@link applyGeoJsonExtrusion} last wrote to an entity. */
interface AppliedExtrusion {
  extrudedHeight: number;
  base: number;
  colorKey: string;
}

/** Per-entity record of the last extrusion write, so a re-run skips unchanged entities. */
const appliedExtrusions = new WeakMap<Entity, AppliedExtrusion>();

/** A polygon's hierarchy as the data source loaded it, before any base offset. */
const loadedHierarchies = new WeakMap<Entity, unknown>();

interface HierarchyLike {
  positions?: unknown[];
  holes?: HierarchyLike[];
}

/** The Cesium members {@link offsetHierarchy} uses (any may be absent in a stub). */
interface HierarchyGeodesy {
  Cartographic?: {
    fromCartesian?: (p: unknown) => { longitude: number; latitude: number; height: number };
  };
  Cartesian3?: { fromRadians?: (lon: number, lat: number, h: number) => unknown };
  PolygonHierarchy?: new (positions: unknown[], holes: unknown[]) => HierarchyLike;
}

/**
 * Raise every vertex of a polygon hierarchy by `offset` metres along the
 * ellipsoid normal (holes included). Returns null when Cesium lacks the
 * geodesy helpers or the hierarchy has no positions.
 */
function offsetHierarchy(
  Cesium: CesiumNs,
  hierarchy: HierarchyLike,
  offset: number,
): HierarchyLike | null {
  const { Cartographic, Cartesian3, PolygonHierarchy } = Cesium as unknown as HierarchyGeodesy;
  if (!Cartographic?.fromCartesian || !Cartesian3?.fromRadians || !PolygonHierarchy) return null;
  const fromCartesian = Cartographic.fromCartesian;
  const fromRadians = Cartesian3.fromRadians;
  const lift = (h: HierarchyLike): HierarchyLike | null => {
    if (!Array.isArray(h.positions)) return null;
    const positions = h.positions.map((p) => {
      const c = fromCartesian(p);
      return fromRadians(c.longitude, c.latitude, c.height + offset);
    });
    // A hole that cannot be lifted fails the whole hierarchy: dropping it
    // would fill the hole and still record the base as applied.
    const holes: HierarchyLike[] = [];
    for (const hole of h.holes ?? []) {
      const lifted = lift(hole);
      if (!lifted) return null;
      holes.push(lifted);
    }
    return new PolygonHierarchy(positions, holes);
  };
  return lift(hierarchy);
}

/**
 * Move the floor of a polygon with Z coordinates (`perPositionHeight`) up by
 * the resolved base. Cesium takes each vertex's own height as the floor there
 * and ignores `polygon.height`, so the base is added to the vertices
 * themselves; the hierarchy as loaded is kept so a later pass (a zoom step, a
 * restyle) offsets from it rather than stacking offsets. Returns false when
 * the floor could not be moved (no hierarchy, or Cesium lacks the geodesy
 * helpers), so the caller does not record the base as applied.
 */
function applyPerPositionBase(
  Cesium: CesiumNs,
  viewer: CesiumWidget,
  entity: Entity,
  base: number,
  makeProp: (v: unknown) => unknown,
): boolean {
  const polygon = entity.polygon as { hierarchy?: unknown } | undefined;
  if (!polygon) return false;
  if (!loadedHierarchies.has(entity)) {
    if (base === 0) return true;
    const prop = polygon.hierarchy as { getValue?: (time: unknown) => unknown } | undefined;
    const value =
      prop && typeof prop.getValue === "function" ? prop.getValue(viewer.clock?.currentTime) : prop;
    if (!value || typeof value !== "object") return false;
    loadedHierarchies.set(entity, value);
  }
  const loaded = loadedHierarchies.get(entity) as HierarchyLike;
  const next = base === 0 ? loaded : offsetHierarchy(Cesium, loaded, base);
  if (!next) return false;
  polygon.hierarchy = makeProp(next);
  return true;
}

/**
 * Extrude every polygon entity: its roof height from the height expression
 * or property, its floor from the base (flat, or per feature from the base
 * property or expression), its colour from the colour expression or the flat
 * extrusion colour, faded by the extrusion opacity. As on the 2D map the
 * height is the roof's altitude, not a thickness above the base.
 *
 * Expressions are evaluated at `zoom`, the camera's fractional MapLibre zoom,
 * so `["zoom"]` steps and interpolations resolve as the 2D map paints them.
 * An entity whose values did not change since the last pass is left alone, so
 * a re-run after a camera move only rebuilds the polygons that moved.
 * Returns whether any entity was written.
 */
export function applyGeoJsonExtrusion(
  Cesium: CesiumNs,
  viewer: CesiumWidget,
  dataSource: DataSource,
  style: LayerStyle,
  features: FeatureCollection["features"],
  extOpacity: number,
  writers: EntityHeightWriters,
  zoom: number,
): boolean {
  const { heightRef, makeProp, makeMat, perPositionHeight } = writers;
  const heightProp = style.extrusionHeightProperty?.trim() || "height";
  const heightScale = Number.isFinite(style.extrusionHeightScale)
    ? (style.extrusionHeightScale as number)
    : 1;
  const baseVal = extrusionBaseValue(style);
  // The flat base, which is also the fallback when a base expression throws
  // for a feature (as a throwing height expression falls back to the
  // property): with a base property it is the property's offset.
  const flatBaseValue = typeof baseVal === "number" ? baseVal : style.extrusionBase;
  const flatBase = Number.isFinite(flatBaseValue) ? Math.max(0, flatBaseValue as number) : 0;
  const floorHeight = extrusionFloorHeightValue(style);
  const extColorVal = extrusionColorValue(style);
  const extColorStr =
    typeof extColorVal === "string"
      ? extColorVal
      : style.extrusionColor || style.fillColor || "#3b82f6";
  const { heightEvaluator, baseEvaluator, colorEvaluator } = compileExtrusionEvaluators(
    style,
    extColorVal,
    baseVal,
  );

  // Parsed once: a full 3D-buildings layer would otherwise re-parse the
  // same CSS string per polygon. withAlpha() below returns a fresh Color.
  const baseColor = Cesium.Color.fromCssColorString(extColorStr);
  // Expression colours parsed once per distinct value in this pass: a
  // classified building layer resolves thousands of features to a few colours.
  const parsedColors = new Map<string, Color | undefined>();
  let changed = false;
  for (const entity of dataSource.entities.values) {
    if (!entity.polygon) continue;
    const index = entityFeatureIndex(viewer, entity);
    const feat = Number.isInteger(index) && features ? features[index] : null;

    const top = extrusionFeatureHeight(
      viewer,
      entity,
      feat,
      heightEvaluator,
      heightProp,
      heightScale,
      zoom,
    );
    const base = extrusionFeatureBase(feat, baseEvaluator, flatBase, zoom);
    // A floor height makes the roof relative to this feature's base, as
    // `extrusionHeightValue` does on the 2D map.
    const roof = floorHeight > 0 ? base + floorHeight : top;

    // Never below the base: a negative height property or expression would
    // otherwise put the roof under the floor.
    const relativeTop = Math.max(base, roof);
    const perPosition = perPositionHeight(entity.polygon);
    // With perPositionHeight Cesium takes each vertex's own height as the
    // floor and ignores `height`, so the base is added to the vertices
    // (applyPerPositionBase); it reads extrudedHeight as an absolute
    // altitude, so the roof is lifted by the ring's highest vertex rather
    // than extruding down to `relativeTop` metres above the ellipsoid.
    const extrudedHeight = perPosition ? ringTopAltitude(feat) + relativeTop : relativeTop;

    const { color: resolvedColor, key: colorKey } = extrusionFeatureColor(
      Cesium,
      baseColor,
      feat,
      colorEvaluator,
      zoom,
      parsedColors,
    );
    // The flat colour stands in for an expression's, so a flat-colour edit is
    // never skipped as unchanged.
    const fullColorKey = `${colorKey || extColorStr}|${extOpacity}`;

    const previous = appliedExtrusions.get(entity);
    if (
      previous &&
      previous.extrudedHeight === extrudedHeight &&
      previous.base === base &&
      previous.colorKey === fullColorKey
    ) {
      continue;
    }

    // Drop the old record before writing: if a write below throws, a later
    // pass (even back at the previous values) must not match a record the
    // entity no longer reflects.
    appliedExtrusions.delete(entity);
    entity.polygon.extrudedHeight = makeProp(extrudedHeight) as never;
    let appliedBase = base;
    if (perPosition) {
      if (
        (!previous || previous.base !== base) &&
        !applyPerPositionBase(Cesium, viewer, entity, base, makeProp)
      ) {
        // The floor did not move: record that, so the next pass tries again
        // rather than treating this base as already applied.
        appliedBase = Number.NaN;
      }
    } else {
      entity.polygon.height = makeProp(base) as never;
      entity.polygon.heightReference = makeProp(heightRef) as never;
      entity.polygon.extrudedHeightReference = makeProp(heightRef) as never;
    }
    if (!previous || previous.colorKey !== fullColorKey) {
      entity.polygon.material = makeMat(resolvedColor.withAlpha(extOpacity)) as never;
    }
    // Recorded only once every write landed, so a throw part-way leaves the
    // entity to be retried rather than skipped as up to date.
    appliedExtrusions.set(entity, { extrudedHeight, base: appliedBase, colorKey: fullColorKey });
    changed = true;
  }
  return changed;
}

/**
 * A polygon entity's roof altitude in metres, as `extrusionHeightValue` gives
 * it on the 2D map: the height expression's value as written, else the
 * feature's height property (or, for an entity that maps to no feature, the
 * entity's own property) times `heightScale`; 0 when none is a number. An
 * expression that throws falls back to the scaled property.
 */
function extrusionFeatureHeight(
  viewer: CesiumWidget,
  entity: Entity,
  feat: Feature | null,
  heightEvaluator: ExtrusionEvaluator | undefined,
  heightProp: string,
  heightScale: number,
  zoom: number,
): number {
  let rawHeight: unknown;
  let scale = heightScale;
  if (feat && heightEvaluator) {
    try {
      rawHeight = heightEvaluator(feat, zoom);
      scale = 1;
    } catch {
      rawHeight = feat.properties?.[heightProp];
    }
  } else if (feat) {
    rawHeight = feat.properties?.[heightProp];
  } else {
    const prop = entity.properties?.[heightProp];
    rawHeight =
      typeof prop?.getValue === "function" ? prop.getValue(viewer.clock?.currentTime) : prop;
  }

  const num =
    typeof rawHeight === "number" && Number.isFinite(rawHeight) ? rawHeight : Number(rawHeight);
  return Number.isFinite(num) ? num * scale : 0;
}

/**
 * A polygon entity's extrusion base in metres: the per-feature base
 * expression's value (clamped to the ground, as MapLibre clamps
 * `fill-extrusion-base`), else the flat base, which is also the fallback when
 * the expression throws for this feature.
 */
function extrusionFeatureBase(
  feat: Feature | null,
  baseEvaluator: ExtrusionEvaluator | undefined,
  flatBase: number,
  zoom: number,
): number {
  if (!feat || !baseEvaluator) return flatBase;
  let value: number;
  try {
    value = Number(baseEvaluator(feat, zoom));
  } catch {
    return flatBase;
  }
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * A polygon entity's extrusion colour: the colour expression's, else
 * `baseColor`. `key` identifies the colour so a re-run can tell whether it
 * changed (empty for the base colour).
 */
function extrusionFeatureColor(
  Cesium: CesiumNs,
  baseColor: Color,
  feat: Feature | null,
  colorEvaluator: ExtrusionEvaluator | undefined,
  zoom: number,
  parsedColors: Map<string, Color | undefined>,
): { color: Color; key: string } {
  if (feat && colorEvaluator) {
    try {
      const colVal = colorEvaluator(feat, zoom);
      const css =
        typeof colVal === "string"
          ? colVal
          : colVal && typeof (colVal as { toString?: () => string }).toString === "function"
            ? (colVal as { toString: () => string }).toString()
            : null;
      if (css) {
        if (!parsedColors.has(css)) parsedColors.set(css, Cesium.Color.fromCssColorString(css));
        // fromCssColorString returns undefined for a string it cannot parse.
        const color = parsedColors.get(css);
        if (color) return { color, key: css };
      }
    } catch {
      // fallback to the base colour
    }
  }
  return { color: baseColor, key: "" };
}

/**
 * Give Z-carrying (or 3D-elevated) entities their terrain-relative height
 * reference, which an unclamped load leaves unset. Extruded polygons were
 * already handled by {@link applyGeoJsonExtrusion}.
 */
export function applyElevationHeightReferences(
  dataSource: DataSource,
  style: LayerStyle,
  writers: EntityHeightWriters,
): void {
  const { heightRef, makeProp, perPositionHeight } = writers;
  for (const entity of dataSource.entities.values) {
    if (entity.polygon && !style.extrusionEnabled && !perPositionHeight(entity.polygon)) {
      entity.polygon.heightReference = makeProp(heightRef) as never;
    }
    if (entity.billboard) {
      entity.billboard.heightReference = makeProp(heightRef) as never;
    }
    if (entity.point) {
      entity.point.heightReference = makeProp(heightRef) as never;
    }
    if (entity.polyline) {
      (entity.polyline as { clampToGround?: unknown }).clampToGround = makeProp(false);
    }
  }
}
