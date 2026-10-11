import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const products = require('../menu.js');
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in the local environment first.');
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
const asId = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const categories = [...new Map(products.map(item => [item.categoryId, {
  id: item.categoryId, name: item.sub_category || item.categoryId,
  department: item.department || item.category || 'food', isAvailable: true
}])).values()];
const records = [
  ...categories.map(item => ({ collection_path: 'categories', id: item.id, owner_id: null, data: item })),
  ...products.map(item => {
    const id = asId(item.name);
    return { collection_path: 'products', id, owner_id: null, data: { ...item, id } };
  }),
  { collection_path: 'settings', id: 'general', owner_id: null, data: {
    id: 'general', key: 'general', hotelName: 'HOTELI POA', currency: 'KES', taxRate: 0,
    value: { hotelName: 'HOTELI POA', currency: 'KES', taxRate: 0 }
  } }
];

for (let offset = 0; offset < records.length; offset += 500) {
  const { error } = await supabase.from('app_records').upsert(records.slice(offset, offset + 500), {
    onConflict: 'collection_path,id'
  });
  if (error) throw error;
}
console.log(`Seeded ${products.length} products and ${categories.length} categories.`);
