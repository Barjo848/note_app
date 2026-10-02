/* validate.js — a small JSON-Schema (draft 2020-12 subset) validator.
 * Supports: type (incl. arrays and "integer"), properties, required,
 * additionalProperties, items, enum, const, minimum/maximum, exclusiveMinimum,
 * minLength/maxLength, pattern, minItems/maxItems, anyOf/oneOf/allOf, $ref to
 * "#/$defs/…". Returns an array of {path, message}; empty means valid. */
'use strict';

function validateSchema(schema, data, rootSchema = schema) {
  const errors = [];
  const typeOf = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  const resolve = (ref) => {
    if (!ref.startsWith('#/')) throw new Error('Only local $ref supported: ' + ref);
    let cur = rootSchema;
    for (const seg of ref.slice(2).split('/')) { cur = cur && cur[seg.replace(/~1/g, '/').replace(/~0/g, '~')]; }
    if (!cur) throw new Error('Unresolvable $ref ' + ref);
    return cur;
  };
  const fmtPath = (p) => p.length ? p.map((s, i) => typeof s === 'number' ? `[${s}]` : (i ? '.' : '') + s).join('') : '(root)';
  const walk = (sch, val, path) => {
    if (sch === true) return; if (sch === false) { errors.push({ path: fmtPath(path), message: 'not allowed' }); return; }
    if (sch.$ref) { walk(resolve(sch.$ref), val, path); }
    if (sch.type) {
      const types = Array.isArray(sch.type) ? sch.type : [sch.type];
      const t = typeOf(val);
      const ok = types.some(ty => ty === t || (ty === 'integer' && t === 'number' && Number.isInteger(val)) || (ty === 'number' && t === 'number'));
      if (!ok) { errors.push({ path: fmtPath(path), message: `expected ${types.join(' or ')}, got ${t === 'number' && !Number.isInteger(val) ? 'non-integer number' : t}` }); return; }
    }
    if (sch.enum && !sch.enum.some(e => JSON.stringify(e) === JSON.stringify(val))) errors.push({ path: fmtPath(path), message: `must be one of ${sch.enum.map(e => JSON.stringify(e)).join(', ')}; got ${JSON.stringify(val)}` });
    if (sch.const !== undefined && JSON.stringify(sch.const) !== JSON.stringify(val)) errors.push({ path: fmtPath(path), message: `must equal ${JSON.stringify(sch.const)}` });
    if (typeof val === 'number') {
      if (sch.minimum !== undefined && val < sch.minimum) errors.push({ path: fmtPath(path), message: `must be ≥ ${sch.minimum}` });
      if (sch.maximum !== undefined && val > sch.maximum) errors.push({ path: fmtPath(path), message: `must be ≤ ${sch.maximum}` });
      if (sch.exclusiveMinimum !== undefined && val <= sch.exclusiveMinimum) errors.push({ path: fmtPath(path), message: `must be > ${sch.exclusiveMinimum}` });
    }
    if (typeof val === 'string') {
      if (sch.minLength !== undefined && val.length < sch.minLength) errors.push({ path: fmtPath(path), message: `must be at least ${sch.minLength} characters` });
      if (sch.maxLength !== undefined && val.length > sch.maxLength) errors.push({ path: fmtPath(path), message: `must be at most ${sch.maxLength} characters` });
      if (sch.pattern && !(new RegExp(sch.pattern)).test(val)) errors.push({ path: fmtPath(path), message: `does not match pattern ${sch.pattern}` });
    }
    if (Array.isArray(val)) {
      if (sch.minItems !== undefined && val.length < sch.minItems) errors.push({ path: fmtPath(path), message: `needs at least ${sch.minItems} items` });
      if (sch.maxItems !== undefined && val.length > sch.maxItems) errors.push({ path: fmtPath(path), message: `allows at most ${sch.maxItems} items` });
      if (sch.items) val.forEach((v, i) => walk(sch.items, v, path.concat(i)));
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const r of (sch.required || [])) if (!(r in val)) errors.push({ path: fmtPath(path), message: `missing required field "${r}"` });
      const props = sch.properties || {};
      for (const [k, sub] of Object.entries(props)) if (k in val) walk(sub, val[k], path.concat(k));
      if (sch.additionalProperties !== undefined && sch.additionalProperties !== true) {
        for (const k of Object.keys(val)) if (!(k in props)) {
          if (sch.additionalProperties === false) errors.push({ path: fmtPath(path.concat(k)), message: 'unexpected field' });
          else walk(sch.additionalProperties, val[k], path.concat(k));
        }
      }
    }
    if (sch.allOf) for (const s of sch.allOf) walk(s, val, path);
    if (sch.anyOf) {
      const before = errors.length; let passed = false; const collected = [];
      for (const s of sch.anyOf) { const e2 = validateSchema(s, val, rootSchema); if (!e2.length) { passed = true; break; } collected.push(e2); }
      if (!passed) errors.push({ path: fmtPath(path), message: 'matches none of the allowed forms: ' + collected.map(e => e.map(x => x.message).join('; ')).join(' | ') });
      void before;
    }
    if (sch.oneOf) {
      const results = sch.oneOf.map(s => validateSchema(s, val, rootSchema));
      const passes = results.filter(r => !r.length).length;
      if (passes !== 1) errors.push({ path: fmtPath(path), message: passes === 0 ? 'matches none of the allowed forms: ' + results.map(e => e.map(x => x.message).join('; ')).join(' | ') : 'matches more than one exclusive form' });
    }
  };
  walk(schema, data, []);
  return errors;
}
