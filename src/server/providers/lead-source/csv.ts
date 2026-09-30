import type { RawLead } from "./types";

/** CSV başlık eşlemesi — Türkçe/İngilizce yaygın adlar (küçük harf, aksansız karşılaştırılır). */
const HEADER_ALIASES: Record<string, keyof CsvLeadRow> = {
  firma: "companyName",
  "firma adi": "companyName",
  "firma unvani": "companyName",
  unvan: "companyName",
  sirket: "companyName",
  "sirket adi": "companyName",
  company: "companyName",
  "company name": "companyName",
  name: "companyName",
  web: "website",
  "web sitesi": "website",
  website: "website",
  site: "website",
  url: "website",
  telefon: "phone",
  tel: "phone",
  phone: "phone",
  "e-posta": "email",
  eposta: "email",
  email: "email",
  mail: "email",
  adres: "address",
  address: "address",
  il: "city",
  sehir: "city",
  city: "city",
  ilce: "district",
  district: "district",
  ulke: "country",
  country: "country",
  sektor: "category",
  kategori: "category",
  industry: "category",
  category: "category",
  "yetkili": "contactName",
  "yetkili adi": "contactName",
  "contact name": "contactName",
  "unvan/gorev": "contactTitle",
  gorev: "contactTitle",
  title: "contactTitle",
};

interface CsvLeadRow {
  companyName: string;
  website: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  district: string;
  country: string;
  category: string;
  contactName: string;
  contactTitle: string;
}

const fold = (s: string) =>
  s
    .trim()
    .toLocaleLowerCase("tr")
    .replace(/[İIı]/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");

/** RFC 4180 uyumlu basit CSV ayrıştırıcı (tırnaklı alan, kaçış "", CRLF). Ayraç otomatik: ; , veya sekme. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = { ";": 0, ",": 0, "\t": 0 } as Record<string, number>;
  for (const ch of firstLine) if (ch in counts) counts[ch]!++;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface CsvImportResult {
  leads: RawLead[];
  /** Tanınmayan başlıklar — kullanıcıya gösterilir */
  unknownHeaders: string[];
  skippedRows: number;
}

/** CSV metnini RawLead listesine çevirir. Firma adı sütunu zorunludur. */
export function csvToRawLeads(text: string, maxRows = 2000): CsvImportResult {
  const rows = parseCsv(text);
  if (rows.length === 0) return { leads: [], unknownHeaders: [], skippedRows: 0 };
  const [header, ...body] = rows;
  const mapping: Array<keyof CsvLeadRow | null> = header!.map((h) => HEADER_ALIASES[fold(h)] ?? null);
  const unknownHeaders = header!.filter((_, i) => mapping[i] === null).map((h) => h.trim()).filter(Boolean);

  if (!mapping.includes("companyName")) {
    return { leads: [], unknownHeaders, skippedRows: body.length };
  }

  const leads: RawLead[] = [];
  let skippedRows = 0;
  for (const cells of body.slice(0, maxRows)) {
    const r: Partial<CsvLeadRow> = {};
    mapping.forEach((key, i) => {
      const v = cells[i]?.trim();
      if (key && v) r[key] = v;
    });
    if (!r.companyName) {
      skippedRows++;
      continue;
    }
    leads.push({
      companyName: r.companyName,
      website: r.website,
      phone: r.phone,
      genericEmail: r.email,
      address: r.address,
      city: r.city,
      district: r.district,
      country: r.country,
      category: r.category,
      personalContacts:
        r.contactName || r.contactTitle ? [{ fullName: r.contactName, title: r.contactTitle }] : undefined,
      sourceType: "CSV_IMPORT",
    });
  }
  skippedRows += Math.max(0, body.length - maxRows);
  return { leads, unknownHeaders, skippedRows };
}
