import { apiRequest, auth } from './local-api.js';

export const db = {};
export const storage = {};
export const functions = {};
const segments = value => String(value || '').split('/').filter(Boolean);
const refFor = (kind, parts) => ({ kind, parts });
export const collection = (_db, ...parts) => refFor('collection', parts.flatMap(value => typeof value === 'string' ? [value] : value.parts));
export const doc = (_db, ...parts) => refFor('document', parts.flatMap(value => typeof value === 'string' ? [value] : value.parts));
export const where = (field, op, value) => ({ type: 'where', field, op, value });
export const orderBy = (field, direction = 'asc') => ({ type: 'orderBy', field, direction });
export const limit = count => ({ type: 'limit', count });
export const query = (reference, ...constraints) => ({ ...reference, constraints });
export const serverTimestamp = () => new Date().toISOString();
const collectionPath = reference => reference.kind === 'document' ? reference.parts.slice(0, -1).join('/') : reference.parts.join('/');
const recordId = reference => reference.parts.at(-1);
const getField = (object, field) => field.split('.').reduce((value, key) => value?.[key], object);
function matches(data, constraint) {
  const value = getField(data, constraint.field);
  switch (constraint.op) {
    case '==': return value === constraint.value;
    case '!=': return value !== constraint.value;
    case '>': return value > constraint.value;
    case '>=': return value >= constraint.value;
    case '<': return value < constraint.value;
    case '<=': return value <= constraint.value;
    case 'array-contains': return Array.isArray(value) && value.includes(constraint.value);
    default: return true;
  }
}
const makeDoc = (record, path) => ({ id: record.id, ref: refFor('document', [...segments(path), record.id]), exists: () => Boolean(record), data: () => record?.data || {} });
function makeSnapshot(records, path) {
  const docs = records.map(row => makeDoc(row, path));
  return { docs, size: docs.length, empty: !docs.length, forEach: callback => docs.forEach(callback) };
}
async function selectRecords(path, id) {
  const params = new URLSearchParams({ path });
  if (id) params.set('id', id);
  const result = await apiRequest(`/api/records?${params}`);
  return result.records || [];
}
function applyConstraints(records, constraints = []) {
  let result = records.filter(row => constraints.filter(item => item.type === 'where').every(item => matches(row.data, item)));
  for (const item of constraints.filter(value => value.type === 'orderBy').reverse()) {
    result.sort((a, b) => {
      const av = getField(a.data, item.field) ?? '';
      const bv = getField(b.data, item.field) ?? '';
      return (av < bv ? -1 : av > bv ? 1 : 0) * (item.direction === 'desc' ? -1 : 1);
    });
  }
  const cap = constraints.find(item => item.type === 'limit')?.count;
  if (Number.isFinite(cap)) result = result.slice(0, cap);
  return result;
}
export async function getDocs(reference) {
  const path = collectionPath(reference);
  const nestedOrderLines = /^orders\/([^/]+)\/lines$/.exec(path);
  if (nestedOrderLines) {
    const order = await getDoc(doc(null, 'orders', nestedOrderLines[1]));
    return makeSnapshot((order.data()?.lines || []).map((line, index) => ({ id: line.id || String(index), data: line })), path);
  }
  return makeSnapshot(applyConstraints(await selectRecords(path), reference.constraints), path);
}
export async function getDoc(reference) {
  const path = collectionPath(reference);
  const rows = await selectRecords(path, recordId(reference));
  const row = rows[0];
  return { id: recordId(reference), exists: () => Boolean(row), data: () => row?.data || {}, ref: reference };
}
export async function setDoc(reference, value, options = {}) {
  const path = collectionPath(reference), id = recordId(reference);
  let data = value;
  if (options.merge) {
    const existing = await getDoc(reference);
    data = { ...(existing.exists() ? existing.data() : {}), ...value };
  }
  await apiRequest('/api/records', { method: 'POST', body: JSON.stringify({ path, id, data }) });
}
export async function updateDoc(reference, value) {
  const existing = await getDoc(reference);
  if (!existing.exists()) throw new Error('Record not found.');
  return setDoc(reference, { ...existing.data(), ...value });
}
export async function deleteDoc(reference) {
  const params = new URLSearchParams({ path: collectionPath(reference), id: recordId(reference) });
  await apiRequest(`/api/records?${params}`, { method: 'DELETE' });
}
export async function addDoc(reference, value) {
  const id = crypto.randomUUID();
  await setDoc(refFor('document', [...reference.parts, id]), value);
  return { id };
}
export function onSnapshot(reference, next, failure = console.error) {
  let closed = false;
  let loading = false;
  const refresh = async () => {
    if (closed || loading) return;
    loading = true;
    try { next(reference.kind === 'document' ? await getDoc(reference) : await getDocs(reference)); }
    catch (error) { failure(error); }
    finally { loading = false; }
  };
  refresh();
  const timer = setInterval(refresh, 3000);
  return () => { closed = true; clearInterval(timer); };
}
export function writeBatch() {
  const writes = [];
  return {
    set: (reference, data, options) => writes.push(() => setDoc(reference, data, options)),
    update: (reference, data) => writes.push(() => updateDoc(reference, data)),
    delete: reference => writes.push(() => deleteDoc(reference)),
    commit: async () => { for (const write of writes) await write(); }
  };
}
export function storageRef(_storage, path) { return { path }; }
export async function uploadBytes() { throw new Error('Image uploads are disabled in the SQLite demo; use an image URL.'); }
export async function getDownloadURL(reference) { return reference.path; }
export function httpsCallable(_functions, name) {
  return async data => ({ data: await apiRequest(`/api/${encodeURIComponent(name)}`, {
    method: 'POST', body: JSON.stringify(data || {})
  }) });
}
