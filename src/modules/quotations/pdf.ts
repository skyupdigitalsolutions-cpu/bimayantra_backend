// Quotation and comparison PDFs (P-27, P-30): the advisor's business name and logo (P-05) and the standard
// layout. DejaVu Sans is embedded so the rupee sign and Indian names print correctly.
import { readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { formatDate } from '../../lib/clock.js';
import { inr } from '../../lib/money.js';

const fontFile = (name: string) => readFileSync(new URL(`../../assets/fonts/${name}`, import.meta.url));
const INK = rgb(0.075, 0.13, 0.23);
const MUTED = rgb(0.38, 0.44, 0.53);
const LINE = rgb(0.86, 0.89, 0.93);
const BLUE = rgb(0.13, 0.36, 0.85);
const A4: [number, number] = [595.28, 841.89];
const M = 44;

export type PdfHeader = { businessName: string | null; advisorName: string; licenceNumber: string | null; mobile: string; email: string | null; logo: Buffer | null };

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    readonly size: [number, number] = A4,
  ) {
    this.newPage();
  }
  get width() {
    return this.size[0] - 2 * M;
  }
  newPage() {
    this.page = this.doc.addPage(this.size);
    this.y = this.size[1] - M;
  }
  need(h: number) {
    if (this.y - h < M + 20) this.newPage();
  }
  wrap(text: string, f: PDFFont, size: number, width: number): string[] {
    const out: string[] = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) > width && line) {
          out.push(line);
          line = word;
        } else line = next;
      }
      out.push(line);
    }
    return out;
  }
  text(text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; width?: number; gap?: number } = {}) {
    const size = opts.size ?? 10;
    const f = opts.bold ? this.bold : this.font;
    const lines = this.wrap(text, f, size, opts.width ?? this.width);
    for (const l of lines) {
      this.need(size + 4);
      this.page.drawText(l, { x: opts.x ?? M, y: this.y - size, size, font: f, color: opts.color ?? INK });
      this.y -= size + 4;
    }
    this.y -= opts.gap ?? 0;
  }
  rule() {
    this.need(10);
    this.page.drawLine({ start: { x: M, y: this.y - 4 }, end: { x: M + this.width, y: this.y - 4 }, thickness: 0.7, color: LINE });
    this.y -= 12;
  }
  /** Label on the left, value on the right; long values wrap. */
  pair(label: string, value: string, opts: { bold?: boolean } = {}) {
    const lw = this.width * 0.42;
    const vLines = this.wrap(value, opts.bold ? this.bold : this.font, 10, this.width - lw);
    this.need(14 * vLines.length);
    this.page.drawText(label, { x: M, y: this.y - 10, size: 10, font: this.font, color: MUTED });
    vLines.forEach((l, i) => this.page.drawText(l, { x: M + lw, y: this.y - 10 - i * 14, size: 10, font: opts.bold ? this.bold : this.font, color: INK }));
    this.y -= 14 * vLines.length;
  }
  /** A table with fixed column widths; each cell wraps. */
  table(widths: number[], rows: { cells: string[]; bold?: boolean; shade?: boolean }[], size = 9) {
    const x0 = M;
    for (const r of rows) {
      const lines = r.cells.map((c, i) => this.wrap(c, r.bold ? this.bold : this.font, size, widths[i]! - 8));
      const h = Math.max(...lines.map((l) => l.length)) * (size + 3) + 6;
      this.need(h);
      if (r.shade) this.page.drawRectangle({ x: x0, y: this.y - h, width: widths.reduce((a, b) => a + b, 0), height: h, color: rgb(0.95, 0.96, 0.98) });
      let x = x0;
      lines.forEach((ls, i) => {
        ls.forEach((l, j) => this.page.drawText(l, { x: x + 4, y: this.y - 4 - size - j * (size + 3), size, font: r.bold ? this.bold : this.font, color: INK }));
        x += widths[i]!;
      });
      this.page.drawLine({ start: { x: x0, y: this.y - h }, end: { x: x0 + widths.reduce((a, b) => a + b, 0), y: this.y - h }, thickness: 0.5, color: LINE });
      this.y -= h;
    }
    this.y -= 8;
  }
}

async function start(header: PdfHeader, landscape = false) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontFile('DejaVuSans.ttf'), { subset: true });
  const bold = await doc.embedFont(fontFile('DejaVuSans-Bold.ttf'), { subset: true });
  const w = new Writer(doc, font, bold, landscape ? [A4[1], A4[0]] : A4);
  let logo: PDFImage | null = null;
  if (header.logo) {
    try {
      logo = header.logo[0] === 0x89 ? await doc.embedPng(header.logo) : await doc.embedJpg(header.logo);
    } catch {
      logo = null;
    }
  }
  if (logo) {
    const s = logo.scaleToFit(90, 48);
    w.page.drawImage(logo, { x: M + w.width - s.width, y: w.y - s.height, width: s.width, height: s.height });
  }
  w.text(header.businessName ?? header.advisorName, { size: 16, bold: true, width: w.width - 110 });
  w.text([header.advisorName, header.licenceNumber ? `Licence ${header.licenceNumber}` : null, header.mobile.replace('+91', '+91 '), header.email].filter(Boolean).join(' · '), { size: 9, color: MUTED, width: w.width - 110 });
  w.y -= 8;
  w.rule();
  return { doc, w };
}

const rs = (v: string | null | undefined) => (v ? `₹${inr(v)}` : '—');

export type QuotationPdf = {
  header: PdfHeader;
  number: string;
  revision: number;
  calculatedOn: string;
  customer: { name: string; mobile: string; email: string | null };
  people: { name: string; relationship: string; age: number | null }[];
  product: { name: string; uin: string; insurerName: string; typeName: string; agentCode: string };
  inputs: { sumInsured: string; term: string; startDate: string; answers: { label: string; value: string }[]; vehicle: string | null };
  breakdown: {
    base: string;
    riders: { name: string; amount: string }[];
    calculated: string;
    override: { amount: string } | null;
    beforeDiscount: string;
    discount: { amount: string; reference: string } | null;
    afterDiscount: string;
    taxPercent: string;
    tax: string;
    finalPayable: string;
    mode: string;
  };
  priceVersion: string | null;
  validity: string;
  disclaimer: string;
};

export async function quotationPdf(q: QuotationPdf): Promise<Buffer> {
  const { doc, w } = await start(q.header);
  w.text(`Quotation ${q.number} R${q.revision}`, { size: 14, bold: true });
  w.text(`Calculated on ${formatDate(q.calculatedOn)}`, { size: 9, color: MUTED, gap: 6 });
  w.text('Prepared for', { size: 11, bold: true, color: BLUE });
  w.pair('Customer', q.customer.name, { bold: true });
  w.pair('Mobile', q.customer.mobile.replace('+91', '+91 '));
  if (q.customer.email) w.pair('Email', q.customer.email);
  w.pair('People insured', q.people.map((p) => `${p.name} (${p.relationship}${p.age !== null ? `, ${p.age}` : ''})`).join(', '));
  w.y -= 6;
  w.text('Product', { size: 11, bold: true, color: BLUE });
  w.pair('Insurer', q.product.insurerName);
  w.pair('Product', q.product.name, { bold: true });
  w.pair('IRDAI UIN', q.product.uin);
  w.pair('Insurance type', q.product.typeName);
  w.pair('Agent code', q.product.agentCode);
  w.pair('Sum insured', rs(q.inputs.sumInsured));
  w.pair('Policy term', `${q.inputs.term} ${q.inputs.term === '1' ? 'year' : 'years'}`);
  w.pair('Planned start date', formatDate(q.inputs.startDate));
  if (q.inputs.vehicle) w.pair('Vehicle', q.inputs.vehicle);
  for (const a of q.inputs.answers) w.pair(a.label, a.value);
  w.y -= 6;
  w.text('Premium', { size: 11, bold: true, color: BLUE });
  const b = q.breakdown;
  w.pair(b.mode === 'MANUAL_ENTRY' ? 'Net premium (from the insurer portal)' : 'Base premium', rs(b.base));
  for (const r of b.riders) w.pair(`Add-on: ${r.name}`, b.mode === 'MANUAL_ENTRY' ? 'Included' : rs(r.amount));
  if (b.override) {
    w.pair('Calculated premium', rs(b.calculated));
    w.pair('Premium used', rs(b.override.amount));
  }
  if (b.discount) w.pair(`Discount (reference ${b.discount.reference})`, `−${rs(b.discount.amount)}`);
  w.pair('Premium before tax', rs(b.afterDiscount));
  w.pair(`GST (${b.taxPercent}%)`, rs(b.tax));
  w.rule();
  w.pair('Final payable', rs(b.finalPayable), { bold: true });
  if (q.priceVersion) w.pair('Price version', q.priceVersion);
  w.pair('Validity', q.validity);
  w.y -= 10;
  w.text(q.disclaimer, { size: 8.5, color: MUTED });
  return Buffer.from(await doc.save());
}

export type ComparisonPdf = {
  header: PdfHeader;
  number: string;
  calculatedOn: string;
  customer: { name: string };
  people: string;
  sumInsured: string;
  term: string;
  validity: string;
  columns: { title: string; recommended: boolean; reason: string | null }[];
  rows: { label: string; cells: string[]; bold?: boolean }[];
  disclaimer: string;
};

export async function comparisonPdf(c: ComparisonPdf): Promise<Buffer> {
  const { doc, w } = await start(c.header, true);
  w.text(`Comparison ${c.number}`, { size: 14, bold: true });
  w.text(`Prepared for ${c.customer.name} · ${c.people} · Sum insured ${rs(c.sumInsured)} · ${c.term} year term · Calculated on ${formatDate(c.calculatedOn)}`, { size: 9, color: MUTED, gap: 8 });
  const labelW = 150;
  const colW = (w.width - labelW) / c.columns.length;
  const widths = [labelW, ...c.columns.map(() => colW)];
  w.table(widths, [{ cells: ['', ...c.columns.map((col) => (col.recommended ? `${col.title}\n★ Recommended` : col.title))], bold: true, shade: true }]);
  w.table(
    widths,
    c.rows.map((r) => ({ cells: [r.label, ...r.cells], bold: r.bold })),
  );
  const rec = c.columns.find((x) => x.recommended);
  if (rec?.reason) w.text(`Why ${rec.title.split('\n')[0]} is recommended: ${rec.reason}`, { size: 9.5, gap: 6 });
  w.text(`Validity: ${c.validity}`, { size: 9 });
  w.text('This comparison is not a quotation and has no payment link. Your advisor will prepare a quotation for the product you choose.', { size: 8.5, color: MUTED });
  w.text(c.disclaimer, { size: 8.5, color: MUTED });
  return Buffer.from(await doc.save());
}
