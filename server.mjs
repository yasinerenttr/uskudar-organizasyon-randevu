import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 4090;
const WP_BOT_URL = process.env.WP_BOT_URL || 'https://avelon-wp-botavelon-wp-bot.onrender.com';

app.use(express.json({ limit: '5mb' }));

// ⚡ Yüksek Hızlı Gzip Sıkıştırma + Ön-Derlenmiş HTML/Katalog Önbelleği (0 Ek Ağ İsteği ile Anında Açılış)
let cachedHtmlEntry = null;
function invalidateHtmlCache() {
  cachedHtmlEntry = null;
}

app.use((req, res, next) => {
  const acceptEnc = String(req.headers['accept-encoding'] || '');
  if (!acceptEnc.includes('gzip')) return next();
  const origJson = res.json.bind(res);
  res.json = (body) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf-8');
    if (raw.length < 1024) return origJson(body);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    return res.end(zlib.gzipSync(raw, { level: 6 }));
  };
  next();
});

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'reservations.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Türkiye telefon numarasını 905xxxxxxxxx formatına normalize eder
function normalizeCustomerPhone(rawPhone = '') {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0090') && digits.length === 14) {
    digits = digits.slice(2);
  } else if (digits.startsWith('05') && digits.length === 11) {
    digits = '9' + digits;
  } else if (digits.startsWith('5') && digits.length === 10) {
    digits = '90' + digits;
  }
  return digits.length >= 10 ? digits : '';
}

const recentStatusDispatchCache = new Map();

// Gerçek WhatsApp Mesajı Gönderici (Canlı Bağlı WhatsApp Bot Üzerinden Doğrudan Müşteri Numarasına)
async function dispatchRealWhatsAppMessage(
  phone,
  messageText,
  title = 'ÜSK-AI Rezervasyon Bildirimi',
  opts = {}
) {
  const cleanPhone = normalizeCustomerPhone(phone);
  if (!cleanPhone) {
    if (opts.alsoNotifyOwner) {
      try {
        await fetch(`${WP_BOT_URL}/api/send-self-note`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, text: opts.ownerText || messageText }),
        });
      } catch (_) {}
    }
    return false;
  }

  try {
    const resp = await fetch(`${WP_BOT_URL}/api/send-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: cleanPhone,
        text: messageText,
        title,
        alsoNotifyOwner: Boolean(opts.alsoNotifyOwner),
        ownerText: opts.ownerText || '',
      }),
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({ ok: true }));
      if (data && data.ok !== false) {
        return true;
      }
    } else if (resp.status === 404 && cleanPhone === '905525222988') {
      // Yalnızca yönetici numarası için geriye dönük self-note yedeği
      const fallback = await fetch(`${WP_BOT_URL}/api/send-self-note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, text: messageText }),
      });
      if (fallback.ok) return true;
    } else {
      const errBody = await resp.text().catch(() => '');
      console.warn(`WhatsApp gönderim yanıtı (${resp.status} -> ${cleanPhone}):`, errBody);
    }
  } catch (err) {
    console.warn('Canlı WhatsApp gönderim uyarısı:', err.message);
  }
  return false;
}

// Üsküdar Belediyesi Tesisleri & 350 Kontenjan Kuralı
export const FACILITIES = [
  {
    id: 'nevmekan_sahil',
    name: 'Üsküdar Nevmekan Sahil (Davet & Organizasyon Salonu)',
    capacity: 500,
    quotaThreshold: 350,
    maxQuotaThreshold: 500,
    baseHallFee: 20000,
    waiveHallFeeMinGuests: 350,
    description: '350 – 500 Kontenjan Kuralı: 350 ile 500 kişide mekan ücreti alınmaz (tek kalem). 350\'den az olanlarda Mekan Parası (₺20.000) + Kahvaltı/Yemek Parası ödenir. 500\'den sonrası ekstra kişiye girer.',
  },
  {
    id: 'nevmekan_baglarbasi',
    name: 'Üsküdar Nevmekan Bağlarbaşı',
    capacity: 500,
    quotaThreshold: 350,
    maxQuotaThreshold: 500,
    baseHallFee: 20000,
    waiveHallFeeMinGuests: 350,
    description: '350 – 500 Kontenjan Kuralı: 350 ile 500 kişide mekan ücreti alınmaz (tek kalem). 350\'den az olanlarda Mekan Parası + Kahvaltı/Yemek Parası ödenir. 500\'den sonrası ekstraya girer.',
  },
  {
    id: 'nevmekan_selimiye',
    name: 'Üsküdar Nevmekan Selimiye',
    capacity: 500,
    quotaThreshold: 350,
    maxQuotaThreshold: 500,
    baseHallFee: 18000,
    waiveHallFeeMinGuests: 350,
    description: '350 – 500 Kontenjan Kuralı: 350 ile 500 kişide ekstra mekan ücreti alınmaz; 350 altı Mekan + Kahvaltı öder, 500 üzeri ekstraya girer.',
  },
  {
    id: 'bogazici_yasam',
    name: 'Boğaziçi Yaşam Merkezi',
    capacity: 500,
    quotaThreshold: 350,
    maxQuotaThreshold: 500,
    baseHallFee: 20000,
    waiveHallFeeMinGuests: 350,
    description: '350 – 500 Kontenjan Kuralı: 350 ve 500 kontenjanında sadece tek kalem ödenir. 350\'den az olanlar Mekan (₺20.000) + Kahvaltı öder; 500\'den sonrası ekstraya girer.',
  },
  {
    id: 'valide_sultan_gemisi',
    name: 'Valide Sultan Gemisi',
    capacity: 500,
    quotaThreshold: 350,
    maxQuotaThreshold: 500,
    baseHallFee: 30000,
    waiveHallFeeMinGuests: 350,
    description: 'Boğaz turu organizasyon ve düğün/kahvaltı davetleri (350 – 500 Kontenjan).',
  },
  {
    id: 'camlica_sosyal_tesis',
    name: 'Çamlıca Sosyal Tesisleri',
    capacity: 500,
    quotaThreshold: 350,
    maxQuotaThreshold: 500,
    baseHallFee: 20000,
    waiveHallFeeMinGuests: 350,
    description: '350 – 500 Kontenjan Kuralı: 350 ile 500 kişide ekstra mekan ücreti alınmaz; 350 altı Mekan + Kahvaltı öder, 500 üzeri ekstraya girer.',
  },
];

// Etkinlik / Personel Kalemleri
export const EVENT_PERSONNEL_CATALOG = [
  { id: 1861, category: 'PERSONEL', name: 'Sorumlu', price: 0.0, year: 2026 },
  { id: 1862, category: 'PERSONEL', name: 'Çaycı', price: 0.0, year: 2026 },
  { id: 1863, category: 'PERSONEL', name: 'Bulaşıkçı', price: 0.0, year: 2026 },
  { id: 1864, category: 'PERSONEL', name: 'DJ(BAY)', price: 0.0, year: 2026 },
  { id: 1865, category: 'PERSONEL', name: 'DJ(BAYAN)', price: 0.0, year: 2026 },
];

// Ana Menüler ve Alt Kalemleri
export const MAIN_MENUS = [
  {
    id: 1499,
    name: 'KAHVALTI TABAĞI-1',
    price: 517.5,
    year: 2026,
    items: [
      { id: 3966, name: 'BEYAZ PEYNİR', price: 0.0, group: 'ANA YEMEK' },
      { id: 3967, name: 'TAZE KAŞAR PEYNİR', price: 0.0, group: 'ANA YEMEK' },
      { id: 3968, name: 'ÇEÇİL PEYNİR', price: 0.0, group: 'ANA YEMEK' },
      { id: 3969, name: 'PAKET REÇEL', price: 0.0, group: 'TATLI' },
      { id: 3970, name: 'PAKET SÜZME BAL', price: 0.0, group: 'TATLI' },
      { id: 3971, name: 'PAKET TEREYAĞ', price: 0.0, group: 'ANA YEMEK' },
      { id: 3972, name: 'SİYAH ZEYTİN', price: 0.0, group: 'ANA YEMEK' },
      { id: 3973, name: 'YEŞİL ZEYTİN', price: 0.0, group: 'ANA YEMEK' },
      { id: 3974, name: 'HAŞLANMIŞ YUMURTA', price: 0.0, group: 'ANA YEMEK' },
      { id: 3975, name: 'CHERRY DOMATES', price: 0.0, group: 'SALATA' },
      { id: 3976, name: 'SALATALIK', price: 0.0, group: 'SALATA' },
      { id: 3977, name: 'SİMİT', price: 0.0, group: 'ANA YEMEK' },
      { id: 4096, name: 'BARDAK SU 180ML', price: 0.0, group: 'İÇECEK' },
      { id: 4097, name: 'ÇAY SINIRSIZ', price: 0.0, group: 'İÇECEK' },
    ],
  },
  {
    id: 1378,
    name: '2026 KIRMIZI ET MENÜ - 2',
    price: 675.0,
    year: 2026,
    items: [
      { id: 4101, name: 'DANA ROSTO & PİRİNÇ PİLAVI', price: 0.0, group: 'ANA YEMEK' },
      { id: 4102, name: 'MEVSİM SALATA', price: 0.0, group: 'SALATA' },
      { id: 4103, name: 'SÜTLAÇ / TRİLEÇE', price: 0.0, group: 'TATLI' },
      { id: 4104, name: 'MEŞRUBAT & BARDAK SU 180ML & ÇAY', price: 0.0, group: 'İÇECEK' },
    ],
  },
  {
    id: 1377,
    name: '2026 KIRMIZI ET MENÜ - 1',
    price: 825.0,
    year: 2026,
    items: [
      { id: 4201, name: 'KUZU TANDIR / HÜNKAR BEĞENDİ & İÇ PİLAV', price: 0.0, group: 'ANA YEMEK' },
      { id: 4202, name: 'AKDENİZ SALATA & ORDÖVR TABAĞI', price: 0.0, group: 'SALATA' },
      { id: 4203, name: 'FISTIKLI BAKLAVA & DÜĞÜN PASTASI', price: 0.0, group: 'TATLI' },
      { id: 4204, name: 'MEŞRUBAT & BARDAK SU 180ML & ÇAY SINIRSIZ', price: 0.0, group: 'İÇECEK' },
    ],
  },
  {
    id: 1516,
    name: '2026-RAMAZAN MENÜ SAHİL',
    price: 2300.0,
    year: 2026,
    items: [
      { id: 4301, name: 'İFTARİYELİK TABAĞI & KARIŞIK IZGARA / KUZU İNCİK', price: 0.0, group: 'ANA YEMEK' },
      { id: 4302, name: 'GAVURDAĞI SALATA', price: 0.0, group: 'SALATA' },
      { id: 4303, name: 'GÜLLAÇ & BAKLAVA', price: 0.0, group: 'TATLI' },
      { id: 4304, name: 'OSMANLI ŞERBETİ, AYRAN, SU & ÇAY SINIRSIZ', price: 0.0, group: 'İÇECEK' },
    ],
  },
  {
    id: 1528,
    name: '2026 CEVİZAĞACI-AĞUSTOS ÖZEL DAVET',
    price: 1150.0,
    year: 2026,
    items: [
      { id: 4401, name: 'BONFİLE SARMA & KÖZLENMİŞ SEBZE PÜRESİ', price: 0.0, group: 'ANA YEMEK' },
      { id: 4402, name: 'PEYNİRLİ ROKA SALATASI', price: 0.0, group: 'SALATA' },
      { id: 4403, name: 'ÇİKOLATALI SUFLE & MEYVE TABAĞI', price: 0.0, group: 'TATLI' },
      { id: 4404, name: 'LİMONATA, SU & ÇAY SINIRSIZ', price: 0.0, group: 'İÇECEK' },
    ],
  },
  {
    id: 1545,
    name: 'BAŞKANLIK BURHAN FELEK SPOR KOMPLEKSİ YEMEK',
    price: 325.0,
    year: 2026,
    items: [
      { id: 4501, name: 'IZGARA KÖFTE / TAVUK & PİLAV', price: 0.0, group: 'ANA YEMEK' },
      { id: 4502, name: 'ÇOBAN SALATA', price: 0.0, group: 'SALATA' },
      { id: 4503, name: 'KAZANDİBİ', price: 0.0, group: 'TATLI' },
      { id: 4504, name: 'AYRAN & BARDAK SU 180ML', price: 0.0, group: 'İÇECEK' },
    ],
  },
  {
    id: 1539,
    name: 'BAŞKANLIK DİYABET MERKEZİ',
    price: 325.0,
    year: 2026,
    items: [
      { id: 4601, name: 'ZEYTİNYAĞLI SEBZE & IZGARA BALIK/TAVUK', price: 0.0, group: 'ANA YEMEK' },
      { id: 4602, name: 'YEŞİL SALATA', price: 0.0, group: 'SALATA' },
      { id: 4603, name: 'MEVSİM MEYVELERİ', price: 0.0, group: 'TATLI' },
      { id: 4604, name: 'BARDAK SU 180ML & BİTKİ ÇAYI', price: 0.0, group: 'İÇECEK' },
    ],
  },
];

// Seçmeli Menüler
export const OPTIONAL_MENUS = [
  { id: 1388, name: "1 KOLİ SU 300ML 12'Lİ 2025", price: 125.0, year: 2025 },
  { id: 1479, name: "1 KOLİ SU 300ML 12'Lİ 2026", price: 143.75, year: 2026 },
  { id: 1482, name: "AYRAN 280ML 12'Lİ 2026", price: 488.75, year: 2026 },
  { id: 1391, name: "AYRAN 300ML 12'Lİ 2025", price: 425.0, year: 2025 },
  { id: 1393, name: 'BARDAK ÇAY 2025', price: 20.0, year: 2025 },
  { id: 1484, name: 'BARDAK ÇAY 2026', price: 23.0, year: 2026 },
  { id: 1451, name: 'BARDAK LİMONATA', price: 58.0, year: 2026 },
];

export const FEEDBACK_CATEGORIES = ['Fiyat/Kontenjan', 'Tesis/Hizmet', 'Tarih Çakışması', 'İletişim/Diğer'];
export const FEEDBACK_STATUSES = ['Açık', 'İşlemde', 'Çözüldü', 'Kapandı'];

function normalizeTR(str) {
  return String(str || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .trim();
}

export function appendAuditLog(entity, { actor = 'system', type = 'event', summary = '' } = {}) {
  if (!entity || typeof entity !== 'object') return null;
  if (!Array.isArray(entity.auditLog)) entity.auditLog = [];
  const entry = {
    id: `AUD-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
    at: new Date().toISOString(),
    actor: String(actor || 'system'),
    type: String(type || 'event'),
    summary: String(summary || ''),
  };
  entity.auditLog.push(entry);
  return entry;
}

function normalizeFeedbackCategory(rawCategory) {
  const norm = normalizeTR(rawCategory);
  if (norm.includes('fiyat') || norm.includes('kontenjan') || norm.includes('ucret')) {
    return 'Fiyat/Kontenjan';
  }
  if (norm.includes('tesis') || norm.includes('hizmet') || norm.includes('salon') || norm.includes('menu')) {
    return 'Tesis/Hizmet';
  }
  if (norm.includes('tarih') || norm.includes('saat') || norm.includes('cakisma')) {
    return 'Tarih Çakışması';
  }
  return 'İletişim/Diğer';
}

function maskCustomerName(fullName) {
  const clean = String(fullName || '').trim();
  if (!clean) return 'Sayın Başvuru Sahibi';
  return clean
    .split(/\s+/)
    .map((part) => {
      if (!part) return '';
      const first = part.charAt(0);
      return `${first}***`;
    })
    .filter(Boolean)
    .join(' ');
}

function generateUniqueCode(prefix, existingList = []) {
  const used = new Set((existingList || []).map((x) => String(x?.id || '').toUpperCase()));
  for (let i = 0; i < 50; i++) {
    const candidate = `${prefix}-2026-${Math.floor(1000 + Math.random() * 9000)}`;
    if (!used.has(candidate.toUpperCase())) return candidate;
  }
  return `${prefix}-2026-${Date.now().toString().slice(-6)}`;
}

function getInitialDb() {
  return {
    settings: {
      showCitizenCalculator: true,
      hourlyReminderEnabled: true,
      reminderIntervalMinutes: 60,
      adminWhatsappPhone: '05525222988',
    },
    reservations: [
      {
        id: 'USK-2026-1042',
        date: '30.11.2026',
        startTime: '09:00',
        endTime: '12:00',
        facilityId: 'bogazici_yasam',
        facilityName: 'Boğaziçi Yaşam Merkezi',
        ownerName: 'Ahmet Yılmaz',
        purpose: 'Kahvaltı',
        tableLayout: 'Masalı Düzen',
        rentalType: 'Dolu Kiralama',
        guestCount: 350,
        selectedEvents: [
          { id: 1861, name: 'Sorumlu', qty: 1, price: 0 },
          { id: 1862, name: 'Çaycı', qty: 2, price: 0 },
          { id: 1863, name: 'Bulaşıkçı', qty: 2, price: 0 },
        ],
        selectedMenus: [
          {
            id: 1499,
            name: 'KAHVALTI TABAĞI-1',
            price: 517.5,
            qty: 350,
            removedItems: [],
            activeItems: MAIN_MENUS[0].items,
          },
        ],
        selectedOptionals: [
          { id: 1479, name: "1 KOLİ SU 300ML 12'Lİ 2026", price: 143.75, qty: 10 },
        ],
        pricing: {
          guestCount: 350,
          hallFeeBase: 20000,
          hallFeeApplied: 0,
          hallFeeWaived: true,
          menuSubtotal: 181125.0,
          optionalSubtotal: 1437.5,
          grandTotal: 182562.5,
        },
        customer: {
          firstName: 'Ahmet',
          lastName: 'Yılmaz',
          tcNo: '12345678901',
          phone: '05525222988',
          email: 'ahmet.yilmaz@ornek.com',
          address: 'Üsküdar / İstanbul',
          description: 'Deniz tarafı masa düzeni rica olunur.',
        },
        invoice: {
          companyName: 'Ahmet Yılmaz',
          email: 'ahmet.yilmaz@ornek.com',
          taxOffice: 'Üsküdar',
          taxNumber: '12345678901',
          companyAddress: 'Üsküdar / İstanbul',
        },
        status: 'Onaylandı',
        whatsappStatus: 'ÜSK-AI Tarafından İletildi',
        whatsappLastMessage:
          '*ÜSK-AI | T.C. ÜSKÜDAR BELEDİYESİ ORGANİZASYON BİLDİRİMİ*\n\nSayın *Ahmet Yılmaz*,\n*Boğaziçi Yaşam Merkezi* için 30.11.2026 (09:00 - 12:00) tarihli, *350 Kontenjan* (Kahvaltı Tabağı-1) rezervasyon başvurunuz *USK-2026-1042* koduyla Onay Paneline iletilmiştir.\n\n*Kontenjan Kuralı:* 350 Kontenjan (Tek kalem ücret uygulanmış, ekstra mekan farkı alınmamıştır).\n*Toplam Tutar:* ₺182.562,50',
        createdAt: new Date().toISOString(),
      },
    ],
    complaints: [],
  };
}

let memoryDbCache = null;

function loadDb() {
  if (memoryDbCache) return memoryDbCache;
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      if (!parsed.settings) parsed.settings = {};
      if (parsed.settings.showCitizenCalculator === undefined) parsed.settings.showCitizenCalculator = true;
      if (parsed.settings.hourlyReminderEnabled === undefined) parsed.settings.hourlyReminderEnabled = true;
      if (!parsed.settings.reminderIntervalMinutes) parsed.settings.reminderIntervalMinutes = 60;
      if (!parsed.settings.adminWhatsappPhone) parsed.settings.adminWhatsappPhone = '05525222988';
      if (!Array.isArray(parsed.reservations)) parsed.reservations = [];
      if (!Array.isArray(parsed.complaints)) parsed.complaints = [];
      memoryDbCache = parsed;
      return parsed;
    }
  } catch (_) {}
  const initial = getInitialDb();
  fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf-8');
  memoryDbCache = initial;
  return initial;
}

function saveDb(db) {
  memoryDbCache = db;
  invalidateHtmlCache();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

export function calculateReservationPricing({
  facilityId,
  rentalType,
  guestCount,
  selectedMenus = [],
  selectedOptionals = [],
}) {
  const facility = FACILITIES.find((f) => f.id === facilityId) || FACILITIES[0];
  const guests = Math.max(1, Number(guestCount) || 1);
  const quotaThreshold = facility.waiveHallFeeMinGuests || 350;
  const maxQuotaThreshold = facility.maxQuotaThreshold || 500;
  const isEmptyHall = rentalType === 'Boş Salon Kiralama';
  const effectiveMenus = isEmptyHall ? [] : (Array.isArray(selectedMenus) ? selectedMenus : []);
  const hasMenu = effectiveMenus.length > 0;

  const hallFeeWaived = hasMenu && guests >= quotaThreshold;
  const hallFeeApplied = hallFeeWaived ? 0 : facility.baseHallFee;

  const menuPerPerson = effectiveMenus.reduce((acc, m) => acc + (Number(m.price) || 0), 0);
  const baseQuotaGuests = Math.min(guests, maxQuotaThreshold);
  const extraGuestsAbove500 = Math.max(0, guests - maxQuotaThreshold);
  const baseMenuSubtotal = menuPerPerson * baseQuotaGuests;
  const extraGuestSubtotal = menuPerPerson * extraGuestsAbove500;
  const menuSubtotal = baseMenuSubtotal + extraGuestSubtotal;

  const optionalSubtotal = selectedOptionals.reduce(
    (acc, o) => acc + (Number(o.price) || 0) * (Number(o.qty) || 1),
    0
  );
  const grandTotal = hallFeeApplied + menuSubtotal + optionalSubtotal;

  let smartUpsellSuggestion = null;
  if (hasMenu && !hallFeeWaived && guests < quotaThreshold) {
    const thresholdGuests = quotaThreshold;
    const thresholdMenuTotal = menuPerPerson * thresholdGuests + optionalSubtotal;
    const diffTl = thresholdMenuTotal - grandTotal;
    const extraGuests = thresholdGuests - guests;
    smartUpsellSuggestion = {
      currentGuests: guests,
      currentTotal: grandTotal,
      currentIncludesHallFee: facility.baseHallFee,
      thresholdGuests,
      thresholdTotal: thresholdMenuTotal,
      extraGuests,
      diffTl,
      message: `350 ALTI KURALI (${guests} Kişi): 350 kontenjanın altında olduğu için Kahvaltı/Yemek Parası (₺${menuSubtotal.toLocaleString('tr-TR')}) + Mekan Parası (₺${facility.baseHallFee.toLocaleString('tr-TR')}) = ₺${grandTotal.toLocaleString('tr-TR')} birlikte ödenmektedir.`,
    };
  }

  return {
    facilityName: facility.name,
    guestCount: guests,
    waiveThreshold: quotaThreshold,
    maxQuotaThreshold,
    baseQuotaGuests,
    extraGuestsAbove500,
    baseMenuSubtotal,
    extraGuestSubtotal,
    maxCapacity: facility.capacity,
    hallFeeBase: facility.baseHallFee,
    hallFeeApplied,
    hallFeeWaived,
    menuPerPerson,
    menuSubtotal,
    optionalSubtotal,
    grandTotal,
    smartUpsellSuggestion,
  };
}

function serveFastPortalHtml(req, res) {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  const mtimeMs = fs.statSync(htmlPath).mtimeMs;
  if (!cachedHtmlEntry || cachedHtmlEntry.mtimeMs !== mtimeMs) {
    const rawHtml = fs.readFileSync(htmlPath, 'utf-8');
    const db = loadDb();
    const bootstrapPayload = {
      ok: true,
      facilities: FACILITIES,
      eventPersonnel: EVENT_PERSONNEL_CATALOG,
      mainMenus: MAIN_MENUS,
      optionalMenus: OPTIONAL_MENUS,
      settings: db.settings || { showCitizenCalculator: true },
    };
    const inlineScript = `<script>window.__INITIAL_CATALOG__=${JSON.stringify(bootstrapPayload).replace(/<\//g, '<\\/')};</script>`;
    const hydratedHtml = rawHtml.includes('</head>')
      ? rawHtml.replace('</head>', `${inlineScript}\n</head>`)
      : `${inlineScript}\n${rawHtml}`;
    const rawBuf = Buffer.from(hydratedHtml, 'utf-8');
    const gzipBuf = zlib.gzipSync(rawBuf, { level: 6 });
    cachedHtmlEntry = { mtimeMs, rawBuf, gzipBuf };
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Vary', 'Accept-Encoding');
  if (String(req.headers['accept-encoding'] || '').includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.end(cachedHtmlEntry.gzipBuf);
  }
  return res.end(cachedHtmlEntry.rawBuf);
}

// Ana sayfa ve /yonetim rotaları RAM önbellekli + gömülü kataloglu HTML döner (0 ek API beklemesi!)
app.get(['/', '/index.html', '/yonetim', '/yönetim', '/y%C3%B6netim', '/yonetici', '/yönetici', '/y%C3%B6netici', '/admin'], serveFastPortalHtml);

// Statik görselleri 7 gün tarayıcı önbellekli sun (tekrar indirmeyi sıfırlar)
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true,
  index: false,
}));

// Yönetici Giriş / Çıkış API uçları
const ADMIN_ALLOWED_EMAILS = new Set(['üsküdarkemal@gmail.com', 'uskudarkemal@gmail.com']);
const ADMIN_ALLOWED_PASSWORDS = new Set(['14532026üsküdar!', '14532026uskudar!']);

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(401).json({
      ok: false,
      error: 'E-posta veya şifre hatalı.',
    });
  }
  const cleanEmail = email.trim().toLocaleLowerCase('tr-TR');
  const normEmail = normalizeTR(cleanEmail);
  const cleanPass = password.trim();

  const emailValid = ADMIN_ALLOWED_EMAILS.has(cleanEmail) || ADMIN_ALLOWED_EMAILS.has(normEmail);
  const passValid = ADMIN_ALLOWED_PASSWORDS.has(cleanPass);

  if (!emailValid || !passValid) {
    return res.status(401).json({
      ok: false,
      error: 'E-posta veya şifre hatalı.',
    });
  }

  const token = `usk-adm-${crypto.randomBytes(24).toString('hex')}`;
  return res.status(200).json({
    ok: true,
    token,
    user: {
      email: 'üsküdarkemal@gmail.com',
      name: 'Kemal',
      role: 'Yönetici',
      initials: 'K',
    },
  });
});

app.post('/api/admin/logout', (_req, res) => {
  return res.status(200).json({ ok: true });
});

app.get('/api/catalog', (_req, res) => {
  const db = loadDb();
  res.json({
    ok: true,
    facilities: FACILITIES,
    eventPersonnel: EVENT_PERSONNEL_CATALOG,
    mainMenus: MAIN_MENUS,
    optionalMenus: OPTIONAL_MENUS,
    settings: db.settings || { showCitizenCalculator: true },
  });
});

app.post('/api/settings', (req, res) => {
  const db = loadDb();
  db.settings = {
    ...(db.settings || {}),
    ...(req.body || {}),
  };
  saveDb(db);
  res.json({ ok: true, settings: db.settings });
});

app.post('/api/check-availability', (req, res) => {
  const { date, startTime, endTime, facilityId } = req.body || {};
  const db = loadDb();
  const facility = FACILITIES.find((f) => f.id === facilityId) || FACILITIES[0];
  const conflict = db.reservations.find(
    (r) =>
      r.status !== 'İptal Edildi' &&
      r.facilityId === facility.id &&
      r.date === date &&
      !(endTime <= r.startTime || startTime >= r.endTime)
  );
  if (conflict) {
    return res.json({
      ok: true,
      available: false,
      conflictId: conflict.id,
      message: `${facility.name} ${date} tarihinde ${conflict.startTime}–${conflict.endTime} saatleri arasında DOLUDUR (Kayıt: ${conflict.id} - ${conflict.purpose}). Lütfen farklı bir saat dilimi veya tesis seçiniz.`,
    });
  }
  return res.json({
    ok: true,
    available: true,
    message: `${facility.name} — ${date} (${startTime} - ${endTime}) tarih ve saat aralığında MÜSAİTTİR. (Kontenjan: ${facility.waiveHallFeeMinGuests} Kişi | Kapasite: ${facility.capacity} Kişi).`,
  });
});

app.post('/api/calculate', (req, res) => {
  const pricing = calculateReservationPricing(req.body || {});
  res.json({ ok: true, pricing });
});

function normalizeLegacyAiBrand(value) {
  return typeof value === 'string' ? value.replace(/\u00dcSK\u00dc-AI/gi, 'ÜSK-AI') : value;
}

function projectReservationForRead(record) {
  if (!record || typeof record !== 'object') return record;
  const copy = { ...record };
  if (typeof copy.whatsappStatus === 'string') {
    copy.whatsappStatus = normalizeLegacyAiBrand(copy.whatsappStatus);
  }
  if (typeof copy.whatsappLastMessage === 'string') {
    copy.whatsappLastMessage = normalizeLegacyAiBrand(copy.whatsappLastMessage);
  }
  if (typeof copy.lastReminderMessage === 'string') {
    copy.lastReminderMessage = normalizeLegacyAiBrand(copy.lastReminderMessage);
  }
  return copy;
}

app.get('/api/reservations', (_req, res) => {
  const db = loadDb();
  res.json({
    ok: true,
    reservations: (db.reservations || []).map(projectReservationForRead),
    settings: db.settings,
  });
});

app.post('/api/reservations', async (req, res) => {
  const body = req.body || {};
  const db = loadDb();
  const facility = FACILITIES.find((f) => f.id === body.facilityId) || FACILITIES[0];
  const isEmptyHall = body.rentalType === 'Boş Salon Kiralama';
  const effectiveMenus = isEmptyHall ? [] : (Array.isArray(body.selectedMenus) ? body.selectedMenus : []);
  const pricing = calculateReservationPricing({
    facilityId: facility.id,
    rentalType: body.rentalType,
    guestCount: body.guestCount,
    selectedMenus: effectiveMenus,
    selectedOptionals: body.selectedOptionals || [],
  });

  const code = generateUniqueCode('USK', db.reservations);
  const customerName =
    `${body.customer?.firstName || ''} ${body.customer?.lastName || ''}`.trim() ||
    body.ownerName ||
    'Sayın Misafirimiz';

  const menuDetailsText = isEmptyHall
    ? 'Boş Salon Kiralama (Menü Hariç)'
    : effectiveMenus
        .map((m) => {
          const removed = Array.isArray(m.removedItems) && m.removedItems.length > 0
            ? ` (Çıkarılanlar: ${m.removedItems.map((x) => x.name).join(', ')})`
            : '';
          return `${m.name}${removed}`;
        })
        .join(', ') || 'Standart Kiralama';

  const wpText =
    `*ÜSK-AI | T.C. ÜSKÜDAR BELEDİYESİ ORGANİZASYON & REZERVASYON BİLDİRİMİ*\n\n` +
    `Sayın *${customerName}*,\n` +
    `*${facility.name}* için organizasyon ve rezervasyon başvurunuz alınarak *Onay Paneline* iletilmiştir:\n\n` +
    `*Başvuru Takip Kodu:* ${code}\n` +
    `*Tarih & Saat:* ${body.date || '30.11.2026'} | ${body.startTime || '09:00'} - ${body.endTime || '12:00'}\n` +
    `*Organizasyon Amacı:* ${body.purpose || 'Kahvaltı'} (${body.tableLayout || 'Masalı Düzen'})\n` +
    `*Kontenjan / Kişi Sayısı:* ${pricing.guestCount} Kişi\n` +
    `*Seçilen Menü:* ${menuDetailsText}\n` +
    `*Kontenjan Kuralı:* ${
      isEmptyHall
        ? `Boş Salon Kiralama (Mekan Ücreti: ₺${pricing.hallFeeApplied.toLocaleString('tr-TR')})`
        : pricing.extraGuestsAbove500 > 0
        ? `500 Kontenjan + ${pricing.extraGuestsAbove500} Ekstra Kişi (Mekan Ücreti ₺0 | +${pricing.extraGuestsAbove500} Ekstra Kişi Farkı: ₺${pricing.extraGuestSubtotal.toLocaleString('tr-TR')})`
        : pricing.hallFeeWaived
        ? `${pricing.guestCount} Kontenjan Avantajı Uygulandı (350-500 Standart Kontenjan / Mekan Ücreti ₺0)`
        : `350 Altı Kuralı (Kahvaltı/Yemek + ₺${pricing.hallFeeApplied.toLocaleString('tr-TR')} Mekan Parası)`
    }\n` +
    `*Hesaplanan Tutar:* ₺${pricing.grandTotal.toLocaleString('tr-TR', { minimumFractionDigits: 2 })}\n` +
    `*İletişim Tel:* ${body.customer?.phone || '-'}\n\n` +
    `Başvurunuz Üsküdar Belediyesi Onay Paneli tarafından incelendikten sonra onay mesajınız yine *ÜSK-AI* üzerinden tarafınıza iletilecektir.`;

  // Canlı WhatsApp Bot üzerinden doğrudan başvuru yapan müşterinin numarasına gerçek mesaj gönder (+ yöneticiye bilgi düş)
  const customerPhoneRaw = String(body.customer?.phone || '').trim();
  const adminAlertText =
    `📥 *YENİ ORGANİZASYON BAŞVURUSU GELDİ (${code})*\n\n` +
    `*Başvuru Sahibi:* ${customerName}\n` +
    `*Müşteri Tel:* ${customerPhoneRaw || '-'}\n` +
    `*Tesis:* ${facility.name}\n` +
    `*Tarih & Saat:* ${body.date || '30.11.2026'} | ${body.startTime || '09:00'} - ${body.endTime || '12:00'}\n` +
    `*Kişi & Amaç:* ${pricing.guestCount} Kişi — ${body.purpose || 'Kahvaltı'}\n` +
    `*Toplam Tutar:* ₺${pricing.grandTotal.toLocaleString('tr-TR', { minimumFractionDigits: 2 })}\n\n` +
    `👉 Onaylamak için: /yonetim`;

  const deliveredLive = await dispatchRealWhatsAppMessage(
    customerPhoneRaw,
    wpText,
    `ÜSK-AI Yeni Rezervasyon (${code})`,
    {
      alsoNotifyOwner: true,
      ownerText: adminAlertText,
    }
  );

  const record = {
    id: code,
    date: body.date || '30.11.2026',
    startTime: body.startTime || '09:00',
    endTime: body.endTime || '12:00',
    facilityId: facility.id,
    facilityName: facility.name,
    ownerName: body.ownerName || customerName,
    purpose: body.purpose || 'Kahvaltı',
    tableLayout: body.tableLayout || 'Masalı Düzen',
    rentalType: body.rentalType || 'Dolu Kiralama',
    guestCount: pricing.guestCount,
    selectedEvents: body.selectedEvents || [],
    selectedMenus: effectiveMenus,
    selectedOptionals: body.selectedOptionals || [],
    pricing,
    customer: body.customer || {},
    invoice: body.invoice || {},
    status: 'Onay Bekliyor',
    whatsappStatus: deliveredLive ? 'ÜSK-AI Gerçek WhatsApp Mesajı Gönderdi' : 'ÜSK-AI Kaydedildi',
    whatsappDeliveredLive: deliveredLive,
    whatsappLastMessage: wpText,
    reminderCount: 0,
    lastReminderAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    auditLog: [],
  };

  appendAuditLog(record, {
    actor: 'citizen',
    type: 'reservation_created',
    summary: `Başvuru oluşturuldu (${facility.name}, ${pricing.guestCount} Kişi, ₺${pricing.grandTotal.toLocaleString('tr-TR', { minimumFractionDigits: 2 })}).`,
  });

  db.reservations.unshift(record);
  saveDb(db);

  res.json({ ok: true, reservation: record, whatsappDeliveredLive: deliveredLive });
});

// ÜSK-AI: CEVAPLANMAYAN ("Onay Bekliyor") RANDEVULAR İÇİN HER 1 SAATTE BİR OTOMATİK HATIRLATMA MOTORU
async function sendUnansweredReminderForReservation(item, db, isManualTest = false) {
  const customerName =
    `${item.customer?.firstName || ''} ${item.customer?.lastName || ''}`.trim() || item.ownerName || 'Misafir';
  const nextCount = (Number(item.reminderCount) || 0) + 1;
  const elapsedHours = Math.max(
    1,
    Math.round((Date.now() - new Date(item.createdAt || Date.now()).getTime()) / (1000 * 60 * 60))
  );

  const reminderText =
    `*⏰ ÜSK-AI | CEVAPLANMAYAN RANDEVU HATIRLATMASI (${nextCount}. Hatırlatma)*\n\n` +
    `Dikkat! Aşağıdaki organizasyon randevu başvurusu *${elapsedHours} saattir ONAY BEKLİYOR* ve henüz cevaplanmadı:\n\n` +
    `*Başvuru Kodu:* ${item.id}\n` +
    `*Randevu Yapan:* ${customerName} (${item.customer?.phone || '-'})\n` +
    `*Tesis / Mekan:* ${item.facilityName}\n` +
    `*Tarih & Saat:* ${item.date} | ${item.startTime} - ${item.endTime}\n` +
    `*Amaç & Kişi:* ${item.purpose} — *${item.guestCount} Kişi*\n` +
    `*Hesaplanan Tutar:* ₺${(item.pricing?.grandTotal || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2 })}\n\n` +
    `👉 Lütfen *Onay Paneli (/yonetim)* üzerinden başvuruyu *Onayla*, *Revize İste* veya *İptal Et* olarak cevaplayınız. (Cevaplanana kadar her 1 saatte bir hatırlatılacaktır).`;

  const delivered = await dispatchRealWhatsAppMessage(
    db.settings?.adminWhatsappPhone || '905525222988',
    reminderText,
    `ÜSK-AI Saatlik Hatırlatma (${item.id} - Cevaplanmadı)`
  );

  item.reminderCount = nextCount;
  item.lastReminderAt = new Date().toISOString();
  item.lastReminderMessage = reminderText;
  item.whatsappStatus = `ÜSK-AI ${nextCount}. Saatlik Hatırlatma Gönderildi`;
  appendAuditLog(item, {
    actor: isManualTest ? 'admin' : 'system',
    type: 'reminder_sent',
    summary: `${nextCount}. hatırlatma gönderildi (${isManualTest ? 'Manuel Yönetim Tetiklemesi' : 'Saatlik Otomatik Motor'}).`,
  });
  saveDb(db);
  return { delivered, reminderCount: nextCount, reminderText };
}

async function checkAndSendHourlyUnansweredReminders(forceAllPending = false) {
  const db = loadDb();
  if (!forceAllPending && db.settings?.hourlyReminderEnabled === false) {
    return { sentCount: 0, results: [] };
  }
  const intervalMs = (Number(db.settings?.reminderIntervalMinutes) || 60) * 60 * 1000;
  const now = Date.now();
  const pendingList = (db.reservations || []).filter((r) => r.status === 'Onay Bekliyor');
  const results = [];

  for (const item of pendingList) {
    const lastTs = new Date(item.lastReminderAt || item.createdAt || 0).getTime();
    if (forceAllPending || now - lastTs >= intervalMs) {
      const res = await sendUnansweredReminderForReservation(item, db, forceAllPending);
      results.push({ id: item.id, ...res });
    }
  }
  return { sentCount: results.length, pendingCount: pendingList.length, results };
}

// Her 1 dakikada bir kontrol eder, son bildirimden 1 saat (60 dk) geçmiş ve hâlâ "Onay Bekliyor" olanları hatırlatır
setInterval(() => {
  checkAndSendHourlyUnansweredReminders(false).catch((err) =>
    console.warn('ÜSK-AI saatlik hatırlatma kontrol hatası:', err.message)
  );
}, 60 * 1000);

// Yönetim panelinden manuel "Şimdi Hatırlatma Gönder" veya tekil randevu hatırlatma tetikleyicisi
app.post('/api/reminders/trigger', async (req, res) => {
  const { reservationId } = req.body || {};
  const db = loadDb();
  if (reservationId) {
    const item = db.reservations.find((r) => r.id === reservationId);
    if (!item) return res.status(404).json({ ok: false, error: 'Randevu bulunamadı' });
    if (item.status !== 'Onay Bekliyor') {
      return res.json({ ok: false, error: 'Bu randevu zaten cevaplanmış, hatırlatma gönderilmez.' });
    }
    const result = await sendUnansweredReminderForReservation(item, db, true);
    return res.json({ ok: true, sentCount: 1, result });
  }
  const summary = await checkAndSendHourlyUnansweredReminders(true);
  res.json({ ok: true, ...summary });
});

// ÜSK-AI Vatandaş & Yönetim Akıllı Soru-Cevap Motoru (Vatandaş ekranında yönetimle ilgili hiçbir bilgi vermez, sorulan her soruyu doğal ve doğru cevaplar)
app.post('/api/usku-ai/ask', async (req, res) => {
  const { question, role = 'citizen' } = req.body || {};
  const rawQ = String(question || '').trim();
  const q = rawQ.toLocaleLowerCase('tr-TR');
  const qNorm = normalizeTR(rawQ);
  const db = loadDb();
  const isAdmin = role === 'admin';

  // Eğer Yönetim Panelinden (/yonetim) soruluyorsa bekleyen randevu bilgisini verebilir
  if (isAdmin && (qNorm.includes('hatirlat') || qNorm.includes('bildirim') || qNorm.includes('cevaplanmayan') || qNorm.includes('bekleyen'))) {
    const pending = db.reservations.filter((r) => r.status === 'Onay Bekliyor');
    if (pending.length === 0) {
      return res.json({
        ok: true,
        reply: 'Şu anda cevaplanmamış (Onay Bekleyen) hiçbir randevu bulunmuyor. Tüm başvurular cevaplanmış durumda.',
      });
    }
    const names = pending.map((p) => `${p.id} (${p.ownerName} - ${p.facilityName}, ${p.guestCount} Kişi)`).join(', ');
    return res.json({
      ok: true,
      reply: `Şu anda cevaplanmamış ${pending.length} adet randevu var: ${names}. Saatlik Hatırlatma Motoru aktif; siz onaylayana veya iptal edene kadar her 1 saatte bir WhatsApp bildirimi gönderir.`,
    });
  }

  if (
    isAdmin &&
    (qNorm.includes('sikayet') ||
      qNorm.includes('geri bildirim') ||
      qNorm.includes('csat') ||
      qNorm.includes('memnuniyet') ||
      qNorm.includes('sla'))
  ) {
    const pendingCount = (db.reservations || []).filter((r) => r.status === 'Onay Bekliyor').length;
    const allComplaints = Array.isArray(db.complaints) ? db.complaints : [];
    const activeComplaints = allComplaints.filter((c) => c.status === 'Açık' || c.status === 'İşlemde');
    const rated = allComplaints.filter((c) => Number.isInteger(c.rating) && c.rating >= 1 && c.rating <= 5);
    const avgCsat =
      rated.length > 0 ? (rated.reduce((sum, c) => sum + c.rating, 0) / rated.length).toFixed(2) : 'Henüz puan yok';
    return res.json({
      ok: true,
      reply:
        `📊 Yönetim SLA & Vatandaş Geri Bildirim Özeti:\n` +
        `• Cevaplanmayan Başvuru: ${pendingCount} adet (SLA trafik ışığı >4 saat veya 3+ hatırlatmada 🔴 kırmızıya döner).\n` +
        `• Açık / İşlemdeki Şikayet & Talepler: ${activeComplaints.length} adet (Toplam: ${allComplaints.length}).\n` +
        `• Ortalama Memnuniyet (CSAT): ${rated.length > 0 ? `★ ${avgCsat}/5 (${rated.length} değerlendirme)` : avgCsat}.`,
    });
  }

  // VATANDAŞ EKRANINDA YÖNETİM / YÖNETİCİ / ADMİN / HATIRLATMA / DÜZENLEME SORULARINA KESİN ENGEL
  if (
    !isAdmin &&
    (qNorm.includes('yonetim') ||
      qNorm.includes('/yonetim') ||
      qNorm.includes('yonetici') ||
      qNorm.includes('/yonetici') ||
      q.includes('yönetim') ||
      q.includes('yönetici') ||
      qNorm.includes('admin') ||
      qNorm.includes('panel') ||
      qNorm.includes('yetkili') ||
      qNorm.includes('giris') ||
      qNorm.includes('dashboard') ||
      qNorm.includes('moderator') ||
      qNorm.includes('randevu onayla') ||
      qNorm.includes('basvuru onayla') ||
      qNorm.includes('onaylama') ||
      qNorm.includes('onay yetki') ||
      qNorm.includes('hatirlat'))
  ) {
    return res.json({
      ok: true,
      reply:
        'Ben yalnızca vatandaşlarımıza tesislerimiz, adreslerimiz, menülerimiz ve organizasyon başvuru adımları hakkında bilgi veren ÜSK-AI danışmanıyım. Size hangi tesisimiz veya menümüz hakkında yardımcı olabilirim?',
    });
  }

  let reply = '';

  // 1. TESİS ADRESLERİ VE KONUMLARI ("bağlarbaşın yeri nerde", "sahil nerede", "boğaziçi nerde" vb.)
  if (qNorm.includes('baglarbasi')) {
    reply =
      '📍 Üsküdar Nevmekan Bağlarbaşı Konumu ve Bilgileri:\n' +
      '• Adres: Selamiali Mah. Gazi Cad. No:22, Bağlarbaşı / Üsküdar (Bağlarbaşı Kültür Merkezi yanı, Bağlarbaşı Metro durağına 2 dakika yürüme mesafesindedir).\n' +
      '• Kapasite & Kontenjan: 350 ve 500 kişilik standart kontenjan (350 altı Mekan + Kahvaltı, 500 üzeri ekstra kişi).\n' +
      '• İletişim: 444 0 875';
  } else if (qNorm.includes('sahil') || qNorm.includes('nevmekan sahil')) {
    reply =
      '📍 Üsküdar Nevmekan Sahil Konumu ve Bilgileri:\n' +
      '• Adres: Şemsipaşa Mah. Sahil Yolu No:2, Üsküdar Meydan / İstanbul (Üsküdar sahilinde, Kız Kulesi ve Boğaz manzaralı tarihi kubbeli sosyal tesisimizdir).\n' +
      '• Kapasite & Kontenjan: 350 ve 500 kişilik davet & organizasyon salonu.\n' +
      '• İletişim: 444 0 875';
  } else if (qNorm.includes('selimiye')) {
    reply =
      '📍 Üsküdar Nevmekan Selimiye Konumu ve Bilgileri:\n' +
      '• Adres: Selimiye Mah. Şerif Kuyusu Sok. No:17, Üsküdar / İstanbul (Tarihi Selimiye Hamamı binasında hizmet vermektedir).\n' +
      '• Kapasite & Kontenjan: 350 ve 500 kişilik organizasyon alanı.\n' +
      '• İletişim: 444 0 875';
  } else if (qNorm.includes('bogazici')) {
    reply =
      '📍 Boğaziçi Yaşam Merkezi Konumu ve Bilgileri:\n' +
      '• Adres: Kirazlıtepe Mah. Mehmet Akif Ersoy Cad. No:65, Üsküdar / İstanbul (Çamlıca - Kirazlıtepe bölgesinde, panoramik Boğaz manzaralı tesisimizdir).\n' +
      '• Kapasite & Kontenjan: 350 ve 500 kişilik düğün, kahvaltı ve davet salonu.\n' +
      '• İletişim: 444 0 875';
  } else if (qNorm.includes('valide sultan') || qNorm.includes('gemi')) {
    reply =
      '🚢 Valide Sultan Gemisi Konumu ve Bilgileri:\n' +
      '• Kalkış Noktası: Üsküdar Meydan İskelesi (Paşalimanı / Şemsipaşa Sahili).\n' +
      '• Hizmet: Boğaz turu eşliğinde düğün, nikah, kahvaltı ve kurumsal yemek organizasyonları (350 ve 500 kontenjan).';
  } else if (qNorm.includes('camlica')) {
    reply =
      '📍 Çamlıca Sosyal Tesisleri Konumu ve Bilgileri:\n' +
      '• Adres: Kısıklı Mah. Büyük Çamlıca Tepesi Yolu, Üsküdar / İstanbul.\n' +
      '• Hizmet: Kahvaltı, yemek ve grup organizasyonları (350 ve 500 kontenjan).';
  } else if (
    qNorm.includes('nerde') ||
    qNorm.includes('nerede') ||
    qNorm.includes('adres') ||
    qNorm.includes('konum') ||
    qNorm.includes('yol tarifi') ||
    qNorm.includes('nasil gidilir') ||
    qNorm.includes('mekan') ||
    qNorm.includes('tesis') ||
    qNorm.includes('nevmekan') ||
    qNorm.includes('salon')
  ) {
    reply =
      '📍 T.C. Üsküdar Belediyesi Organizasyon Tesislerimiz ve Adresleri:\n' +
      '1. Nevmekan Sahil: Şemsipaşa Mah. Sahil Yolu No:2 (Üsküdar Meydan Sahili)\n' +
      '2. Nevmekan Bağlarbaşı: Selamiali Mah. Gazi Cad. No:22 (Bağlarbaşı Metro yanı)\n' +
      '3. Nevmekan Selimiye: Selimiye Mah. Şerif Kuyusu Sok. No:17 (Tarihi Selimiye Hamamı)\n' +
      '4. Boğaziçi Yaşam Merkezi: Kirazlıtepe Mah. Mehmet Akif Ersoy Cad. No:65\n' +
      '5. Valide Sultan Gemisi: Üsküdar Meydan İskelesi\n' +
      '6. Çamlıca Sosyal Tesisleri: Büyük Çamlıca Tepesi, Kısıklı\n\n' +
      'Merak ettiğiniz tesisin adını yazarsanız (örneğin "Bağlarbaşı nerede?") detaylı adresini hemen paylaşabilirim.';
  } else if (
    qNorm.includes('350') ||
    qNorm.includes('500') ||
    qNorm.includes('kontenjan') ||
    qNorm.includes('fiyat') ||
    qNorm.includes('ucret') ||
    qNorm.includes('kac para') ||
    qNorm.includes('ne kadar') ||
    qNorm.includes('hesap') ||
    qNorm.includes('maliyet')
  ) {
    reply =
      '📊 Üsküdar Belediyesi 350 & 500 Kontenjan ve Fiyatlandırma Kuralı:\n' +
      '• 350 ile 500 Kişi Arası (Standart Kontenjan): Mekan parası alınmaz (₺0), yalnızca seçtiğiniz Kahvaltı veya Yemek menüsünün kişi başı ücreti ödenir.\n' +
      '• 350 Kişiden Az Olanlarda (<350 Kişi): Mekan Parası (+₺20.000) + Kahvaltı / Yemek Parası birlikte ödenir.\n' +
      '• 500 Kişiden Sonrası (500+ Kişi): 500 kişi üzerindeki her davetli ekstra kişi olarak hesaplanır.\n' +
      '• Güncel Menü Fiyatlarımız: Kahvaltı Tabağı-1 (517,50 TL), Kırmızı Et Menü-2 (675 TL), Kırmızı Et Menü-1 (825 TL), Özel Davet (1.150 TL), Ramazan Sahil Menü (2.300 TL).';
  } else if (
    qNorm.includes('menu') ||
    qNorm.includes('kahvalti') ||
    qNorm.includes('yemek') ||
    qNorm.includes('cikar') ||
    qNorm.includes('icinde ne var') ||
    qNorm.includes('peynir')
  ) {
    reply =
      '🍽️ Menülerimiz ve Alt Ürün Çıkarma Özelliği:\n' +
      '• Kahvaltı Tabağı-1 (517,50 TL): Beyaz Peynir, Taze Kaşar, Çeçil Peynir, Paket Reçel, Süzme Bal, Tereyağ, Siyah/Yeşil Zeytin, Haşlanmış Yumurta, Cherry Domates, Salatalık, Simit, Su ve Sınırsız Çay (14 Kalem).\n' +
      '• Ürün Çıkarma: Menüyü seçtiğinizde alt sütunlardaki ürünlerin yanında bulunan [Çıkar] butonuna basarak istemediğiniz ürünlerin üstünü çizebilirsiniz. Çıkardığınız ürünler menüden gizlenir, fiyat sabit kalır.';
  } else if (
    qNorm.includes('saat') ||
    qNorm.includes('musait') ||
    qNorm.includes('tarih') ||
    qNorm.includes('bos') ||
    qNorm.includes('kontrol')
  ) {
    reply =
      '🕒 Tarih ve Saat Müsaitliği:\n' +
      'Formun en üstündeki "Rezervasyon Bilgileri" bölümünden istediğiniz tarihi, başlangıç-bitiş saatini ve tesisi seçip [Kontrol Et] butonuna basarak salonun o saatte müsait olup olmadığını anında görebilirsiniz.';
  } else if (
    qNorm.includes('iletisim') ||
    qNorm.includes('telefon') ||
    qNorm.includes('numara') ||
    qNorm.includes('whatsapp') ||
    qNorm.includes('nasil basvur')
  ) {
    reply =
      '📞 Başvuru ve İletişim:\n' +
      'Sayfadaki formu doldurup en alttaki [Rezervasyonu Kaydet ve WhatsApp Bildirimi Gönder] butonuna bastığınızda başvurunuz kayda alınır ve cep telefonunuza anında WhatsApp başvuru takip mesajınız iletilir. Çağrı merkezimiz: 444 0 875.';
  } else if (
    !isAdmin &&
    (qNorm.includes('sikayet') ||
      qNorm.includes('geri bildirim') ||
      qNorm.includes('takip') ||
      qNorm.includes('memnuniyet') ||
      qNorm.includes('onaylandi') ||
      qNorm.includes('basvurum') ||
      qNorm.includes('basvuru durum'))
  ) {
    reply =
      '🔍 Başvuru Takip, Şikayet & Memnuniyet Bildirimi:\n' +
      'Sayfanın altındaki "Başvuru Takip, Şikayet / Talep & Memnuniyet (CSAT)" bölümünden USK-2026-XXXX takip kodunuzla başvurunuzun güncel durumunu sorgulayabilir, kategori seçerek şikayet/öneri iletebilir veya 1–5 yıldız memnuniyet puanı verebilirsiniz. Çağrı merkezimiz: 444 0 875.';
  } else if (qNorm.includes('merhaba') || qNorm.includes('selam') || qNorm.includes('iyi gunler') || qNorm.includes('nasilsin')) {
    reply =
      'Merhaba! Hoş geldiniz. Ben ÜSK-AI, T.C. Üsküdar Belediyesi Dijital Rezervasyon Danışmanıyım. Size tesislerimizin adresleri (Nevmekan Sahil, Bağlarbaşı, Selimiye, Boğaziçi Yaşam Merkezi), 350 & 500 kontenjan fiyatlarımız veya menü içeriklerimiz hakkında nasıl yardımcı olabilirim?';
  } else {
    reply =
      `"${rawQ}" sorunuz için yardımcı olayım:\n` +
      '• Tesis Adresleri: Nevmekan Sahil (Üsküdar Meydan), Nevmekan Bağlarbaşı (Gazi Cad. No:22, Metro yanı), Nevmekan Selimiye (Tarihi Hamam), Boğaziçi Yaşam Merkezi (Kirazlıtepe).\n' +
      '• Kontenjan Kuralı: 350 ve 500 kişilik kontenjanda mekan ücreti alınmaz; 350 kişiden az olanlarda Mekan (₺20.000) + Kahvaltı/Yemek ödenir, 500 kişi sonrası ekstraya girer.\n' +
      '• İletişim: 444 0 875. Başka bir tesis adresini veya menü fiyatını sormak ister misiniz?';
  }

  res.json({
    ok: true,
    reply,
  });
});

app.post('/api/reservations/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, adminNote } = req.body || {};
  const db = loadDb();
  const item = db.reservations.find((r) => r.id === id);
  if (!item) return res.status(404).json({ ok: false, error: 'Rezervasyon bulunamadı' });

  const prevStatus = item.status;
  item.status = status || item.status;
  if (adminNote !== undefined) item.adminNote = String(adminNote).trim();
  item.updatedAt = new Date().toISOString();

  const trimmedNote = adminNote !== undefined ? String(adminNote).trim() : '';
  const customerName =
    `${item.customer?.firstName || ''} ${item.customer?.lastName || ''}`.trim() || item.ownerName;
  const statusUpper = String(item.status || '').toLocaleUpperCase('tr-TR');
  const statusIcon =
    item.status === 'Onaylandı'
      ? '✅'
      : item.status === 'İptal Edildi'
        ? '❌'
        : item.status === 'Revize İstendi'
          ? '🔄'
          : '📌';
  const statusDetailLine =
    item.status === 'Onaylandı'
      ? `\n\n🎉 Rezervasyonunuz *Üsküdar Belediyesi Onay Paneli* tarafından onaylanmıştır. Organizasyon gününde tesisimizde görüşmek dileğiyle!`
      : item.status === 'Revize İstendi'
        ? `\n\nℹ️ Başvurunuzla ilgili düzenleme / revize talebi bulunmaktadır. Detaylar için çağrı merkezimizle (444 0 875) iletişime geçebilirsiniz.`
        : item.status === 'İptal Edildi'
          ? `\n\nℹ️ Başvurunuz iptal durumuna alınmıştır. Sorularınız için 444 0 875 numaralı hattımızdan bize ulaşabilirsiniz.`
          : '';

  const wpText =
    `*${statusIcon} ÜSK-AI | T.C. ÜSKÜDAR BELEDİYESİ REZERVASYON DURUM BİLDİRİMİ*\n\n` +
    `Sayın *${customerName}*,\n` +
    `*${item.id}* takip kodlu organizasyon başvurunuzun durumu *${statusUpper}* olarak güncellenmiştir:\n\n` +
    `*Tesis:* ${item.facilityName}\n` +
    `*Tarih & Saat:* ${item.date} | ${item.startTime} - ${item.endTime}\n` +
    `*Organizasyon & Kişi:* ${item.purpose} (${item.guestCount} Kişi)\n` +
    `*Toplam Tutar:* ₺${Number(item.pricing?.grandTotal || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2 })}` +
    (trimmedNote ? `\n\n*Yetkili Notu:* ${trimmedNote}` : '') +
    statusDetailLine;

  const dedupKey = `${item.id}|${item.status}|${trimmedNote}`;
  const lastSentTs = recentStatusDispatchCache.get(dedupKey) || 0;
  let deliveredLive = Boolean(item.whatsappDeliveredLive);
  if (Date.now() - lastSentTs > 3500) {
    recentStatusDispatchCache.set(dedupKey, Date.now());
    deliveredLive = await dispatchRealWhatsAppMessage(
      item.customer?.phone || '',
      wpText,
      `ÜSK-AI Durum Güncellemesi (${item.id}: ${item.status})`
    );
  }

  item.whatsappStatus = deliveredLive
    ? `ÜSK-AI Müşteriye WhatsApp Gönderdi (${item.status})`
    : `ÜSK-AI Durum Kaydedildi (${item.status})`;
  item.whatsappDeliveredLive = deliveredLive;
  item.whatsappLastMessage = wpText;

  appendAuditLog(item, {
    actor: 'admin',
    type: 'status_updated',
    summary: `Durum "${prevStatus}" → "${item.status}" olarak güncellendi.${item.adminNote ? ` Yetkili Notu: ${item.adminNote}` : ''}`,
  });

  saveDb(db);
  res.json({ ok: true, reservation: item, whatsappDeliveredLive: deliveredLive });
});

// F11: VATANDAŞ TAKİP, ŞİKAYET / GERİ BİLDİRİM & CSAT UÇ NOKTALARI
app.get('/api/reservations/track/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ ok: false, error: 'Takip kodu gereklidir.' });
  }
  const db = loadDb();
  const item = (db.reservations || []).find((r) => String(r.id || '').toUpperCase() === code);
  if (!item) {
    return res.status(404).json({ ok: false, error: 'Bu takip koduna ait başvuru bulunamadı.' });
  }

  const linkedComplaints = (db.complaints || [])
    .filter((c) => c.reservationId === item.id || String(c.trackingCode || '').toUpperCase() === code)
    .map((c) => ({
      id: c.id,
      category: c.category,
      status: c.status,
      rating: c.rating ?? null,
      message: c.message,
      resolutionNote: c.resolutionNote || '',
      createdAt: c.createdAt,
      resolvedAt: c.resolvedAt || null,
    }));

  const fullName =
    `${item.customer?.firstName || ''} ${item.customer?.lastName || ''}`.trim() || item.ownerName || '';
  const csatEligible =
    item.status !== 'Onay Bekliyor' ||
    linkedComplaints.some((c) => c.status === 'Çözüldü' || c.status === 'Kapandı');
  const hasCsatRating = linkedComplaints.some((c) => Number.isInteger(c.rating));

  return res.json({
    ok: true,
    reservation: {
      id: item.id,
      status: item.status,
      facilityId: item.facilityId,
      facilityName: item.facilityName,
      date: item.date,
      startTime: item.startTime,
      endTime: item.endTime,
      purpose: item.purpose,
      tableLayout: item.tableLayout,
      guestCount: item.guestCount,
      maskedOwnerName: maskCustomerName(fullName),
      adminNote: item.adminNote || '',
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || item.createdAt || null,
      pricingSummary: item.pricing
        ? {
            guestCount: item.pricing.guestCount,
            hallFeeWaived: Boolean(item.pricing.hallFeeWaived),
            grandTotal: Number(item.pricing.grandTotal) || 0,
          }
        : null,
    },
    csatEligible,
    hasCsatRating,
    complaints: linkedComplaints,
  });
});

app.get('/api/feedback', (req, res) => {
  const db = loadDb();
  const allComplaints = Array.isArray(db.complaints) ? db.complaints : [];
  const statusFilter = req.query.status ? String(req.query.status).trim() : '';
  const categoryFilter = req.query.category ? String(req.query.category).trim() : '';

  const openCount = allComplaints.filter((c) => c.status === 'Açık').length;
  const inProgressCount = allComplaints.filter((c) => c.status === 'İşlemde').length;
  const resolvedCount = allComplaints.filter((c) => c.status === 'Çözüldü' || c.status === 'Kapandı').length;
  const rated = allComplaints.filter((c) => Number.isInteger(c.rating) && c.rating >= 1 && c.rating <= 5);
  const totalRatings = rated.length;
  const averageRating =
    totalRatings > 0 ? Number((rated.reduce((s, c) => s + c.rating, 0) / totalRatings).toFixed(2)) : 0;

  const byCategory = {
    'Fiyat/Kontenjan': 0,
    'Tesis/Hizmet': 0,
    'Tarih Çakışması': 0,
    'İletişim/Diğer': 0,
  };
  for (const c of allComplaints) {
    const key = FEEDBACK_CATEGORIES.includes(c.category) ? c.category : 'İletişim/Diğer';
    byCategory[key] += 1;
  }

  let filtered = allComplaints;
  if (statusFilter) {
    filtered = filtered.filter((c) => c.status === statusFilter);
  }
  if (categoryFilter) {
    filtered = filtered.filter((c) => c.category === categoryFilter);
  }

  const orderRank = { Açık: 0, İşlemde: 1, Çözüldü: 2, Kapandı: 3 };
  const sorted = [...filtered].sort((a, b) => {
    const rankDiff = (orderRank[a.status] ?? 9) - (orderRank[b.status] ?? 9);
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });

  const metrics = {
    totalCount: allComplaints.length,
    openCount,
    inProgressCount,
    resolvedCount,
    averageRating,
    totalRatings,
    byCategory,
  };

  return res.json({
    ok: true,
    complaints: sorted,
    metrics,
    stats: metrics,
    averageRating,
    totalRatings,
    openCount,
    inProgressCount,
    resolvedCount,
    byCategory,
  });
});

app.post('/api/feedback', (req, res) => {
  const body = req.body || {};
  const customerName = String(body.customerName || '').trim();
  const message = String(body.message || '').trim();
  const phone = String(body.phone || '').trim().slice(0, 30);
  const rawCode = String(body.trackingCode || '').trim().toUpperCase();

  if (!customerName) {
    return res.status(400).json({ ok: false, error: 'Ad Soyad alanı zorunludur.' });
  }
  if (!message) {
    return res.status(400).json({ ok: false, error: 'Şikayet / geri bildirim mesajı zorunludur.' });
  }
  if (rawCode && !/^[A-Z0-9-]{3,32}$/.test(rawCode)) {
    return res.status(400).json({ ok: false, error: 'Geçersiz takip kodu formatı.' });
  }

  let rating = null;
  if (body.rating !== undefined && body.rating !== null && body.rating !== '') {
    if (typeof body.rating === 'boolean' || (typeof body.rating !== 'number' && typeof body.rating !== 'string')) {
      return res.status(400).json({ ok: false, error: 'Değerlendirme puanı 1 ile 5 arasında tam sayı olmalıdır.' });
    }
    const num = Number(body.rating);
    if (!Number.isInteger(num) || num < 1 || num > 5) {
      return res.status(400).json({ ok: false, error: 'Değerlendirme puanı 1 ile 5 arasında tam sayı olmalıdır.' });
    }
    rating = num;
  }

  const db = loadDb();
  const category = normalizeFeedbackCategory(body.category);
  const matched = rawCode
    ? (db.reservations || []).find((r) => String(r.id || '').toUpperCase() === rawCode)
    : null;

  const nowIso = new Date().toISOString();
  const complaint = {
    id: generateUniqueCode('SHK', db.complaints),
    trackingCode: matched ? matched.id : rawCode || null,
    reservationId: matched ? matched.id : null,
    customerName: customerName.slice(0, 120),
    phone,
    category,
    rating,
    message: message.slice(0, 2000),
    status: 'Açık',
    resolutionNote: '',
    createdAt: nowIso,
    updatedAt: nowIso,
    resolvedAt: null,
    auditLog: [],
  };

  appendAuditLog(complaint, {
    actor: 'citizen',
    type: 'feedback_created',
    summary: `Geri bildirim oluşturuldu (Kategori: ${category}${rating ? `, Puan: ${rating}/5` : ''}).`,
  });

  if (matched) {
    appendAuditLog(matched, {
      actor: 'citizen',
      type: 'feedback_linked',
      summary: `${complaint.id} kodlu geri bildirim bağlandı (${category}${rating ? `, ★${rating}/5` : ''}).`,
    });
  }

  db.complaints.unshift(complaint);
  saveDb(db);

  return res.status(201).json({
    ok: true,
    complaint,
    linkedReservationId: matched ? matched.id : null,
  });
});

app.post('/api/feedback/:id/resolve', (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const db = loadDb();
  const complaint = (db.complaints || []).find((c) => c.id === id);
  if (!complaint) {
    return res.status(404).json({ ok: false, error: 'Şikayet / geri bildirim kaydı bulunamadı.' });
  }

  const nextStatus = body.status !== undefined ? String(body.status).trim() : 'Çözüldü';
  if (!FEEDBACK_STATUSES.includes(nextStatus)) {
    return res.status(400).json({
      ok: false,
      error: 'Geçersiz durum. İzin verilen değerler: Açık, İşlemde, Çözüldü, Kapandı.',
    });
  }

  const note =
    body.resolutionNote !== undefined
      ? String(body.resolutionNote).trim()
      : String(complaint.resolutionNote || '').trim();
  if ((nextStatus === 'Çözüldü' || nextStatus === 'Kapandı') && !note) {
    return res.status(400).json({
      ok: false,
      error: 'Çözüldü veya Kapandı durumuna geçişte çözüm notu (resolutionNote) zorunludur.',
    });
  }

  const prevStatus = complaint.status;
  const nowIso = new Date().toISOString();
  complaint.status = nextStatus;
  complaint.resolutionNote = note.slice(0, 2000);
  complaint.updatedAt = nowIso;
  complaint.resolvedAt =
    nextStatus === 'Çözüldü' || nextStatus === 'Kapandı' ? complaint.resolvedAt || nowIso : null;

  appendAuditLog(complaint, {
    actor: 'admin',
    type: 'feedback_status_updated',
    summary: `Durum "${prevStatus}" → "${nextStatus}" olarak güncellendi.${complaint.resolutionNote ? ` Çözüm Notu: ${complaint.resolutionNote}` : ''}`,
  });

  if (complaint.reservationId) {
    const linkedRes = (db.reservations || []).find((r) => r.id === complaint.reservationId);
    if (linkedRes) {
      appendAuditLog(linkedRes, {
        actor: 'admin',
        type: 'linked_feedback_updated',
        summary: `${complaint.id} geri bildirimi "${nextStatus}" durumuna alındı.${complaint.resolutionNote ? ` Not: ${complaint.resolutionNote}` : ''}`,
      });
    }
  }

  saveDb(db);
  return res.json({ ok: true, complaint });
});

app.listen(PORT, () => {
  console.log(`T.C. Üsküdar Belediyesi (ÜSK-AI) Organizasyon & Rezervasyon Sistemi aktif: http://localhost:${PORT}`);
});
