import { supabase, auth, apiBaseUrl } from './supabase.js';

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

function collectionPath(reference) {
  const parts = reference.parts;
  if (reference.kind === 'document') return parts.slice(0, -1).join('/');
  return parts.join('/');
}
function recordId(reference) { return reference.parts.at(-1); }
function getField(object, field) { return field.split('.').reduce((value, key) => value?.[key], object); }
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
function makeDoc(record, path) {
  return { id: record.id, ref: refFor('document', [...segments(path), record.id]), exists: () => Boolean(record), data: () => record?.data || {} };
}
function makeQuerySnapshot(records, path) {
  const docs = records.map(row => makeDoc(row, path));
  return { docs, size: docs.length, empty: docs.length === 0, forEach: callback => docs.forEach(callback) };
}
async function ownerForPath(path) {
  const [top, child] = segments(path);
  if (['users','userSettings'].includes(top) && child && /^[0-9a-f-]{36}$/i.test(child)) return child;
  const cached = auth.currentUser?.uid;
  if (cached) return cached;
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id || null;
}
async function selectRecords(path, id, constraints = []) {
  let request = supabase.from('app_records').select('id,owner_id,data').eq('collection_path', path);
  if (id) request = request.eq('id', id);
  const { data, error } = await request;
  if (error) throw error;
  let records = (data || []).filter(row => constraints.filter(item => item.type === 'where').every(item => matches(row.data, item)));
  for (const item of constraints.filter(value => value.type === 'orderBy').reverse()) {
    records.sort((a, b) => {
      const av = getField(a.data, item.field) ?? '';
      const bv = getField(b.data, item.field) ?? '';
      return (av < bv ? -1 : av > bv ? 1 : 0) * (item.direction === 'desc' ? -1 : 1);
    });
  }
  const cap = constraints.find(item => item.type === 'limit')?.count;
  if (Number.isFinite(cap)) records = records.slice(0, cap);
  return records;
}

export async function getDocs(reference) {
  const path = collectionPath(reference);
  const nestedOrderLines = /^orders\/([^/]+)\/lines$/.exec(path);
  if (nestedOrderLines) {
    const order = await getDoc(doc(null, 'orders', nestedOrderLines[1]));
    const records = (order.data()?.lines || []).map((line, index) => ({ id: line.id || String(index), data: line }));
    return makeQuerySnapshot(records, path);
  }
  return makeQuerySnapshot(await selectRecords(path, null, reference.constraints || []), path);
}
export async function getDoc(reference) {
  const path = collectionPath(reference);
  const rows = await selectRecords(path, recordId(reference));
  const row = rows[0];
  return { id: recordId(reference), exists: () => Boolean(row), data: () => row?.data || {}, ref: reference };
}
export async function setDoc(reference, value, options = {}) {
  const path = collectionPath(reference);
  const id = recordId(reference);
  let data = value;
  if (options.merge) {
    const existing = await getDoc(reference);
    data = { ...(existing.exists() ? existing.data() : {}), ...value };
  }
  const { data: existingRow, error: lookupError } = await supabase.from('app_records').select('owner_id')
    .eq('collection_path', path).eq('id', id).maybeSingle();
  if (lookupError) throw lookupError;
  const { error } = await supabase.from('app_records').upsert({
    collection_path: path, id, owner_id: existingRow?.owner_id ?? await ownerForPath(path), data, updated_at: new Date().toISOString()
  }, { onConflict: 'collection_path,id' });
  if (error) throw error;
}
export async function updateDoc(reference, value) {
  const existing = await getDoc(reference);
  if (!existing.exists()) throw new Error('Record not found.');
  return setDoc(reference, { ...existing.data(), ...value });
}
export async function deleteDoc(reference) {
  const { error } = await supabase.from('app_records').delete()
    .eq('collection_path', collectionPath(reference)).eq('id', recordId(reference));
  if (error) throw error;
}
export async function addDoc(reference, value) {
  const id = crypto.randomUUID();
  await setDoc(refFor('document', [...reference.parts, id]), value);
  return { id };
}
export function onSnapshot(reference, next, failure = console.error) {
  const path = collectionPath(reference);
  const id = reference.kind === 'document' ? recordId(reference) : null;
  let closed = false;
  let loading = false;
  const refresh = async () => {
    if (closed || loading) return;
    loading = true;
    try {
      if (id) next(await getDoc(reference));
      else next(await getDocs(reference));
    } catch (error) { failure(error); }
    finally { loading = false; }
  };
  refresh();
  let channel = supabase.channel(`records:${path}:${id || '*'}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_records', filter: `collection_path=eq.${path}` }, refresh);
  if (id) channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: 'app_records', filter: `id=eq.${id}` }, refresh);
  channel.subscribe();
  return () => { closed = true; supabase.removeChannel(channel); };
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
export async function uploadBytes(reference, file, options = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in before uploading an image.');
  const safeName = `${crypto.randomUUID()}.${file.name.split('.').pop()?.toLowerCase() || 'img'}`;
  const relativePath = reference.path.replace(/^\/+/, '');
  const storagePath = relativePath.startsWith('products/')
    ? `products/${user.uid}/${relativePath.slice('products/'.length)}/${safeName}`
    : `${user.uid}/${relativePath}/${safeName}`;
  const { error } = await supabase.storage.from('hotel-media').upload(storagePath, file, {
    contentType: options.contentType || file.type, upsert: true
  });
  if (error) throw error;
  reference.path = storagePath;
  return reference;
}
export async function getDownloadURL(reference) {
  const { data, error } = await supabase.storage.from('hotel-media').createSignedUrl(reference.path, 60 * 60 * 24 * 7);
  if (error) throw error;
  return data.signedUrl;
}

export function httpsCallable(_functions, name) {
  return async data => {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    const response = await fetch(`${apiBaseUrl}/api/${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(data || {})
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return { data: result };
  };
}
