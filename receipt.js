import { jsPDF } from 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[character]);

const money = value => Number(value ?? 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Toast ──
export function toast(msg, type = 'info') {
  const colors = { info: '#1E6FD9', success: '#16A34A', error: '#DC2626' };
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = `position:fixed;top:20px;right:20px;z-index:9999;
    background:${colors[type]};color:#fff;padding:12px 20px;border-radius:10px;
    font-family:system-ui;font-size:14px;box-shadow:0 10px 25px rgba(0,0,0,.15);
    animation:slideIn .3s ease;`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Print receipt via window.print() ──
export function printReceipt(order, hotelName = "HOTELI POA") {
  const w = window.open('', '_blank', 'width=320,height=640');
  if (!w) return toast('Popup blocked', 'error');
  const lines = (order.lines || []).map(l =>
    `<tr><td>${escapeHtml(l.qty)} × ${escapeHtml(l.name)}</td><td style="text-align:right">KSH ${money(l.qty * l.price)}</td></tr>`
  ).join('');
  w.document.write(`
    <html><head><title>Receipt ${escapeHtml(order.id || '')}</title>
    <style>
      body{font-family:'Courier New',monospace;font-size:12px;padding:12px;max-width:280px;margin:0 auto}
      h1{font-size:16px;text-align:center;margin:0 0 4px}
      .muted{color:#666;font-size:10px;text-align:center}
      hr{border:none;border-top:1px dashed #999;margin:8px 0}
      table{width:100%;border-collapse:collapse}
      td{padding:2px 0}
      .total{font-weight:bold;font-size:14px}
    </style></head><body>
      <h1>${escapeHtml(hotelName)}</h1>
      <div class="muted">Point of Sale</div>
      <hr/>
      <div>Order: <b>#${escapeHtml((order.id || '').slice(0, 8).toUpperCase())}</b></div>
      <div>Table: ${escapeHtml(order.table || '—')} · Guests: ${escapeHtml(order.guests || 1)}</div>
      <div>Waiter: ${escapeHtml(order.waiterName || '—')}</div>
      <div>Payment: ${escapeHtml(order.paymentMethod || 'Pending')}</div>
      <div>Date: ${escapeHtml(order.createdAt?.toDate?.().toLocaleString() || new Date().toLocaleString())}</div>
      <hr/>
      <table>${lines}</table>
      <hr/>
      <div>Subtotal: KSH ${money(order.subtotal)}</div>
      <div>Tax: KSH ${money(order.tax)}</div>
      <div class="total">TOTAL: KSH ${money(order.total)}</div>
      <hr/>
      <div class="muted">Thank you for dining with us!</div>
      <script>window.onload=()=>{window.print();setTimeout(()=>window.close(),300);}<\/script>
    </body></html>`);
  w.document.close();
}

// ── Thermal printer bridge (WebUSB ESC/POS) ──
// Requires a WebUSB-compatible thermal printer (Epson TM-T20, Star TSP100, etc.)
export async function printThermal(order, hotelName = "HOTELI POA") {
  if (!navigator.usb) return toast('WebUSB not supported', 'error');
  try {
    const device = await navigator.usb.requestDevice({ acceptAllDevices: true });
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    await device.claimInterface(0);

    const ESC = 0x1B, GS = 0x1D;
    const enc = new TextEncoder();
    const chunks = [];
    const push = (...bytes) => chunks.push(new Uint8Array(bytes));
    const text = s => chunks.push(enc.encode(s + '\n'));

    push(ESC, 0x40);             // init
    push(ESC, 0x61, 0x01);       // center
    push(ESC, 0x21, 0x30);       // double size
    text(hotelName);
    push(ESC, 0x21, 0x00);       // normal
    text('------------------------------');
    push(ESC, 0x61, 0x00);       // left
    text(`Order: ${(order.id || '').slice(0, 8).toUpperCase()}`);
    text(`Table: ${order.table || '-'}  Guests: ${order.guests || 1}`);
    text('------------------------------');
    (order.lines || []).forEach(l =>
      text(`${l.qty} x ${String(l.name ?? '').padEnd(20).slice(0, 20)} KSH ${money(l.qty * l.price)}`)
    );
    text('------------------------------');
    text(`TOTAL: KSH ${money(order.total)}`);
    text('\n\nThank you!\n\n\n');
    push(GS, 0x56, 0x00);        // cut

    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    const buf = await blob.arrayBuffer();
    await device.transferOut(1, buf);
    await device.close();
    toast('Receipt printed', 'success');
  } catch (e) {
    console.error(e);
    toast('Thermal print failed — falling back', 'error');
    printReceipt(order, hotelName);
  }
}

// ── Generate PDF receipt in the browser ──
export async function downloadReceiptPDF(order) {
  const pdf = new jsPDF({ unit: 'mm', format: 'a5' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const left = 15;
  const date = order.createdAt?.toDate?.() || (order.createdAt ? new Date(order.createdAt) : new Date());
  pdf.setTextColor(10, 37, 64);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.text('HOTELI POA', pageWidth / 2, 18, { align: 'center' });
  pdf.setTextColor(75, 85, 99);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.text('Point of Sale Receipt', pageWidth / 2, 24, { align: 'center' });
  pdf.setTextColor(15, 23, 42);
  pdf.text(`Order: #${String(order.id || '').slice(0, 8).toUpperCase()}`, left, 34);
  pdf.text(`Table: ${order.table || '—'}    Guests: ${order.guests || 1}`, left, 40);
  pdf.text(`Payment: ${order.paymentMethod || 'Pending'}`, left, 46);
  pdf.text(`Date: ${date.toLocaleString()}`, left, 52);
  pdf.setDrawColor(203, 213, 225);
  pdf.line(left, 57, pageWidth - left, 57);

  let y = 64;
  pdf.setFont('helvetica', 'bold');
  pdf.text('Item', left, y);
  pdf.text('Amount (KSH)', pageWidth - left, y, { align: 'right' });
  y += 6;
  pdf.setFont('helvetica', 'normal');
  for (const line of order.lines || []) {
    const label = `${line.qty || line.quantity || 1} × ${line.name || 'Item'}`;
    const wrapped = pdf.splitTextToSize(label, pageWidth - 75);
    const rowHeight = Math.max(6, wrapped.length * 4.5);
    if (y + rowHeight > 175) { pdf.addPage(); y = 18; }
    pdf.text(wrapped, left, y);
    pdf.text(money((line.qty || line.quantity || 1) * line.price), pageWidth - left, y, { align: 'right' });
    y += rowHeight;
  }
  y += 3;
  pdf.line(left, y, pageWidth - left, y);
  y += 8;
  pdf.text(`Subtotal: KSH ${money(order.subtotal)}`, left, y); y += 6;
  pdf.text(`Tax: KSH ${money(order.tax)}`, left, y); y += 8;
  pdf.setTextColor(30, 111, 217);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.text(`TOTAL: KSH ${money(order.total)}`, left, y);
  pdf.save(`hoteli-poa-${String(order.id || 'receipt').slice(0, 8)}.pdf`);
}
